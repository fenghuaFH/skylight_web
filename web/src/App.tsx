import { useState } from "react";
import { useStream } from "./lib/useStream.js";
import { ARDisplay } from "./ar/ARDisplay.js";
import { Display } from "./display/Display.js";
import { DEFAULT_CONFIG } from "@shared/index.js";

type ViewMode = "dashboard" | "ar" | "radar";

interface LocationPreset {
  name: string;
  code: string;
  lat: number;
  lon: number;
}

const PRESETS: LocationPreset[] = [
  { name: "San Francisco Int'l", code: "SFO", lat: 37.6213, lon: -122.379 },
  { name: "Beijing Capital Int'l", code: "PEK", lat: 40.0799, lon: 116.6031 },
  { name: "London Heathrow", code: "LHR", lat: 51.4700, lon: -0.4543 },
  { name: "Tokyo Haneda", code: "HND", lat: 35.5494, lon: 139.7798 },
  { name: "New York JFK", code: "JFK", lat: 40.6413, lon: -73.7781 },
  { name: "Paris Charles de Gaulle", code: "CDG", lat: 49.0097, lon: 2.5479 },
];

export function App() {
  const { state, conn } = useStream("control");
  const [view, setView] = useState<ViewMode>("dashboard");
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const cfg = state.config ?? DEFAULT_CONFIG;

  // Verify secure context (HTTPS/localhost) for camera & sensor API usage
  const isSecure =
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  // Perform geocoding query
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;

    setSearching(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(searchQuery)}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults([data]);
      } else {
        const errData = await res.json().catch(() => ({}));
        setErrorMsg(errData.error || "Location not found. Try coordinates like '39.9,116.4'");
        setSearchResults([]);
      }
    } catch (err) {
      console.error("Geocoding request failed:", err);
      setErrorMsg("Failed to reach geocoding service.");
    } finally {
      setSearching(false);
    }
  };

  // Select location and apply config patch
  const selectLocation = (loc: { lat: number; lon: number; name: string }) => {
    conn.patchConfig({
      centerLat: loc.lat,
      centerLon: loc.lon,
      locationName: loc.name,
    });
    setSearchResults([]);
    setSearchQuery("");
    setErrorMsg(null);
  };

  // Geolocation trigger
  const syncGps = () => {
    setGpsLoading(true);
    setErrorMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        conn.patchConfig({
          centerLat: lat,
          centerLon: lon,
          locationName: `GPS Position (${Math.round(pos.coords.accuracy)}m accuracy)`,
        });
        setGpsLoading(false);
      },
      (err) => {
        console.warn("GPS Geolocate failed:", err);
        setErrorMsg("GPS permission denied or timed out.");
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 6000 }
    );
  };

  // Check orientation and camera permission before entering AR view
  const enterAR = () => {
    setView("ar");
  };

  if (view === "ar") {
    return <ARDisplay onBack={() => setView("dashboard")} />;
  }

  if (view === "radar") {
    return (
      <div className="radar-view-container">
        <button
          className="btn-secondary radar-back-btn"
          onClick={() => setView("dashboard")}
        >
          ← Return to Dashboard
        </button>
        <Display />
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      {/* Header */}
      <header className="dashboard-header">
        <h1 className="dashboard-title">Skylight Web AR</h1>
        <p className="dashboard-subtitle">
          See the planes overhead and celestial constellations aligned in real-time augmented reality.
        </p>
      </header>

      {/* Main Grid */}
      <div className="dashboard-grid">
        {/* Status indicator */}
        <div className="glass-card status-bar">
          <div className="status-indicator">
            <div className={`status-dot ${state.aircraft.length > 0 ? "active" : ""}`} />
            <span>
              {state.connected ? "WS Connected" : "Standalone Client Mode"}
            </span>
          </div>
          <div className="status-details">
            {state.aircraft.length} aircraft loaded
          </div>
        </div>

        {/* Action Launches */}
        <div className="glass-card launch-section">
          <button className="btn-cta" onClick={enterAR}>
            <span>🌟 Launch Live AR View</span>
          </button>
          
          <button className="btn-secondary" onClick={() => setView("radar")}>
            <span>🗺️ Open Projector Radar View</span>
          </button>

          {!isSecure && (
            <div className="ar-warning-box" style={{ marginTop: "8px" }}>
              <div className="ar-warning-title">⚠️ Secure Context (HTTPS) Required</div>
              <p className="ar-warning-desc">
                Browsers restrict camera and rotation sensor access to HTTPS or localhost. Ensure you access this URL securely on your mobile device.
              </p>
            </div>
          )}
        </div>

        {/* Collapsible Settings */}
        <div className="glass-card settings-section">
          <div
            className="collapsible-header"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <h2 className="section-title" style={{ margin: 0 }}>⚙️ Configuration & Settings</h2>
            <span className={`collapsible-arrow ${settingsOpen ? "open" : ""}`}>▼</span>
          </div>

          {settingsOpen && (
            <div className="collapsible-content">
              {/* Location Sync & Search */}
              <div className="form-group">
                <label className="form-label">Set Observation Location</label>
                
                {/* Active location stats */}
                <div className="location-status">
                  <div className="location-info">
                    <div className="location-name">{cfg.locationName}</div>
                    <div className="location-coords">
                      {cfg.centerLat.toFixed(4)}° N, {cfg.centerLon.toFixed(4)}° E
                    </div>
                  </div>
                  <button className="btn-gps" onClick={syncGps} disabled={gpsLoading}>
                    📡 {gpsLoading ? "Syncing..." : "Sync GPS"}
                  </button>
                </div>

                {/* Location Search Input */}
                <form className="search-wrapper" onSubmit={handleSearch}>
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search city/airport name, or lat,lon..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  <button type="submit" className="btn-search" disabled={searching}>
                    🔍
                  </button>
                </form>

                {/* Suggestions / Results */}
                {searchResults.length > 0 && (
                  <div className="search-results">
                    {searchResults.map((loc, idx) => (
                      <div
                        key={idx}
                        className="search-result-item"
                        onClick={() => selectLocation(loc)}
                      >
                        📍 {loc.name} ({loc.lat.toFixed(2)}, {loc.lon.toFixed(2)})
                      </div>
                    ))}
                  </div>
                )}

                {errorMsg && (
                  <div style={{ color: "var(--color-danger)", fontSize: "0.8rem", marginTop: "4px" }}>
                    {errorMsg}
                  </div>
                )}
              </div>

              {/* Presets Chips */}
              <div className="form-group">
                <label className="form-label">Quick Presets</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.code}
                      className="btn-gps"
                      onClick={() =>
                        selectLocation({
                          lat: preset.lat,
                          lon: preset.lon,
                          name: preset.name,
                        })
                      }
                      style={{
                        borderColor: cfg.locationName === preset.name ? "var(--color-primary)" : "rgba(255,255,255,0.1)",
                        color: cfg.locationName === preset.name ? "#fff" : "var(--color-text-muted)",
                        background: cfg.locationName === preset.name ? "rgba(139, 92, 246, 0.1)" : "transparent"
                      }}
                    >
                      ✈️ {preset.code}
                    </button>
                  ))}
                </div>
              </div>

              {/* Map Range Radius */}
              <div className="form-group slider-wrapper">
                <div className="slider-info">
                  <span className="form-label">Radar Search Range</span>
                  <span className="slider-val">{cfg.radiusMiles} miles</span>
                </div>
                <input
                  type="range"
                  className="ar-slider"
                  min="0.5"
                  max="15"
                  step="0.5"
                  value={cfg.radiusMiles}
                  onChange={(e) => conn.patchConfig({ radiusMiles: parseFloat(e.target.value) })}
                />
              </div>

              {/* Compass / Azimuth Adjust */}
              <div className="form-group slider-wrapper">
                <div className="slider-info">
                  <span className="form-label">AR Heading Calibration</span>
                  <span className="slider-val">
                    {cfg.rotationDeg > 0 ? `+${cfg.rotationDeg}` : cfg.rotationDeg}°
                  </span>
                </div>
                <input
                  type="range"
                  className="ar-slider"
                  min="-180"
                  max="180"
                  value={cfg.rotationDeg}
                  onChange={(e) => conn.patchConfig({ rotationDeg: parseInt(e.target.value) })}
                />
              </div>

              {/* Sky Objects Toggles */}
              <div className="form-group">
                <label className="form-label" style={{ marginBottom: "6px" }}>Celestial Sky Layers</label>
                <div className="checkbox-grid">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      className="checkbox-input"
                      checked={cfg.showStars}
                      onChange={(e) => conn.patchConfig({ showStars: e.target.checked })}
                    />
                    <span>⭐ Stars & Lines</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      className="checkbox-input"
                      checked={cfg.showPlanets}
                      onChange={(e) => conn.patchConfig({ showPlanets: e.target.checked })}
                    />
                    <span>🪐 Planets</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      className="checkbox-input"
                      checked={cfg.showSatellites}
                      onChange={(e) => conn.patchConfig({ showSatellites: e.target.checked })}
                    />
                    <span>🛰️ Satellites / ISS</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      className="checkbox-input"
                      checked={cfg.showMoon}
                      onChange={(e) => conn.patchConfig({ showMoon: e.target.checked })}
                    />
                    <span>🌙 Moon (Phase)</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      className="checkbox-input"
                      checked={cfg.showSun}
                      onChange={(e) => conn.patchConfig({ showSun: e.target.checked })}
                    />
                    <span>☀️ Sun</span>
                  </label>
                </div>
              </div>

              {/* Theme Dropdown */}
              <div className="form-group">
                <label className="form-label">Theme Visual Palette</label>
                <select
                  className="search-input"
                  value={cfg.theme}
                  onChange={(e) => conn.patchConfig({ theme: e.target.value as any })}
                  style={{ width: "100%", cursor: "pointer" }}
                >
                  <option value="ambient">Ambient (Luminous Blue-Grey)</option>
                  <option value="telemetry">Telemetry (Vibrant Cyan-Green)</option>
                  <option value="focus">Focus (Minimal Contrast)</option>
                </select>
              </div>

              {/* Reset Config */}
              <button
                className="btn-secondary"
                onClick={() => {
                  if (confirm("Reset configuration settings to defaults?")) {
                    conn.resetConfig();
                  }
                }}
                style={{
                  marginTop: "10px",
                  borderColor: "rgba(244, 63, 94, 0.2)",
                  color: "var(--color-danger)"
                }}
              >
                Reset Configuration Defaults
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="dashboard-footer">
        Skylight Web AR © 2026 · Built with React & Vite
      </footer>
    </div>
  );
}
