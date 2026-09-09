// tracker.js — the adventure tracker, in two halves that share one piece of
// state (which scene is current, State.trackerPage):
//   renderTracker  overview, progress, GM-state file row, and the
//                  phase-grouped page picker — the navigation half
//   renderScene    the current scene's page: text, checks, opponents, GM
//                  notes, and Run Encounter — the content half
// render() stacks both for the single-panel (narrow) mode. Both halves are
// generic over any adventure shaped like data.adventures[<id>]; "Exorcism
// of Mikko" is the first content module, not baked in.
//
// Page order is derived from the source's own FLOW phase order and
// scene_hashes order, never invented (buildPages is the only place that
// imposes an order at all).
window.AxisTracker = (function () {
  const { el, markdownish, resolveEntity } = window.AxisRender;
  const State = window.AxisState;
  const Bus = window.AxisBus;

  function findScene(scenes, hash) {
    return scenes.find((s) => s.hash === hash);
  }

  function buildPages(adventure) {
    const pages = [];
    const referenced = new Set();
    (adventure.phases || []).forEach((phase) => {
      const scenes = (phase.scene_hashes || []).map((h) => findScene(adventure.scenes, h)).filter(Boolean);
      scenes.forEach((s) => {
        referenced.add(s.hash);
        pages.push({ phaseName: phase.name, scene: s });
      });
    });
    (adventure.scenes || []).forEach((s) => {
      if (!referenced.has(s.hash)) pages.push({ phaseName: 'Other scenes', scene: s });
    });
    return pages;
  }

  function pageIndexFor(adventureId, pages) {
    let idx = State.trackerPage(adventureId);
    if (idx < 0 || idx >= pages.length) idx = 0;
    return idx;
  }

  function goToPage(adventureId, pages, idx) {
    if (idx < 0 || idx >= pages.length) return;
    State.setTrackerPage(adventureId, idx);
    Bus.emit('scene:changed', { adventureId, sceneHash: pages[idx].scene.hash, pageIndex: idx });
  }

  function selectable(label, sel) {
    const b = el('button', { class: 'sel-link', type: 'button' }, [label]);
    b.addEventListener('click', () => window.AxisPanels.select(sel));
    return b;
  }

  // ── scene page body ────────────────────────────────────────────────
  function sceneBody(adventureId, scene, adversaries, npcs) {
    const st = State.sceneState(adventureId, scene.hash);
    const bodyWrap = el('div', { class: 'scene-body' });

    if (scene.location) bodyWrap.appendChild(el('div', { class: 'view-sub' }, ['Location: ', selectable(scene.location, { kind: 'location', name: scene.location })]));
    if (scene.description) bodyWrap.appendChild(el('div', { html: markdownish(scene.description) }));
    (scene.read_aloud || []).forEach((t) => bodyWrap.appendChild(el('div', { class: 'read-aloud' }, [t])));
    (scene.checks || []).forEach((c) =>
      bodyWrap.appendChild(el('div', { class: 'check-line' }, [el('b', {}, [`DC ${c.dc} ${c.skill}`]), ` — ${c.on_success || ''}`]))
    );
    (scene.clues || []).forEach((c) =>
      bodyWrap.appendChild(el('div', { class: 'clue-line' }, [el('b', {}, [c.name + ': ']), c.description || '']))
    );
    if (scene.conflict) {
      const opponents = scene.conflict.opponents || [];
      const oppNodes = [];
      opponents.forEach((h, i) => {
        const found = resolveEntity(h, adversaries, npcs);
        if (i) oppNodes.push(', ');
        oppNodes.push(selectable(found ? found.name : h, { kind: 'ref', ref: h }));
      });
      bodyWrap.appendChild(
        el('div', { class: 'check-line' }, [el('b', {}, ['Conflict: ']), scene.conflict.stakes || '', ...(oppNodes.length ? [' — opponents: ', ...oppNodes] : [])])
      );
      // Pre-encounter scene defaults: this adversary AS IT APPEARS IN THIS
      // SCENE. Once Run Encounter has seeded instances, those are the live
      // record (see state.js `combat`).
      opponents.forEach((h) => {
        const found = resolveEntity(h, adversaries, npcs);
        const label = found ? found.name : h;
        const baseHp = found && found.properties ? found.properties['Hit Points'] : null;
        const ov = State.encounterOverride(adventureId, scene.hash, h);
        const hpInput = el('input', { type: 'number', class: 'hp-current-input', placeholder: baseHp != null ? String(baseHp) : 'HP' });
        hpInput.value = ov.hpCurrent != null ? String(ov.hpCurrent) : '';
        hpInput.addEventListener('change', () => {
          const v = hpInput.value === '' ? null : parseInt(hpInput.value, 10);
          State.setEncounterOverride(adventureId, scene.hash, h, { hpCurrent: isNaN(v) ? null : v });
        });
        const noteInput = el('input', { type: 'text', class: 'conditions-input', placeholder: 'GM note (this instance only)' });
        noteInput.value = ov.notes || '';
        noteInput.addEventListener('change', () => State.setEncounterOverride(adventureId, scene.hash, h, { notes: noteInput.value }));
        bodyWrap.appendChild(
          el('div', { class: 'stat-row encounter-override' }, [
            el('b', {}, [label + ' — HP: ']),
            hpInput,
            baseHp != null ? el('span', {}, [` / ${baseHp}`]) : null,
            noteInput,
          ])
        );
      });
    }
    if (scene.objectives) {
      (scene.objectives.required || []).forEach((o) => bodyWrap.appendChild(el('div', { class: 'check-line' }, [el('b', {}, ['Required: ']), o])));
      (scene.objectives.optional || []).forEach((o) => bodyWrap.appendChild(el('div', { class: 'check-line' }, [el('b', {}, ['Optional: ']), o])));
    }
    (scene.resolutions || []).forEach((r) =>
      bodyWrap.appendChild(el('div', { class: 'check-line' }, [el('b', {}, [r.name + ': ']), r.outcome || '']))
    );

    const notes = el('textarea', { class: 'notes', placeholder: 'GM notes for this scene…' });
    notes.value = st.notes || '';
    notes.addEventListener('change', () => State.setSceneNotes(adventureId, scene.hash, notes.value));
    bodyWrap.appendChild(notes);

    return bodyWrap;
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // GM-state export/import: progress, per-scene overrides, live combat,
  // layout — a SEPARATE file from the party export, by design.
  function gmStateFileRow() {
    const exportBtn = el('button', { class: 'btn btn-ghost' }, ['Export GM state']);
    exportBtn.addEventListener('click', () => downloadJson(State.exportGmStateFile(), 'wyldwolf-axis-gm-state.json'));

    const fileInput = el('input', { type: 'file', accept: 'application/json', class: 'file-input-hidden' });
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          State.loadGmStateFile(parsed);
          location.reload();
        } catch (e) {
          alert('Could not load that GM-state file: ' + e.message);
        }
      };
      reader.readAsText(file);
      fileInput.value = '';
    });
    const importBtn = el('button', { class: 'btn btn-ghost' }, ['Import GM state']);
    importBtn.addEventListener('click', () => fileInput.click());

    return el('div', { class: 'chiprow' }, [exportBtn, importBtn, fileInput]);
  }

  // ── tracker half ───────────────────────────────────────────────────
  function renderTracker(container, adventureId, adventure, adversaries, npcs, ctx) {
    container.innerHTML = '';
    const pages = buildPages(adventure);
    const totalScenes = adventure.scenes.length;

    const progLabel = el('div', { class: 'view-sub' });
    const progBar = el('div', {});
    container.appendChild(el('div', { class: 'view-header' }, [el('h1', {}, [adventure.name || 'Adventure']), progLabel]));
    container.appendChild(el('div', { class: 'progress-bar' }, [progBar]));
    container.appendChild(gmStateFileRow());
    if (adventure.description) container.appendChild(el('div', { html: markdownish(adventure.description) }));
    if (adventure.themes && adventure.themes.length) {
      container.appendChild(el('h2', {}, ['Themes']));
      container.appendChild(el('ul', { class: 'themes-list' }, adventure.themes.map((t) => el('li', {}, [t]))));
    }

    // phase-grouped picker: jump straight to any scene
    const pickerWrap = el('div', { class: 'page-picker' });
    let phaseCursor = null;
    let phaseRow = null;
    pages.forEach((p, idx) => {
      if (p.phaseName !== phaseCursor) {
        phaseCursor = p.phaseName;
        pickerWrap.appendChild(el('div', { class: 'page-picker-phase' }, [phaseCursor]));
        phaseRow = el('div', { class: 'page-picker-row' });
        pickerWrap.appendChild(phaseRow);
      }
      const btn = el('button', { class: 'page-dot', title: p.scene.name }, [String(idx + 1)]);
      btn.addEventListener('click', () => goToPage(adventureId, pages, idx));
      phaseRow.appendChild(btn);
    });

    const prevBtn = el('button', { class: 'btn' }, ['◀ Prev']);
    const nextBtn = el('button', { class: 'btn' }, ['Next ▶']);
    const pageLabel = el('div', { class: 'page-label' });
    prevBtn.addEventListener('click', () => goToPage(adventureId, pages, pageIndexFor(adventureId, pages) - 1));
    nextBtn.addEventListener('click', () => goToPage(adventureId, pages, pageIndexFor(adventureId, pages) + 1));

    container.appendChild(pickerWrap);
    container.appendChild(el('div', { class: 'pager-row' }, [prevBtn, pageLabel, nextBtn]));

    function refresh() {
      const idx = pageIndexFor(adventureId, pages);
      const prog = State.adventureProgress(adventureId, totalScenes);
      progLabel.textContent = `${prog.done} / ${prog.total} scenes marked done`;
      progBar.style.width = `${totalScenes ? (100 * prog.done) / totalScenes : 0}%`;
      Array.from(pickerWrap.querySelectorAll('.page-dot')).forEach((b, i) => {
        b.classList.toggle('active', i === idx);
        b.classList.toggle('done', State.sceneState(adventureId, pages[i].scene.hash).done);
      });
      if (!pages.length) {
        pageLabel.textContent = '';
        prevBtn.disabled = nextBtn.disabled = true;
        return;
      }
      pageLabel.textContent = `${pages[idx].phaseName} — Scene ${idx + 1} of ${pages.length}: ${pages[idx].scene.name}`;
      prevBtn.disabled = idx === 0;
      nextBtn.disabled = idx === pages.length - 1;
    }

    ctx.on('scene:changed', refresh);
    ctx.on('state:changed', refresh); // done-marks, progress
    refresh();
  }

  // ── scene half ─────────────────────────────────────────────────────
  // Which scenes are in play mode. Survives re-renders (a remote HP change
  // must not kick the GM out of the encounter view); reset when the GM
  // navigates to a different scene.
  const playModeOn = {};

  function renderScene(container, adventureId, adventure, adversaries, npcs, ctx) {
    const pages = buildPages(adventure);

    function draw() {
      container.innerHTML = '';
      if (!pages.length) {
        container.appendChild(el('div', { class: 'view-sub' }, ['This adventure has no scenes yet.']));
        return;
      }
      const idx = pageIndexFor(adventureId, pages);
      const page = pages[idx];
      const scene = page.scene;
      const st = State.sceneState(adventureId, scene.hash);

      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = st.done;
      checkbox.addEventListener('change', () => {
        State.setSceneDone(adventureId, scene.hash, checkbox.checked);
        card.classList.toggle('done', checkbox.checked);
      });

      const hasOpponents = !!(scene.conflict && scene.conflict.opponents && scene.conflict.opponents.length);
      const on = !!playModeOn[scene.hash];
      const runBtn = el('button', { class: 'btn' + (on ? '' : ' btn-ghost') }, [on ? 'Back to Scene' : 'Run Encounter ▶']);
      runBtn.hidden = !hasOpponents;
      runBtn.addEventListener('click', () => {
        playModeOn[scene.hash] = !on;
        draw();
      });

      const header = el('div', { class: 'scene-header page-scene-header' }, [
        checkbox,
        el('h3', {}, [scene.name]),
        scene.type ? el('span', { class: 'view-sub' }, [scene.type]) : null,
        runBtn,
      ]);
      const card = el('div', { class: 'scene-card page-scene-card' + (st.done ? ' done' : '') }, [
        el('div', { class: 'view-sub' }, [`${page.phaseName} — Scene ${idx + 1} of ${pages.length}`]),
        header,
      ]);

      if (on && hasOpponents && window.AxisPlayMode) {
        const playWrap = el('div', { class: 'play-mode-wrap' });
        card.appendChild(playWrap);
        window.AxisPlayMode.render(playWrap, adventureId, scene, adversaries, npcs);
      } else {
        card.appendChild(sceneBody(adventureId, scene, adversaries, npcs));
      }
      container.appendChild(card);
    }

    ctx.on('scene:changed', (p) => {
      if (p && p.adventureId === adventureId) draw();
    });
    // Only *other* windows' changes redraw the scene: local edits already
    // updated the DOM they came from, and a redraw would eat input focus.
    ctx.on('state:changed', (p, meta) => {
      if (meta && meta.remote) draw();
    });
    // …and ops that arrived over the session socket (a player's edit).
    ctx.on('state:remote', draw);
    draw();
  }

  // Single-panel mode: both halves stacked.
  function render(container, adventureId, adventure, adversaries, npcs, ctx) {
    container.innerHTML = '';
    const top = el('div', {});
    const bottom = el('div', { class: 'scene-stack' });
    container.appendChild(top);
    container.appendChild(bottom);
    renderTracker(top, adventureId, adventure, adversaries, npcs, ctx);
    renderScene(bottom, adventureId, adventure, adversaries, npcs, ctx);
  }

  return { render, renderTracker, renderScene, buildPages };
})();
