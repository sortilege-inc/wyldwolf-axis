// config.js — where the Worker lives. One Worker serves both the D&D
// Beyond proxy and the session rooms (see worker/README.md).
//
// Served from localhost it points at `wrangler dev`; deployed, put the
// workers.dev (or custom) URL in DEPLOYED.
window.AxisConfig = (function () {
  const DEPLOYED = 'REPLACE_ME'; // e.g. 'https://wyldwolf-axis.<your-subdomain>.workers.dev'
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const WORKER_URL = local ? 'http://localhost:8787' : DEPLOYED;
  return { WORKER_URL, configured: WORKER_URL !== 'REPLACE_ME' };
})();
