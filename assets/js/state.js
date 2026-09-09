// state.js — one state object, one localStorage key. This is a single GM's
// copy of the tool running one ongoing campaign, so there is no table
// password gate and no export/import multi-table story — just persistence.
window.AxisState = (function () {
  const KEY = 'wyldwolf-axis-state-v1';

  function defaults() {
    return {
      session: { name: '', notes: '' },
      progress: {
        // adventureId -> { sceneHash -> { done: bool, notes: string } }
      },
      // Party: one-time-snapshot D&D Beyond imports (see ddb-import.js) plus
      // the GM's in-app edits to them. `snapshot` is exactly what
      // ddb-import.js's mapCharacter() produced at import/re-sync time and
      // is overwritten wholesale on re-sync; `gm` is this app's own state on
      // top of it and survives a re-sync.
      party: [
        // { id, snapshot: {...}, gm: { hpCurrent, conditions: [], notes: '' } }
      ],
      // Per-scene, per-adversary-instance GM overrides — the adventure
      // tracker's "modified encounters" (adjusted HP / a table-specific
      // note on a specific adversary as it appears in a specific scene).
      // adventureId -> sceneHash -> adversaryHash -> { hpCurrent, notes }
      encounterOverrides: {},
      // Adventure-tracker pagination — which scene "page" the GM last had
      // open per adventure, so switching tabs and back doesn't reset to
      // page 1. Purely a UI convenience, not campaign progress.
      // adventureId -> pageIndex
      trackerPage: {},
      // "Play mode" combat state per scene — initiative order/round/turn
      // pointer for a live encounter. Combatant HP itself is NOT stored
      // here: party HP lives in party[].gm.hpCurrent and adversary HP in
      // encounterOverrides, both above, so this is only the turn-order
      // bookkeeping layered on top of state that already existed.
      // adventureId -> sceneHash -> { round, turnIndex, order: [{key, kind, initiative}] }
      combat: {},
    };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      return Object.assign(defaults(), parsed);
    } catch (e) {
      return defaults();
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      // private window / storage blocked — state just won't persist this session
    }
  }

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
    const done = Object.values(adv).filter((s) => s.done).length;
    return { done, total: totalScenes };
  }

  // ── Party ──────────────────────────────────────────────────────────
  function genId() {
    return 'pc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function addPartyMember(snapshot) {
    const member = {
      id: genId(),
      snapshot,
      gm: { hpCurrent: snapshot.hpMax, conditions: [], notes: '' },
    };
    state.party.push(member);
    save();
    return member;
  }

  // Overwrites the snapshot in place (explicit re-sync action), keeps id
  // and the GM's own edits (conditions/notes); current HP is clamped to
  // the new max but not reset, so mid-fight HP tracking survives a resync
  // unless the new max is lower.
  function resyncPartyMember(id, snapshot) {
    const member = state.party.find((m) => m.id === id);
    if (!member) return null;
    member.snapshot = snapshot;
    member.gm.hpCurrent = Math.min(member.gm.hpCurrent, snapshot.hpMax);
    save();
    return member;
  }

  function removePartyMember(id) {
    state.party = state.party.filter((m) => m.id !== id);
    save();
  }

  function setPartyHp(id, hpCurrent) {
    const member = state.party.find((m) => m.id === id);
    if (!member) return;
    member.gm.hpCurrent = hpCurrent;
    save();
  }

  function setPartyNotes(id, notes) {
    const member = state.party.find((m) => m.id === id);
    if (!member) return;
    member.gm.notes = notes;
    save();
  }

  function setPartyConditions(id, conditions) {
    const member = state.party.find((m) => m.id === id);
    if (!member) return;
    member.gm.conditions = conditions;
    save();
  }

  function loadPartyFile(partyData) {
    if (!partyData || !Array.isArray(partyData.party)) throw new Error('Not a recognized party file.');
    // Merge by id: incoming entries overwrite existing ones with the same
    // id, new ids are appended — never silently drops the current roster.
    partyData.party.forEach((incoming) => {
      const idx = state.party.findIndex((m) => m.id === incoming.id);
      if (idx !== -1) state.party[idx] = incoming;
      else state.party.push(incoming);
    });
    save();
  }

  function exportPartyFile() {
    return { kind: 'wyldwolf-axis-party', version: 1, exportedAt: new Date().toISOString(), party: state.party };
  }

  // ── Encounter overrides (GM annotations on a specific adversary as it
  // appears in a specific scene) ───────────────────────────────────────
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

  function exportGmStateFile() {
    return {
      kind: 'wyldwolf-axis-gm-state',
      version: 1,
      exportedAt: new Date().toISOString(),
      session: state.session,
      progress: state.progress,
      encounterOverrides: state.encounterOverrides,
    };
  }

  function loadGmStateFile(gmData) {
    if (!gmData || gmData.kind !== 'wyldwolf-axis-gm-state') throw new Error('Not a recognized GM-state file.');
    if (gmData.session) state.session = gmData.session;
    if (gmData.progress) state.progress = Object.assign({}, state.progress, gmData.progress);
    if (gmData.encounterOverrides) state.encounterOverrides = Object.assign({}, state.encounterOverrides, gmData.encounterOverrides);
    save();
  }

  // ── Adventure-tracker pagination (UI-only, not campaign progress) ────
  function trackerPage(adventureId) {
    return state.trackerPage[adventureId] || 0;
  }

  function setTrackerPage(adventureId, pageIndex) {
    state.trackerPage[adventureId] = pageIndex;
    save();
  }

  // ── Play-mode combat state (turn order on top of HP state that already
  // exists elsewhere — see the `combat` comment in defaults()) ─────────
  function combatState(adventureId, sceneHash) {
    const adv = state.combat[adventureId] || {};
    return adv[sceneHash] || null;
  }

  function setCombatState(adventureId, sceneHash, combat) {
    if (!state.combat[adventureId]) state.combat[adventureId] = {};
    state.combat[adventureId][sceneHash] = combat;
    save();
  }

  function clearCombatState(adventureId, sceneHash) {
    if (state.combat[adventureId]) delete state.combat[adventureId][sceneHash];
    save();
  }

  return {
    state, save, sceneState, setSceneDone, setSceneNotes, adventureProgress,
    addPartyMember, resyncPartyMember, removePartyMember, setPartyHp, setPartyNotes, setPartyConditions,
    loadPartyFile, exportPartyFile,
    encounterOverride, setEncounterOverride, exportGmStateFile, loadGmStateFile,
    trackerPage, setTrackerPage,
    combatState, setCombatState, clearCombatState,
  };
})();
