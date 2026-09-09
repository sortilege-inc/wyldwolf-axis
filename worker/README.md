# wyldwolf-axis D&D Beyond proxy

A tiny Cloudflare Worker that proxies D&D Beyond's character JSON API so
the static wyldwolf-axis app (a different origin — GitHub Pages, etc.) can
fetch it. D&D Beyond's API sends no CORS headers, so the browser can't call
it directly; this Worker does the fetch server-side and re-serves the JSON
with `Access-Control-Allow-Origin` scoped to the app's own origin only
(never `*`).

## What it does

`GET <worker-url>/?id=<character-id-or-share-link>` →
fetches `https://character-service.dndbeyond.com/character/v5/character/<id>?includeCustomItems=true`
server-side (with the `Origin`/`Referer` headers D&D Beyond's gateway
requires — see `src/index.ts`) and streams the JSON back with CORS headers.

**Endpoint status:** D&D Beyond has no supported/documented public API.
This is the community-documented character-service endpoint, and it was
**live-verified working** during this build (see
`assets/js/ddb-import.js`'s header comment: a real public character id
returned HTTP 200 with full character JSON on 2026-09-08). It is
unsupported and can change or break without notice — if imports start
failing, check whether the endpoint shape or required headers have
changed before assuming a bug in this Worker.

## Deploy

From this directory:

```bash
npm install
npx wrangler deploy
```

This was **not run** as part of building this feature — deploying is a
real infra action for you to review and run. `wrangler deploy` will print
the deployed Worker's URL (`https://wyldwolf-axis-ddb-proxy.<your-subdomain>.workers.dev`
unless you've set a route/custom domain).

## Configuration

Edit `wrangler.jsonc` before deploying:

- **`vars.ALLOWED_ORIGIN`** — set this to the exact origin wyldwolf-axis is
  served from (e.g. `https://<you>.github.io` — no trailing path or
  slash). The Worker only ever sets `Access-Control-Allow-Origin` to this
  one value, so a mismatch here means the app's `fetch()` calls will be
  blocked by the browser even though the Worker itself is healthy. If you
  need this to work from both a deployed origin and local dev
  (`http://localhost:8934`), either deploy two Workers with different
  `ALLOWED_ORIGIN`s (simplest) or change `corsHeaders()` in `src/index.ts`
  to check the incoming `Origin` request header against a small allow-list
  instead of a single fixed value.

No secrets, KV, or other bindings are needed — this Worker only makes an
outbound `fetch()`.

## Point the app at it

After deploying, open `assets/js/ddb-import.js` and replace:

```js
const DDB_PROXY_URL = 'REPLACE_ME';
```

with the deployed Worker's URL, e.g.:

```js
const DDB_PROXY_URL = 'https://wyldwolf-axis-ddb-proxy.<your-subdomain>.workers.dev';
```

## Local dev

```bash
npx wrangler dev
```

then point `DDB_PROXY_URL` at `http://localhost:8787` temporarily (and set
`ALLOWED_ORIGIN` to match whatever origin you're serving the app from
locally, e.g. `http://localhost:8934`) to test end-to-end without
deploying.
