// wyldwolf-axis D&D Beyond character proxy.
//
// D&D Beyond's character JSON API sends no CORS headers, so the static
// wyldwolf-axis app (served from a different origin, e.g. GitHub Pages)
// can't call it directly from the browser. This Worker does the fetch
// server-side and re-serves the JSON with CORS scoped to that one origin.
//
// Endpoint documented/verified against a real public character during this
// build (see assets/js/ddb-import.js's header comment for verification
// notes and caveats — it is an UNDOCUMENTED, unsupported D&D Beyond API and
// can change without notice):
//
//   GET https://character-service.dndbeyond.com/character/v5/character/<id>?includeCustomItems=true
//
// with `Origin`/`Referer: https://www.dndbeyond.com` request headers (the
// endpoint 403s without them).

export interface Env {
  ALLOWED_ORIGIN: string;
}

const DDB_API_BASE = 'https://character-service.dndbeyond.com/character/v5/character';
const CHARACTER_ID_RE = /^\d+$/;

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function jsonError(env: Env, status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

// Accept either a bare numeric id or a full dndbeyond.com/characters/<id>
// share link, so ddb-import.js can pass either through unchanged.
function extractCharacterId(raw: string | null): string | null {
  if (!raw) return null;
  if (CHARACTER_ID_RE.test(raw)) return raw;
  const m = raw.match(/dndbeyond\.com\/characters\/(\d+)/i);
  return m ? m[1] : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== 'GET') {
      return jsonError(env, 405, 'Only GET is supported.');
    }

    const url = new URL(request.url);
    const id = extractCharacterId(url.searchParams.get('id'));
    if (!id) {
      return jsonError(env, 400, 'Missing or invalid `id` query param (character id or dndbeyond.com/characters/<id> link).');
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${DDB_API_BASE}/${id}?includeCustomItems=true`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; wyldwolf-axis-ddb-proxy/1.0)',
          'Accept': 'application/json',
          // D&D Beyond's gateway 403s requests that don't look like they
          // came from the site itself — see header comment above.
          'Origin': 'https://www.dndbeyond.com',
          'Referer': 'https://www.dndbeyond.com/',
        },
      });
    } catch (err) {
      return jsonError(env, 502, `Could not reach D&D Beyond: ${(err as Error).message}`);
    }

    if (!upstream.ok) {
      return jsonError(env, upstream.status === 404 ? 404 : 502, `D&D Beyond returned HTTP ${upstream.status} for character ${id} (private, deleted, or bad id?).`);
    }

    // Stream the upstream body straight through rather than buffering it —
    // character JSON can run to several hundred KB.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        ...corsHeaders(env),
      },
    });
  },
};
