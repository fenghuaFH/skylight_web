import { useEffect, useRef, useState } from "react";
import type { Aircraft, Config, ARPointOpts } from "@shared/index.js";
import { DEFAULT_CONFIG, ASTERISMS, llToMeters, deadReckon, projectAR, projectARCelestial, skyGlyphScale } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { serverHttp } from "../lib/connection.js";
import { drawAircraftGlyph, classifyGlyph } from "../display/aircraftGlyph.js";
import { computeSky } from "../display/celestial.js";
import "../styles/ar.css";

// Helper to normalize aircraft data from the public airplanes.live/readsb JSON format
function normalizeRawAircraft(raw: any, ts: number): Aircraft {
  const onGround = raw.alt_baro === "ground";
  return {
    hex: raw.hex || String(Math.random()),
    flight: raw.flight?.trim() || undefined,
    lat: raw.lat,
    lon: raw.lon,
    altBaro: onGround ? null : (raw.alt_baro as number | undefined) ?? null,
    altGeom: raw.alt_geom ?? null,
    gs: raw.gs,
    track: raw.track,
    baroRate: raw.baro_rate ?? null,
    squawk: raw.squawk,
    category: raw.category,
    onGround,
    registration: raw.r,
    typeCode: raw.t,
    seen: raw.seen,
    rssi: raw.rssi,
    ts,
  };
}

interface DeviceOrientationEventWithPermission extends Function {
  requestPermission?: () => Promise<"granted" | "denied">;
}

interface ARDisplayProps {
  onBack: () => void;
}

