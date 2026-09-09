// state.js — one state object, one localStorage key, every change an op.
//
// Public mutators are thin: they build any ids the op needs, then
// commit(name, args). commit() applies the op through ops.js (the same
// code the session server runs), saves, and tells the bus:
//   state:changed   every window re-reads and redraws
//   op              the window holding the session socket forwards it
// Ops arriving from the session (session.js) go through applyRemote(),
// which applies and saves without re-forwarding.
//
// GM-only data — progress, notes, overrides, layout — never leaves this
// browser; those mutators write directly and save.
window.AxisState = (function () {
  const KEY = 'wyldwolf-axis-state-v1';
  const Ops = window.AxisOps;

  function defaults() {
    return {
      session: { name: '', notes: '' },
      // adventureId -> { sceneHash -> { done, notes } }   (GM only)
      progress: {},
      // Party: D&D Beyond snapshots plus the live layer (`gm`) on top —
      // see liveDefaults(). Shared.
      party: [],
      // adventureId -> sceneHash -> adversaryHash -> { hpCurrent, notes }
      // Pre-encounter scene defaults. GM only.
      encounterOverrides: {},
      // adventureId -> pageIndex. Shared: the table follows it.
      trackerPage: {},
      // adventureId -> sceneHash -> { round, turnIndex, instances: [...] }
      // Live encounter rosters. Shared.
      combat: {},
      // Tile layout (layout.js). GM only.
      layout: null,
      // sceneHash -> { image, w, h, grid, tokens, effects, fog }. Shared.
      maps: {},
    };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      (parsed.party || []).forEach(normalizeMember);
      return Object.assign(defaults(), parsed);
    } catch (e) {
      return defaults();
    }
  }

  // Re-read localStorage IN PLACE: `state` is handed out by reference.
  function reload() {
    const fresh = load();
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, fresh);
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      // private window / storage blocked — state won't persist this session
    }
    if (window.AxisBus) window.AxisBus.emit('state:changed', { at: Date.now() });
  }

  if (window.AxisBus) {
    window.AxisBus.on('state:changed', (payload, meta) => {
      if (meta && meta.remote) reload();
    });
  }

  // ── ops ────────────────────────────────────────────────────────────
  function commit(name, args) {
    Ops.apply(state, name, args);
    save();
    if (window.AxisBus) window.AxisBus.emit('op', { name, args, at: Date.now() });
  }

  function applyRemote(name, args) {
    Ops.apply(state, name, args);
    save();
  }

  // Replace the shared slice wholesale (session snapshot).
  function replaceShared(doc) {
    Ops.SHARED_KEYS.forEach((k) => {
      if (doc[k] != null) state[k] = doc[k];
    });
    (state.party || []).forEach(normalizeMember);
    save();
  }

  // ── scenes (GM only) ───────────────────────────────────────────────
  function sceneState(adventureId, sceneHash) {
    const adv = state.progress[adventureId] || {};
    return adv[sceneHash] || { done: false, notes: '' };
  }

  function setSceneDone(adventureId, sceneHash, done) {
    if (!state.progress[adventureId]) state.progress[adventureId] = {};
    const cur = state.progress[adventureId][sceneHash] || { done: false, notes: '' };
    cur.done = done;
    state.progress[adventureId][sceneHash] = cur;
    save();
  }

  function setSceneNotes(adventureId, sceneHash, notes) {
    if (!state.progress[adventureId]) state.progress[adventureId] = {};
    const cur = state.progress[adventureId][sceneHash] || { done: false, notes: '' };
    cur.notes = notes;
    state.progress[adventureId][sceneHash] = cur;
    save();
  }

  function adventureProgress(adventureId, totalScenes) {
    const adv = state.progress[adventureId] || {};
    return { done: Object.values(adv).filter((s) => s.done).length, total: totalScenes };
  }

  // ── party ──────────────────────────────────────────────────────────
  function genId() {
    return 'pc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // `gm` is the live layer on top of the snapshot: what changes at the
  // table and survives a re-sync. Players may edit all of it except
  // `notes` (the GM's).
  function liveDefaults(snapshot) {
    const slotsUsed = {};
    (snapshot.spellSlots || []).forEach((s) => {
      if (s.used) slotsUsed[s.level] = s.used;
    });
    const resourcesUsed = {};
    (snapshot.resources || []).forEach((r) => {
      if (r.used) resourcesUsed[r.key] = r.used;
    });
    return {
      hpCurrent: Math.max(0, (snapshot.hpMax || 0) - (snapshot.removedHp || 0)),
      tempHp: snapshot.tempHp || 0,
      conditions: [],
      notes: '',
      playerNotes: '',
      slotsUsed,
      pactUsed: (snapshot.pactMagic || []).reduce((a, s) => a + (s.used || 0), 0),
      resourcesUsed,
      deathSaves: { success: 0, fail: 0 },
      inspiration: !!snapshot.inspiration,
      inventory: {},
      companionHp: {},
    };
  }

  function normalizeMember(m) {
    if (!m || !m.snapshot) return m;
    const d = liveDefaults(m.snapshot);
    m.gm = m.gm || {};
    Object.keys(d).forEach((k) => {
      if (m.gm[k] == null) m.gm[k] = d[k];
    });
    return m;
  }

  function member(id) {
    return state.party.find((m) => m.id === id) || null;
  }

  function addPartyMember(snapshot) {
    const m = { id: genId(), snapshot, gm: liveDefaults(snapshot) };
    commit('addPartyMember', [m]);
    return member(m.id);
  }

  function resyncPartyMember(id, snapshot) {
    commit('resyncPartyMember', [id, snapshot]);
    return member(id);
  }

  const removePartyMember = (id) => commit('removePartyMember', [id]);
  const setPartyHp = (id, hp) => commit('setPartyHp', [id, hp]);
  const setPartyNotes = (id, notes) => commit('setPartyNotes', [id, notes]);
  const setPartyConditions = (id, list) => commit('setPartyConditions', [id, list]);
  const setPartyLive = (id, patch) => commit('setPartyLive', [id, patch]);
  const setSlotUsed = (id, level, used) => commit('setSlotUsed', [id, level, used]);
  const setPactUsed = (id, used) => commit('setPactUsed', [id, used]);
  const setResourceUsed = (id, key, used) => commit('setResourceUsed', [id, key, used]);
  const setInventoryQty = (id, key, qty) => commit('setInventoryQty', [id, key, qty]);
  const restParty = (id, kind) => commit('restParty', [id, kind]);

  function loadPartyFile(partyData) {
    if (!partyData || !Array.isArray(partyData.party)) throw new Error('Not a recognized party file.');
    partyData.party.forEach((incoming) => {
      normalizeMember(incoming);
      const idx = state.party.findIndex((m) => m.id === incoming.id);
      if (idx !== -1) commit('removePartyMember', [incoming.id]);
      commit('addPartyMember', [incoming]);
    });
  }

  function exportPartyFile() {
    return { kind: 'wyldwolf-axis-party', version: 1, exportedAt: new Date().toISOString(), party: state.party };
  }

  // ── encounter overrides (GM only) ──────────────────────────────────
  function encounterOverride(adventureId, sceneHash, adversaryHash) {
    const adv = (state.encounterOverrides[adventureId] || {})[sceneHash] || {};
    return adv[adversaryHash] || { hpCurrent: null, notes: '' };
  }

  function setEncounterOverride(adventureId, sceneHash, adversaryHash, patch) {
    if (!state.encounterOverrides[adventureId]) state.encounterOverrides[adventureId] = {};
    if (!state.encounterOverrides[adventureId][sceneHash]) state.encounterOverrides[adventureId][sceneHash] = {};
    const cur = state.encounterOverrides[adventureId][sceneHash][adversaryHash] || { hpCurrent: null, notes: '' };
    Object.assign(cur, patch);
    state.encounterOverrides[adventureId][sceneHash][adversaryHash] = cur;
    save();
  }

  // ── GM-state file ──────────────────────────────────────────────────
  function exportGmStateFile() {
    return {
      kind: 'wyldwolf-axis-gm-state',
      version: 1,
      exportedAt: new Date().toISOString(),
      session: state.session,
      progress: state.progress,
      encounterOverrides: state.encounterOverrides,
      combat: state.combat,
      layout: state.layout,
      maps: state.maps,
    };
  }

  function loadGmStateFile(gmData) {
    if (!gmData || gmData.kind !== 'wyldwolf-axis-gm-state') throw new Error('Not a recognized GM-state file.');
    if (gmData.session) state.session = gmData.session;
    if (gmData.progress) state.progress = Object.assign({}, state.progress, gmData.progress);
    if (gmData.encounterOverrides) state.encounterOverrides = Object.assign({}, state.encounterOverrides, gmData.encounterOverrides);
    if (gmData.combat) state.combat = Object.assign({}, state.combat, gmData.combat);
    if (gmData.layout) state.layout = gmData.layout;
    if (gmData.maps) state.maps = Object.assign({}, state.maps, gmData.maps);
    save();
  }

  // ── layout (GM only) ───────────────────────────────────────────────
  function layout() {
    return state.layout;
  }

  function setLayout(tree) {
    state.layout = tree;
    save();
  }

  // ── tracker page (shared) ──────────────────────────────────────────
  function trackerPage(adventureId) {
    return state.trackerPage[adventureId] || 0;
  }

  const setTrackerPage = (adventureId, idx) => commit('setTrackerPage', [adventureId, idx]);

  // ── combat (shared) ────────────────────────────────────────────────
  function combatState(adventureId, sceneHash) {
    const adv = state.combat[adventureId] || {};
    return adv[sceneHash] || null;
  }

  const setCombatState = (a, s, c) => commit('setCombatState', [a, s, c]);
  const clearCombatState = (a, s) => commit('clearCombatState', [a, s]);

  function genInstanceId() {
    return 'inst_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function genConditionId() {
    return 'cond_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function addCombatInstance(adventureId, sceneHash, instance) {
    const withId = Object.assign({ instanceId: genInstanceId(), initiative: null, conditions: [], notes: '' }, instance);
    commit('addCombatInstance', [adventureId, sceneHash, withId]);
    return withId;
  }

  const removeCombatInstance = (a, s, id) => commit('removeCombatInstance', [a, s, id]);
  const setInstanceHp = (a, s, id, hp) => commit('setInstanceHp', [a, s, id, hp]);
  const setInstanceInitiative = (a, s, id, init) => commit('setInstanceInitiative', [a, s, id, init]);
  const setInstanceNotes = (a, s, id, notes) => commit('setInstanceNotes', [a, s, id, notes]);

  function addInstanceCondition(adventureId, sceneHash, instanceId, name, duration) {
    const cond = { id: genConditionId(), name, duration: duration != null && duration !== '' ? parseInt(duration, 10) : null };
    commit('addInstanceCondition', [adventureId, sceneHash, instanceId, cond]);
  }

  const removeInstanceCondition = (a, s, id, condId) => commit('removeInstanceCondition', [a, s, id, condId]);

  // Returns what expired so the caller can log it.
  function tickDurations(adventureId, sceneHash) {
    const c = combatState(adventureId, sceneHash);
    if (!c) return [];
    const expired = [];
    (c.instances || []).forEach((inst) => {
      (inst.conditions || []).forEach((cond) => {
        if (cond.duration != null && cond.duration - 1 <= 0) expired.push({ instanceName: inst.displayName, conditionName: cond.name });
      });
    });
    commit('tickDurations', [adventureId, sceneHash]);
    return expired;
  }

  function addCompanionInstance(adventureId, sceneHash, memberId, companionKey) {
    const m = member(memberId);
    const c = m && (m.snapshot.companions || []).find((x) => x.key === companionKey);
    if (!c) return null;
    const hp = m.gm.companionHp[companionKey];
    return addCombatInstance(adventureId, sceneHash, {
      defRef: `${memberId}:${companionKey}`,
      sourceKind: 'companion',
      owner: memberId,
      displayName: c.name,
      hpMax: c.hpMax,
      hpCurrent: hp != null ? hp : c.hpMax,
    });
  }

  const companionFor = (defRef) => Ops.companionFor(state, defRef);

  // ── maps (shared) ──────────────────────────────────────────────────
  function mapState(sceneHash) {
    return state.maps[sceneHash] || null;
  }

  const setMapState = (sceneHash, map) => commit('setMapState', [sceneHash, map]);
  const setTokenPosition = (sceneHash, instanceId, x, y) => commit('setTokenPosition', [sceneHash, instanceId, x, y]);

  function genEffectId() {
    return 'fx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  return {
    state, save, reload, commit, applyRemote, replaceShared,
    sceneState, setSceneDone, setSceneNotes, adventureProgress,
    member, addPartyMember, resyncPartyMember, removePartyMember, setPartyHp, setPartyNotes, setPartyConditions,
    setPartyLive, setSlotUsed, setPactUsed, setResourceUsed, setInventoryQty, restParty,
    addCompanionInstance, companionFor,
    loadPartyFile, exportPartyFile,
    encounterOverride, setEncounterOverride, exportGmStateFile, loadGmStateFile,
    layout, setLayout,
    trackerPage, setTrackerPage,
    combatState, setCombatState, clearCombatState,
    addCombatInstance, removeCombatInstance, setInstanceHp, setInstanceInitiative, setInstanceNotes,
    addInstanceCondition, removeInstanceCondition, tickDurations,
    mapState, setMapState, setTokenPosition, genEffectId,
  };
})();
