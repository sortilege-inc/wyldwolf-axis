// session.js — the session socket, for the GM's page and the player's.
//
// One window per browser holds the socket (the one that called start()
// or join()); the other windows on that machine (the table, a player's
// map view) ride the bus. Wiring:
//   local op committed here ........ send to the server
//   op from another window (bus) .. forward to the server
//   op from the server ............ State.applyRemote (saves → every
//                                   window redraws)
//   events (roll, ping, select, scene:changed) go both ways the same way
// The server's document is authoritative once it exists: on connect the
// client takes the snapshot, and only seeds it when the room is empty.
window.AxisSession = (function () {
  const KEY = 'wyldwolf-axis-session';
  const State = window.AxisState;
  const Bus = window.AxisBus;
  const Ops = window.AxisOps;
  const Config = window.AxisConfig;

  const EVENTS = ['roll', 'ping', 'select', 'scene:changed'];

  let info = load(); // { role, code, token, memberId, base }
  let ws = null;
  let status = 'offline'; // offline | connecting | online
  let receiving = false;
  let retry = null;
  let claims = {}; // memberId -> { name }
  const listeners = [];

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function persist() {
    try {
      if (info) localStorage.setItem(KEY, JSON.stringify(info));
      else localStorage.removeItem(KEY);
    } catch (e) {
      /* no storage */
    }
  }

  function setStatus(s) {
    status = s;
    notify();
  }

  function notify() {
    listeners.forEach((fn) => {
      try {
        fn(current());
      } catch (e) {
        console.error(e);
      }
    });
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => listeners.splice(listeners.indexOf(fn), 1);
  }

  function current() {
    return { status, info: info ? Object.assign({}, info) : null, claims: Object.assign({}, claims), active: !!info, connected: status === 'online' };
  }

  function base() {
    return (info && info.base) || Config.WORKER_URL;
  }

  function joinUrl() {
    if (!info) return null;
    const u = new URL('play.html', location.href);
    u.searchParams.set('s', info.code);
    return u.toString();
  }

  // ── lifecycle ──────────────────────────────────────────────────────
  async function start() {
    if (!Config.configured) throw new Error('Worker URL not configured (assets/js/config.js).');
    const res = await fetch(Config.WORKER_URL + '/session', { method: 'POST' });
    if (!res.ok) throw new Error('Could not create a session (HTTP ' + res.status + ').');
    const body = await res.json();
    info = { role: 'gm', code: body.code, token: body.gmToken, base: Config.WORKER_URL };
    persist();
    connect();
    return current();
  }

  function join(code, token) {
    info = { role: 'player', code: String(code).toUpperCase(), token: token || null, memberId: null, base: Config.WORKER_URL };
    persist();
    connect();
  }

  function leave() {
    if (retry) clearTimeout(retry);
    retry = null;
    if (ws) {
      const w = ws;
      ws = null;
      w.close();
    }
    info = null;
    claims = {};
    persist();
    setStatus('offline');
  }

  function connect() {
    if (!info) return;
    if (ws) {
      const w = ws;
      ws = null;
      w.close();
    }
    setStatus('connecting');
    const url = new URL(base().replace(/^http/, 'ws') + '/session/' + encodeURIComponent(info.code) + '/ws');
    if (info.token) url.searchParams.set('token', info.token);
    const sock = new WebSocket(url.toString());
    ws = sock;
    sock.onopen = () => send({ type: 'hello' });
    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      handle(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setStatus('offline');
      if (info) retry = setTimeout(connect, 2500);
    };
    sock.onerror = () => {};
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // ── incoming ───────────────────────────────────────────────────────
  function handle(msg) {
    switch (msg.type) {
      case 'snapshot': {
        if (msg.role) info.role = msg.role;
        if (msg.memberId !== undefined) info.memberId = msg.memberId;
        if (msg.token && !info.token) info.token = msg.token;
        claims = msg.claims || {};
        persist();
        if (msg.doc) {
          receiving = true;
          State.replaceShared(msg.doc);
          receiving = false;
          Bus.emit('state:remote', { snapshot: true }, { local: true });
        } else if (info.role === 'gm') {
          send({ type: 'init', doc: Ops.sharedSlice(State.state) });
        }
        setStatus('online');
        break;
      }
      case 'op':
        receiving = true;
        try {
          State.applyRemote(msg.name, msg.args);
        } finally {
          receiving = false;
        }
        // Applied in this window, so state:changed fired with remote:false;
        // panels that only redraw on outside changes listen for this.
        Bus.emit('state:remote', { name: msg.name }, { local: true });
        break;
      case 'event':
        receiving = true;
        try {
          Bus.emit(msg.name, msg.payload);
        } finally {
          receiving = false;
        }
        break;
      case 'claims':
        claims = msg.claims || {};
        notify();
        break;
      case 'claimed':
        info.memberId = msg.memberId;
        if (msg.token) info.token = msg.token;
        persist();
        notify();
        break;
      case 'error':
        console.warn('session:', msg.message);
        if (msg.fatal) leave();
        Bus.emit('session:error', { message: msg.message }, { local: true });
        break;
      default:
        break;
    }
  }

  // ── outgoing ───────────────────────────────────────────────────────
  Bus.on('op', (p) => {
    if (!ws || receiving || !p || !Ops.OPS[p.name]) return;
    send({ type: 'op', name: p.name, args: p.args });
  });

  EVENTS.forEach((name) => {
    Bus.on(name, (payload) => {
      if (!ws || receiving) return;
      send({ type: 'event', name, payload });
    });
  });

  function claim(memberId) {
    send({ type: 'claim', memberId });
  }

  function unclaim(memberId) {
    send({ type: 'unclaim', memberId });
  }

  // Seed the room from this browser's state (GM, explicit).
  function reseed() {
    if (!info || info.role !== 'gm') return;
    send({ type: 'init', doc: Ops.sharedSlice(State.state), force: true });
  }

  if (info) connect();

  return { start, join, leave, claim, unclaim, reseed, current, onChange, joinUrl };
})();
