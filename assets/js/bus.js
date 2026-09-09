// bus.js — one event bus for the whole tool, in-window and cross-window.
//
// Every window of this app (the GM page, the VTT, a player view) loads the
// same state.js over the same localStorage key, so persistence is already
// shared; what this adds is *notification*. A BroadcastChannel carries
// events to the other same-origin windows; handlers in this window run
// synchronously. The transport is deliberately one small object so a
// server-backed one (WebSocket) can replace it later without touching
// panels.
//
// Event catalogue (payload shapes are the contract — keep them stable):
//   state:changed   { at }                        state.js saved; other
//                                                 windows reload before
//                                                 their handlers run
//   scene:changed   { adventureId, sceneHash, pageIndex }
//   select          { kind, ... }                 see panels.js select()
//   ping            { sceneHash, x, y }           VTT (later)
//
// Handlers receive (payload, meta) where meta.remote is true when the event
// came from another window.
window.AxisBus = (function () {
  const CHANNEL = 'wyldwolf-axis';
  const handlers = {};
  const windowId = Math.random().toString(36).slice(2, 10);
  let channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch (e) {
    channel = null; // very old browser: in-window events still work
  }

  function on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    handlers[type] = (handlers[type] || []).filter((h) => h !== fn);
  }

  function dispatch(type, payload, meta) {
    (handlers[type] || []).slice().forEach((h) => {
      try {
        h(payload, meta);
      } catch (e) {
        console.error('AxisBus handler failed for ' + type, e);
      }
    });
  }

  // opts.local: true → this window only (never crosses to other windows)
  function emit(type, payload, opts) {
    dispatch(type, payload, { remote: false });
    if (!(opts && opts.local) && channel) channel.postMessage({ type, payload, from: windowId });
  }

  if (channel) {
    channel.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.from === windowId) return;
      dispatch(m.type, m.payload, { remote: true });
    };
  }

  return { on, off, emit, windowId };
})();
