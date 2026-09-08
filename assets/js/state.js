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

  return { state, save, sceneState, setSceneDone, setSceneNotes, adventureProgress };
})();
