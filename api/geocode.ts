export const config = {
  runtime: "edge",
};

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q");

  if (!q) {
    return new Response(JSON.stringify({ error: "Missing q query parameter" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // 1. Fast-path: check if query is already coordinates (e.g., "37.6213,-122.379")
  const m = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return new Response(
        JSON.stringify({
          lat,
          lon,
          name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=604800", // Cache coordinate queries for 7 days
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  }

  // 2. Nominatim lookup
  const targetUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(
    q
  )}`;
  try {
    const res = await fetch(targetUrl, {
      signal: AbortSignal.timeout(6000),
      headers: {
        "User-Agent": "SkylightWebAR/1.0",
        "Accept-Language": "en",
      },
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Nominatim API returned HTTP ${res.status}` }),
        {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;

    if (!hit) {
      return new Response(JSON.stringify({ error: "No matches found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    const name = (hit.display_name ?? q).split(",")[0].trim() || q;

    return new Response(JSON.stringify({ lat, lon, name }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600", // Cache place searches for 1 day
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Timeout fetching geocode results" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
