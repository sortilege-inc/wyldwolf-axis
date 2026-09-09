# wyldwolf-axis Worker

One Cloudflare Worker for two jobs:

1. **D&D Beyond character proxy** — `GET /?id=<id|share link>`. The character API sends
   no CORS headers and 403s without `Origin`/`Referer: https://www.dndbeyond.com`, so the
   static app can't call it; the Worker does and re-serves the JSON with CORS scoped to
   the app's origin.
2. **Session rooms** — `POST /session` creates a room (`{ code, gmToken }`);
   `GET /session/:code/ws?token=…` is the WebSocket into it. Each room is a `SessionRoom`
   Durable Object holding the shared document (party, combat, maps, current scene) in
   SQLite. It applies ops with the same `assets/js/ops.js` the browser uses, validates them
   by role (the GM token may do anything; a player token only its claimed character, its
   companions and their tokens), and sends players a filtered view — no GM notes, no
   hidden tokens. Rooms expire after 14 idle days.

Both fetches and sockets are accepted from `ALLOWED_ORIGIN` (wrangler.jsonc) and from
`http://localhost:*` for development.

## Local development

```bash
cd worker
npm install
npx wrangler dev --port 8787
```

`assets/js/config.js` points at `http://localhost:8787` whenever the app itself is served
from localhost, so `python3 -m http.server` for the app plus `wrangler dev` here is the
whole loop. Durable Objects run locally with local SQLite; nothing touches your account.

## Deploy

```bash
cd worker
npx wrangler deploy
```

Then put the printed URL into `assets/js/config.js` (`DEPLOYED`). Set `ALLOWED_ORIGIN` in
`wrangler.jsonc` to the origin the app is served from (it is the GitHub Pages origin by
default). Durable Objects with SQLite storage are on the Workers free plan.
