export const config = {
  runtime: "edge",
};

interface Tle {
  name: string;
  line1: string;
  line2: string;
}

function parseTle(text: string): Tle[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length);
  const out: Tle[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    // A standard TLE format has:
    // Line 0: Name (optional, we check index before line 1)
    // Line 1: starts with '1 '
    // Line 2: starts with '2 '
    if (lines[i].startsWith("1 ") && lines[i + 1]?.startsWith("2 ")) {
      const name = (lines[i - 1] ?? "SAT").replace(/^0 /, "").trim();
      out.push({ name, line1: lines[i], line2: lines[i + 1] });
      i++;
    }
  }
  return out;
}

export default async function handler(req: Request) {
  const celestrakUrl =
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle";
  try {
    const res = await fetch(celestrakUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "SkylightWebAR/1.0",
      },
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Celestrak returned HTTP ${res.status}` }),
        {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
    const text = await res.text();
    const tles = parseTle(text);
    return new Response(JSON.stringify(tles), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Timeout fetching TLEs" }),
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