export function ARDisplay({ onBack }: ARDisplayProps) {
  const { state } = useStream("display");

  // State
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // Sensor stats / state
  const [deviceOrientation, setDeviceOrientation] = useState<{
    alpha: number;
    beta: number;
    gamma: number;
    screenAngle: number;
  } | null>(null);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);

  // Settings
  const [headingOffset, setHeadingOffset] = useState(0);
  const [showSky, setShowSky] = useState(true);
  const [standaloneMode, setStandaloneMode] = useState(false);
  const [hfov, setHfov] = useState(60); // degrees, standard phone HFOV

  // Standalone plane data
  const [standalonePlanes, setStandalonePlanes] = useState<Aircraft[]>([]);

  // TLE caching
  const [tles, setTles] = useState<any[]>([]);

  // Refs for requestAnimationFrame loop
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const orientationRef = useRef(deviceOrientation);
  orientationRef.current = deviceOrientation;
  
  const configRef = useRef<Config>(state.config ?? DEFAULT_CONFIG);
  configRef.current = state.config ?? DEFAULT_CONFIG;
  
  const gpsCoordsRef = useRef(gpsCoords);
  gpsCoordsRef.current = gpsCoords;
  
  const planesRef = useRef<Aircraft[]>([]);
  planesRef.current = (standaloneMode || (!state.connected && gpsCoords)) ? standalonePlanes : state.aircraft;

  const tlesRef = useRef(tles);
  tlesRef.current = tles;

  const headingOffsetRef = useRef(headingOffset);
  headingOffsetRef.current = headingOffset;

  // Swipe gesture variables
  const swipeStartX = useRef<number | null>(null);
  const swipeStartOffset = useRef<number>(0);

  // Secure context check
  const isSecure =
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  // Fetch TLEs from local server on startup
  useEffect(() => {
    const fetchTles = async () => {
      try {
        const res = await fetch(serverHttp("/api/tle"));
        if (res.ok) {
          const data = await res.json();
          setTles(data);
        }
      } catch (err) {
        console.warn("Could not fetch TLEs from local server, skipping satellites.");
      }
    };
    fetchTles();
  }, []);

  // Standalone / fallback flight poller
  useEffect(() => {
    const shouldPoll = standaloneMode || (!state.connected && gpsCoords);
    if (!shouldPoll || !gpsCoords) {
      setStandalonePlanes([]);
      return;
    }

    let timer: ReturnType<typeof setInterval>;
    
    const fetchStandalonePlanes = async () => {
      try {
        const radius = 15; // 15 miles
        const url = `/api/aircraft?lat=${gpsCoords.lat}&lon=${gpsCoords.lon}&radius=${radius}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        const rawList = raw.aircraft || raw.ac || [];
        const now = Date.now();
        const list: Aircraft[] = rawList.map((ac: any) => normalizeRawAircraft(ac, now));
        setStandalonePlanes(list);
      } catch (err) {
        console.error("Standalone API fetch failed:", err);
      }
    };

    fetchStandalonePlanes();
    timer = setInterval(fetchStandalonePlanes, 4000);

    return () => clearInterval(timer);
  }, [standaloneMode, state.connected, gpsCoords]);

  // Request permissions and start
  const handleStart = async () => {
    setLoading(true);
    setPermissionError(null);

    // 1. Request Geolocation
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 0,
        });
      });
      setGpsCoords({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
      });
      setGpsAccuracy(pos.coords.accuracy);
    } catch (err) {
      console.warn("Geolocation denied or timed out. Falling back to server config location.");
      // Fallback is handled implicitly by using configRef when gpsCoords is null
    }

    // 2. Request Camera
    if (videoRef.current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", "true");
        await videoRef.current.play();
      } catch (err) {
        console.error("Camera getUserMedia failed:", err);
        setPermissionError("Camera permission denied. Cannot overlay AR on live feed.");
        setLoading(false);
        return;
      }
    }

    // 3. Request Motion/DeviceOrientation Permission (specifically for iOS)
    const reqPermission = (DeviceOrientationEvent as unknown as DeviceOrientationEventWithPermission).requestPermission;
    if (typeof reqPermission === "function") {
      try {
        const result = await reqPermission();
        if (result !== "granted") {
          setPermissionError("Device motion and orientation permission denied.");
          setLoading(false);
          return;
        }
      } catch (err) {
        console.error("DeviceOrientation permission prompt failed:", err);
        setPermissionError("Device sensors are blocked. Check settings.");
        setLoading(false);
        return;
      }
    }

    // Success!
    setStarted(true);
    setLoading(false);
  };

  // Device orientation listener
  useEffect(() => {
    if (!started) return;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      let alpha = e.alpha ?? 0;
      if ("webkitCompassHeading" in e) {
        alpha = (e as any).webkitCompassHeading;
      }
      
      const screenAngle =
        typeof window.orientation === "number"
          ? window.orientation
          : (screen?.orientation?.angle ?? 0);

      setDeviceOrientation({
        alpha,
        beta: e.beta ?? 0,
        gamma: e.gamma ?? 0,
        screenAngle,
      });
    };

    if ("ondeviceorientationabsolute" in window) {
      (window as any).addEventListener("deviceorientationabsolute", handleOrientation);
    } else {
      (window as any).addEventListener("deviceorientation", handleOrientation);
    }

    // Continuously watch GPS coordinates to keep position accurate on the move
    const geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsCoords({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        });
        setGpsAccuracy(pos.coords.accuracy);
      },
      undefined,
      { enableHighAccuracy: true }
    );

    return () => {
      (window as any).removeEventListener("deviceorientationabsolute", handleOrientation);
      (window as any).removeEventListener("deviceorientation", handleOrientation);
      navigator.geolocation.clearWatch(geoWatchId);
    };
  }, [started]);

  // Touch Swipe Gesture Helpers for heading offset calibration
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      swipeStartX.current = e.touches[0].clientX;
      swipeStartOffset.current = headingOffset;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (swipeStartX.current !== null && e.touches.length === 1) {
      const diffX = e.touches[0].clientX - swipeStartX.current;
      // 1 pixel drag = ~0.2 degrees of adjustment
      const degChange = -diffX * 0.2;
      let newOffset = swipeStartOffset.current + degChange;
      
      // Keep offset within [-180, 180] degrees
      newOffset = ((newOffset + 180) % 360) - 180;
      if (newOffset < -180) newOffset += 360;
      
      setHeadingOffset(Math.round(newOffset));
    }
  };

  const handleTouchEnd = () => {
    swipeStartX.current = null;
  };

  // Main canvas animation and drawing loop
  useEffect(() => {
    if (!started || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let active = true;

    const render = () => {
      if (!active) return;

      // Handle retina/responsive resize
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== canvas.clientWidth * dpr || canvas.height !== canvas.clientHeight * dpr) {
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = canvas.clientHeight * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // Verify orientation data is loaded
      const orientation = orientationRef.current;
      if (!orientation) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Looking for device sensors...", w / 2, h / 2);
        requestAnimationFrame(render);
        return;
      }

      // Configure AR projection options
      const opts: ARPointOpts = {
        alpha: orientation.alpha,
        beta: orientation.beta,
        gamma: orientation.gamma,
        screenAngle: orientation.screenAngle,
        screenW: w,
        screenH: h,
        hfovDeg: hfov,
        headingOffsetDeg: headingOffsetRef.current,
      };

      const skyTimeOffsetMin = configRef.current.skyTimeOffsetMin;
      const observerLat = gpsCoordsRef.current?.lat ?? configRef.current.centerLat;
      const observerLon = gpsCoordsRef.current?.lon ?? configRef.current.centerLon;

      // 1. Draw Sky Layer (Stars, Constellations, Planets, Moon, Sun, Satellites)
      if (showSky) {
        const date = new Date(Date.now() + skyTimeOffsetMin * 60000);
        const sky = computeSky(date, observerLat, observerLon, {
          sun: true,
          moon: true,
          stars: true,
          satellites: true,
          planets: true,
          magLimit: 3.5, // limit stars to brighter ones for screen clarity
          tles: tlesRef.current,
        });

        // Constellations
        ctx.save();
        ctx.strokeStyle = "rgba(147, 197, 253, 0.2)";
        ctx.lineWidth = 1;
        
        const starProjMap = new Map<string, { x: number; y: number }>();
        for (const starObj of sky.stars) {
          const pt = projectARCelestial(starObj.az, starObj.alt, opts);
          if (pt && starObj.id) {
            starProjMap.set(starObj.id, pt);
          }
        }
        for (const [a, c] of ASTERISMS) {
          const pa = starProjMap.get(a);
          const pc = starProjMap.get(c);
          if (pa && pc) {
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pc.x, pc.y);
            ctx.stroke();
          }
        }
        ctx.restore();

        // Stars
        ctx.save();
        for (const starObj of sky.stars) {
          const pt = starProjMap.get(starObj.id || "");
          if (pt) {
            const mag = starObj.mag ?? 2;
            const size = Math.max(1, 3.5 - mag * 0.7);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(224, 231, 255, ${Math.max(0.3, (4.5 - mag) / 5)})`;
            ctx.fill();

            if (mag < 1.0 && starObj.name) {
              ctx.fillStyle = "rgba(148, 163, 184, 0.6)";
              ctx.font = "300 9px monospace";
              ctx.textAlign = "left";
              ctx.fillText(starObj.name, pt.x + 6, pt.y + 3);
            }
          }
        }
        ctx.restore();

        // Planets
        ctx.save();
        for (const pl of sky.planets) {
          const pt = projectARCelestial(pl.az, pl.alt, opts);
          if (pt) {
            const mag = pl.mag ?? 1;
            const size = Math.max(2.5, 4.5 - mag * 0.5);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, size, 0, Math.PI * 2);
            ctx.fillStyle = "#facc15"; // amber gold planet
            ctx.shadowColor = "#facc15";
            ctx.shadowBlur = 6;
            ctx.fill();
            ctx.shadowBlur = 0;

            if (pl.name) {
              ctx.fillStyle = "#facc15";
              ctx.font = "bold 9px sans-serif";
              ctx.fillText(pl.name, pt.x + 8, pt.y + 3);
            }
          }
        }
        ctx.restore();

        // Moon
        if (sky.moon && sky.moon.alt > 0) {
          const pt = projectARCelestial(sky.moon.az, sky.moon.alt, opts);
          if (pt) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 12, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(254, 243, 199, 0.85)";
            ctx.shadowColor = "#fef3c7";
            ctx.shadowBlur = 15;
            ctx.fill();
            ctx.restore();
          }
        }

        // Sun
        if (sky.sun && sky.sun.alt > 0) {
          const pt = projectARCelestial(sky.sun.az, sky.sun.alt, opts);
          if (pt) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 16, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(253, 186, 116, 0.9)";
            ctx.shadowColor = "#fdba74";
            ctx.shadowBlur = 30;
            ctx.fill();
            ctx.restore();
          }
        }

        // Satellites
        ctx.save();
        for (const sat of sky.sats) {
          const pt = projectARCelestial(sat.az, sat.alt, opts);
          if (pt) {
            const isISS = sat.kind === "iss";
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, isISS ? 4 : 2, 0, Math.PI * 2);
            ctx.fillStyle = isISS ? "#10b981" : "#3b82f6";
            ctx.fill();

            if (isISS) {
              ctx.fillStyle = "#10b981";
              ctx.font = "bold 10px monospace";
              ctx.fillText("ISS", pt.x + 6, pt.y + 3);
            }
          }
        }
        ctx.restore();
      }

      // 2. Draw Aircraft
      const planes = planesRef.current;
      const t = Date.now() / 1000;
      
      for (const ac of planes) {
        if (ac.lat == null || ac.lon == null) continue;
        const alt = ac.altBaro ?? ac.altGeom ?? 0;

        // Determine coordinates relative to the observer (phone GPS or default config)
        const m = llToMeters(ac.lat, ac.lon, observerLat, observerLon);
        const up = alt * 0.3048; // convert ft to meters

        const pt = projectAR(m.east, m.north, up, opts);
        if (pt) {
          const glyphKind = classifyGlyph(ac);
          const baseSize = 22;
          const sizeScale = skyGlyphScale(pt.zDoc);
          const size = baseSize * sizeScale;

          // Compute flight heading projection in screen space
          let heading = 0;
          if (ac.track != null && ac.gs != null) {
            const dt = 0.5;
            const aheadM = deadReckon(m, ac.track, ac.gs, dt);
            const ptAhead = projectAR(aheadM.east, aheadM.north, up, opts);
            if (ptAhead) {
              heading = Math.atan2(ptAhead.y - pt.y, ptAhead.x - pt.x);
            } else {
              heading = -(ac.track * Math.PI) / 180;
            }
          }

          // Draw the sweeping aircraft glyph
          ctx.save();
          ctx.translate(pt.x, pt.y);
          ctx.rotate(heading);
          
          const glyphColor: [number, number, number] = [232, 236, 255]; // luminous white-blue
          const seed = parseInt(ac.hex, 16) || 0;
          drawAircraftGlyph(ctx, glyphKind, size, glyphColor, 0.9, t, seed);
          ctx.restore();

          // Render Label Card
          ctx.save();
          ctx.fillStyle = "rgba(10, 15, 30, 0.75)";
          ctx.strokeStyle = "rgba(139, 92, 246, 0.3)";
          ctx.lineWidth = 1;
          
          const labelText = ac.flight ? ac.flight : ac.hex.toUpperCase();
          const altText = `${alt.toLocaleString()} ft`;
          const speedText = ac.gs ? `${Math.round(ac.gs)} kt` : "";
          const typeText = ac.typeCode || "";

          ctx.font = "10px sans-serif";
          const labelWidth = Math.max(
            ctx.measureText(labelText + (typeText ? ` (${typeText})` : "")).width,
            ctx.measureText(`${altText}   ${speedText}`).width
          ) + 12;

          ctx.beginPath();
          ctx.roundRect(pt.x - labelWidth / 2, pt.y + size + 6, labelWidth, 30, 8);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.font = "bold 9px sans-serif";
          ctx.fillText(labelText + (typeText ? ` (${typeText})` : ""), pt.x, pt.y + size + 16);

          ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
          ctx.font = "8px monospace";
          ctx.fillText(`${altText}   ${speedText}`, pt.x, pt.y + size + 26);
          ctx.restore();
        }
      }

      requestAnimationFrame(render);
    };

    const rafId = requestAnimationFrame(render);
    return () => {
      active = false;
      cancelAnimationFrame(rafId);
    };
  }, [started, showSky, hfov, standalonePlanes, state.aircraft]);

  // Main UI render
  return (
    <div className="ar-root" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
      {/* Onboarding Permission Screen */}
      {!started && (
        <div className="ar-modal-overlay">
          <div className="ar-modal">
            <h1 className="ar-modal-title">Skylight Live AR</h1>
            <p className="ar-modal-desc">
              Point your phone at the sky to see constellation maps and planes passing overhead in real time.
            </p>

            <div className="ar-features-list">
              <div className="ar-feature-item">
                <span className="ar-feature-icon">📷</span>
                <div className="ar-feature-text">
                  <strong>Camera Access</strong>
                  <span>Shows the sky in the background of the overlays.</span>
                </div>
              </div>
              <div className="ar-feature-item">
                <span className="ar-feature-icon">🧭</span>
                <div className="ar-feature-text">
                  <strong>Device Sensors</strong>
                  <span>Aligns the display markers with your phone's heading.</span>
                </div>
              </div>
              <div className="ar-feature-item">
                <span className="ar-feature-icon">📍</span>
                <div className="ar-feature-text">
                  <strong>Phone GPS Location</strong>
                  <span>Computes coordinates relative to your exact physical spot.</span>
                </div>
              </div>
            </div>

            {/* Insecure Connection warnings */}
            {!isSecure && (
              <div className="ar-warning-box">
                <div className="ar-warning-title">⚠️ Secure Context (HTTPS) Required</div>
                <p className="ar-warning-desc">
                  Mobile browsers restrict camera and motion sensors on HTTP connections.
                  Please launch with HTTPS enabled:
                </p>
                <div className="ar-code-box">HTTPS=1 pnpm dev</div>
              </div>
            )}

            {permissionError && (
              <div className="ar-warning-box" style={{ background: "rgba(244,63,94,0.15)" }}>
                <div className="ar-warning-title" style={{ color: "#f43f5e" }}>Error</div>
                <p className="ar-warning-desc">{permissionError}</p>
              </div>
            )}

            <button className="ar-start-btn" onClick={handleStart} disabled={loading}>
              {loading ? "Initializing..." : "Authorize & Start AR"}
            </button>
            
            <button className="ar-back-link" onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)" }}>
              ← Return to Dashboard
            </button>
          </div>
        </div>
      )}

      {/* Video Element */}
      <video ref={videoRef} className="ar-video" playsInline muted />

      {/* Drawing Overlay Canvas */}
      <canvas ref={canvasRef} className="ar-canvas" />

      {/* HUD Control Panels */}
      {started && (
        <div className="ar-ui-container">
          <div className="ar-header">
            {/* Status Badge */}
            <div className="ar-status-badge ar-ui-element">
              <div className="ar-status-line">
                <div className={`ar-status-dot ${standaloneMode ? "bad" : state.connected ? "ok" : "bad"}`} />
                <span>
                  {standaloneMode
                    ? "Standalone (Airplanes.live)"
                    : state.connected
                    ? "Local Server (WS Connected)"
                    : "Connecting to Local Server..."}
                </span>
              </div>
              <div style={{ color: "var(--color-text-muted)" }}>
                {planesRef.current.length} planes in range · GPS: {gpsCoords ? `OK (${Math.round(gpsAccuracy ?? 0)}m)` : "Default"}
              </div>
            </div>

            {/* Header action buttons */}
            <div className="ar-header-actions ar-ui-element">
              <button
                className={`ar-btn ${showSky ? "ar-btn-active" : ""}`}
                onClick={() => setShowSky(!showSky)}
              >
                🌌 Sky
              </button>
              <button
                className={`ar-btn ${standaloneMode ? "ar-btn-active" : ""}`}
                onClick={() => setStandaloneMode(!standaloneMode)}
                title="Force-switch between local RTL-SDR WebSocket feed and public airplanes.live API"
              >
                📡 {standaloneMode ? "Public API" : "Local WS"}
              </button>
              <button className="ar-btn" onClick={() => window.location.reload()}>
                🔄 Reset
              </button>
            </div>
          </div>

          <div className="ar-footer">
            {/* Calibration Panel */}
            <div className="ar-calib-panel ar-ui-element">
              <div className="ar-slider-container">
                <div className="ar-slider-header">
                  <span>Azimuth (Heading) Alignment</span>
                  <span className="ar-slider-val">
                    {headingOffset > 0 ? `+${headingOffset}` : headingOffset}°
                  </span>
                </div>
                <input
                  type="range"
                  className="ar-slider"
                  min="-180"
                  max="180"
                  value={headingOffset}
                  onChange={(e) => setHeadingOffset(parseInt(e.target.value))}
                />
              </div>
              
              <div className="ar-slider-container">
                <div className="ar-slider-header">
                  <span>Camera Field of View (FOV)</span>
                  <span className="ar-slider-val">{hfov}°</span>
                </div>
                <input
                  type="range"
                  className="ar-slider"
                  min="40"
                  max="90"
                  value={hfov}
                  onChange={(e) => setHfov(parseInt(e.target.value))}
                />
              </div>

              <div className="ar-tip-text">
                💡 Tip: Swipe left/right on the camera view to calibrate the compass.
              </div>
            </div>
            
            <button className="ar-back-link ar-ui-element" onClick={onBack} style={{ color: "#fff", background: "var(--color-glass-bg)", border: "1px solid var(--color-glass-border)", padding: "6px 12px", borderRadius: "8px", cursor: "pointer" }}>
              ← Return to Dashboard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
