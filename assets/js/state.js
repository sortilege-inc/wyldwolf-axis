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
          // "Play mode" combat state per scene — the LIVE, authoritative
      // encounter roster once a GM has hit "Run Encounter": round/turn
      // pointer plus one row per physical combatant instance (so the same
      // adversary DEF can appear 3 times as 3 distinct tracked creatures).
      // Reconciliation with pre-existing per-scene state (deliberate call,
      // see playmode.js's header comment for the full reasoning):
      //   - party[].gm.hpCurrent stays the source of truth for a PC's HP
      //     OUTSIDE combat (Party tab); an active party instance here
      //     mirrors it both ways while the encounter runs.
      //   - encounterOverrides (scene+DEF-hash keyed, one row per unique
      //     adversary type) is now ONLY the pre-encounter "scene default" —
      //     a GM can still nudge a monster's starting HP before hitting Run
      //     Encounter. Once instances exist for a scene, they are the only
      //     thing read/written for live HP/conditions/initiative; ending
      //     the encounter does not try to collapse N instances of one DEF
      //     back into that one-row store.
      // adventureId -> sceneHash -> {
      //   round, turnIndex,
      //   instances: [{ instanceId, defRef, sourceKind: 'party'|'adversary'|'npc',
      //                  displayName, hpCurrent, hpMax, initiative,
      //                  conditions: [{id, name, duration}], notes }]
      // }
      combat: {},
      // Tile layout of the main page (see layout.js). null → the default
      // preset. Per-browser like everything else here, and carried in the
      // GM-state export so a table setup travels with the campaign.
      layout: null,
      // VTT maps, one per scene (see vtt.js). Tokens bind to combat
      // instances by instanceId — HP/conditions live on the instance, the
      // token only knows where it stands. Cell units throughout.
      // sceneHash -> { image, w, h, grid: { size, ox, oy, show, snap },
      //                tokens: [{ instanceId, x, y, size, hidden }],
      //                effects: [{ id, kind, ... }],
      //                fog: { enabled, revealed: [{ x, y, w, h }] } }
      maps: {},
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

  // Re-read localStorage IN PLACE. `state` is handed out by reference
  // (State.state) all over the app, so it must stay the same object —
  // another window's save has to land in the object everyone already holds.
  function reload() {
    const fresh = load();
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, fresh);
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      // private window / storage blocked — state just won't persist this session
    }
    if (window.AxisBus) window.AxisBus.emit('state:changed', { at: Date.now() });
  }

  // Another window saved: pull its state in before anyone else's handler
  // runs. This registers first because state.js loads first.
  if (window.AxisBus) {
    window.AxisBus.on('state:changed', (payload, meta) => {
      if (meta && meta.remote) reload();
    });
  }

  // ── Layout ─────────────────────────────────────────────────────────
  function layout() {
    return state.layout;
  }

  function setLayout(tree) {
    state.layout = tree;
    save();
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
      combat: state.combat,
      layout: state.layout,
      maps: state.maps,
    };
  }

  // ── VTT maps ───────────────────────────────────────────────────────
  function mapState(sceneHash) {
    return state.maps[sceneHash] || null;
  }

  function setMapState(sceneHash, map) {
    state.maps[sceneHash] = map;
    save();
  }

  function genEffectId() {
    return 'fx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

  function genInstanceId() {
    return 'inst_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function genConditionId() {
    return 'cond_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function addCombatInstance(adventureId, sceneHash, instance) {
    let combat = combatState(adventureId, sceneHash);
    if (!combat) combat = { round: 1, turnIndex: 0, instances: [] };
    if (!combat.instances) combat.instances = [];
    const withId = Object.assign({ instanceId: genInstanceId(), initiative: null, conditions: [], notes: '' }, instance);
    combat.instances.push(withId);
    setCombatState(adventureId, sceneHash, combat);
    return withId;
  }

  function removeCombatInstance(adventureId, sceneHash, instanceId) {
    const combat = combatState(adventureId, sceneHash);
    if (!combat) return;
    combat.instances = (combat.instances || []).filter((i) => i.instanceId !== instanceId);
    if (combat.turnIndex >= combat.instances.length) combat.turnIndex = 0;
    setCombatState(adventureId, sceneHash, combat);
  }

  function setInstanceHp(adventureId, sceneHash, instanceId, hpCurrent) {
    const combat = combatState(adventureId, sceneHash);
    if (!combat) return;
    const inst = (combat.instances || []).find((i) => i.instanceId === instanceId);
    if (!inst) return;
    inst.hpCurrent = hpCurrent;
    setCombatState(adventureId, sceneHash, combat);
    // Mirror party HP back to the party record so the Party tab (which
    // reads party[].gm.hpCurrent, not combat state) stays in sync while an
    // encounter is running.
    if (inst.sourceKind === 'party') setPartyHp(inst.defRef, hpCurrent);
  }

  function setInstanceInitiative(adventureId, sceneHash, instanceId, initiative) {
    const combat = combatState(adventureId, sceneHash);
    if (!combat) return;
    const inst = (combat.instances || []).find((i) => i.instanceId === instanceId);
    if (!inst) return;
    inst.initiative = initiative;
    setCombatState(adventureId, sceneHash, combat);
  }

  function addInstanceCondition(adventureId, sceneHash, instanceId, name, duration) {
    const combat = combatState(adventureId, sceneHash);
    if (!combat) return;
    const inst = (combat.instances || []).find((i) => i.instanceId === instanceId);
    if (!inst) return;
    if (!inst.conditions) inst.conditions = [];
    inst.conditions.push({ id: genConditionId(), name, duration: duration != null && duration !== '' ? parseInt(duration, 10) : null });
    setCombatState(adventureId, sceneHash, combat);
  }

  function removeInstanceCondition(adventureId, sceneHash, instanceId, conditionId) {
    const combat = combatState(adventureId, sceneHash);
    if (!combat) return;
    const inst = (combat.instances || []).find((i) => i.instanceId === instanceId);
    if (!inst) return;
    inst.conditions = (inst.conditions || []).filter((c) => c.id !== conditionId);
    setCombatState(adventureId, sceneHash, combat);
  }

  // Called when the round counter advances: decrements every timed
  // condition by 1 across all instances and strips out anything that hits
  // zero, returning what expired so the caller can log it. Untimed
  // (duration: null) conditions are left alone — they're removed manually.
  function tickDurations(adventureId, sceneHash) {
    const combat = combatState(adventureId, sceneHash);
    if (!combat) return [];
    const expired = [];
    (combat.instances || []).forEach((inst) => {
      inst.conditions = (inst.conditions || []).filter((c) => {
        if (c.duration == null) return true;
        c.duration -= 1;
        if (c.duration <= 0) {
          expired.push({ instanceName: inst.displayName, conditionName: c.name });
          return false;
        }
        return true;
      });
    });
    setCombatState(adventureId, sceneHash, combat);
    return expired;
  }

  return {
    state, save, reload, layout, setLayout, mapState, setMapState, genEffectId,
    sceneState, setSceneDone, setSceneNotes, adventureProgress,
    addPartyMember, resyncPartyMember, removePartyMember, setPartyHp, setPartyNotes, setPartyConditions,
    loadPartyFile, exportPartyFile,
    encounterOverride, setEncounterOverride, exportGmStateFile, loadGmStateFile,
    trackerPage, setTrackerPage,
    combatState, setCombatState, clearCombatState,
    addCombatInstance, removeCombatInstance, setInstanceHp, setInstanceInitiative,
    addInstanceCondition, removeInstanceCondition, tickDurations,
  };
})();
