// tracker.js — the adventure tracker. Generic over any adventure object
// shaped like data.adventures[<id>] (name/description/themes/locations/
// phases/scenes/cast); "Exorcism of Mikko" is the first content module,
// not baked into this code — a second adventure just needs a second key
// under data.adventures and a nav entry pointing at the same render fn.
//
// Presented as a page-through book: one scene per page (grouped/jumped-to
// by phase via a mini-map), not one long scroll — the phase/scene
// structure itself (data.adventures[<id>].phases/scenes) is untouched,
// this only changes how it's paged through.
window.AxisTracker = (function () {
  const { el, markdownish, resolveEntity } = window.AxisRender;
  const State = window.AxisState;

  function findScene(scenes, hash) {
    return scenes.find((s) => s.hash === hash);
  }

  // Flattens phases/scenes (plus any orphan scenes no phase references)
  // into one ordered page list: [{ phaseName, scene }]. This is the ONLY
  // place that imposes a page order — it's derived from the source's own
  // FLOW-authored phase order and scene_hashes order, never invented.
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

  function sceneBody(adventureId, scene, adversaries, npcs) {
    const st = State.sceneState(adventureId, scene.hash);
    const bodyWrap = el('div', { class: 'scene-body' });

    if (scene.location) bodyWrap.appendChild(el('div', { class: 'view-sub' }, ['Location: ' + scene.location]));
    if (scene.description) bodyWrap.appendChild(el('div', { html: markdownish(scene.description) }));
    (scene.read_aloud || []).forEach((t) => bodyWrap.appendChild(el('div', { class: 'read-aloud' }, [t])));
    (scene.checks || []).forEach((c) =>
      bodyWrap.appendChild(el('div', { class: 'check-line' }, [el('b', {}, [`DC ${c.dc} ${c.skill}`]), ` — ${c.on_success || ''}`]))
    );
    (scene.clues || []).forEach((c) =>
      bodyWrap.appendChild(el('div', { class: 'clue-line' }, [el('b', {}, [c.name + ': ']), c.description || '']))
    );
    if (scene.conflict) {
      const opp = (scene.conflict.opponents || [])
        .map((h) => {
          const found = resolveEntity(h, adversaries, npcs);
          return found ? found.name : h;
        })
        .join(', ');
      bodyWrap.appendChild(
        el('div', { class: 'check-line' }, [el('b', {}, ['Conflict: ']), `${scene.conflict.stakes || ''}${opp ? ' — opponents: ' + opp : ''}`])
      );
      // Per-instance GM overrides: this adversary AS IT APPEARS IN THIS
      // SCENE, not a global edit to the adversary catalog entry — a table
      // that fights the same monster type twice can track them separately.
      (scene.conflict.opponents || []).forEach((h) => {
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

  // GM-state export/import: adventure tracker progress (scene checkboxes/
  // notes) plus per-scene adversary-instance overrides — a SEPARATE file
  // from the party export (see party.js / state.js), by design.
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

  function render(container, adventureId, adventure, adversaries, npcs) {
    container.innerHTML = '';
    const totalScenes = adventure.scenes.length;
    const prog = State.adventureProgress(adventureId, totalScenes);
    const pages = buildPages(adventure);

    let pageIndex = State.trackerPage(adventureId);
    if (pageIndex < 0 || pageIndex >= pages.length) pageIndex = 0;
    let playModeOn = false;

    container.appendChild(
      el('div', { class: 'view-header' }, [
        el('h1', {}, [adventure.name || 'Adventure']),
        el('div', { class: 'view-sub' }, [`${prog.done} / ${prog.total} scenes marked done`]),
      ])
    );
    container.appendChild(
      el('div', { class: 'progress-bar' }, [el('div', { style: `width:${totalScenes ? (100 * prog.done) / totalScenes : 0}%` })])
    );
    container.appendChild(gmStateFileRow());
    if (adventure.description) container.appendChild(el('div', { html: markdownish(adventure.description) }));

    if (adventure.themes && adventure.themes.length) {
      container.appendChild(el('h2', {}, ['Themes']));
      container.appendChild(el('ul', { class: 'themes-list' }, adventure.themes.map((t) => el('li', {}, [t]))));
    }

    // ── page-picker mini-map: grouped by phase, jump directly to any
    // scene rather than only stepping linearly — a GM at the table needs
    // to jump around, not just page forward. ──────────────────────────
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
      const done = State.sceneState(adventureId, p.scene.hash).done;
      const btn = el(
        'button',
        { class: 'page-dot' + (idx === pageIndex ? ' active' : '') + (done ? ' done' : ''), title: p.scene.name },
        [String(idx + 1)]
      );
      btn.addEventListener('click', () => goToPage(idx));
      phaseRow.appendChild(btn);
    });

    // ── prev/next + current page name ─────────────────────────────────
    const prevBtn = el('button', { class: 'btn' }, ['◀ Prev']);
    const nextBtn = el('button', { class: 'btn' }, ['Next ▶']);
    const pageLabel = el('div', { class: 'page-label' });
    prevBtn.addEventListener('click', () => goToPage(pageIndex - 1));
    nextBtn.addEventListener('click', () => goToPage(pageIndex + 1));
    const pagerRow = el('div', { class: 'pager-row' }, [prevBtn, pageLabel, nextBtn]);

    const pageContent = el('div', {});

    container.appendChild(pickerWrap);
    container.appendChild(pagerRow);
    container.appendChild(pageContent);

    function goToPage(idx) {
      if (idx < 0 || idx >= pages.length) return;
      pageIndex = idx;
      playModeOn = false;
      State.setTrackerPage(adventureId, pageIndex);
      renderPage();
    }

    function renderPage() {
      pageContent.innerHTML = '';
      pickerWrap.querySelectorAll('.page-dot').forEach((b, i) => {
        // page-dot buttons are appended in page order across all phase
        // rows, so a flat NodeList index lines up with `pages` index.
      });
      // refresh active/done styling on the picker without a full rebuild
      Array.from(pickerWrap.querySelectorAll('.page-dot')).forEach((b, i) => {
        const done = State.sceneState(adventureId, pages[i].scene.hash).done;
        b.classList.toggle('active', i === pageIndex);
        b.classList.toggle('done', done);
      });

      if (!pages.length) {
        pageContent.appendChild(el('div', { class: 'view-sub' }, ['This adventure has no scenes yet.']));
        pageLabel.textContent = '';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }

      const page = pages[pageIndex];
      const scene = page.scene;
      pageLabel.textContent = `${page.phaseName} — Scene ${pageIndex + 1} of ${pages.length}: ${scene.name}`;
      prevBtn.disabled = pageIndex === 0;
      nextBtn.disabled = pageIndex === pages.length - 1;

      const st = State.sceneState(adventureId, scene.hash);
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = st.done;
      checkbox.addEventListener('change', () => {
        State.setSceneDone(adventureId, scene.hash, checkbox.checked);
        card.classList.toggle('done', checkbox.checked);
        const dot = pickerWrap.querySelectorAll('.page-dot')[pageIndex];
        if (dot) dot.classList.toggle('done', checkbox.checked);
      });

      const hasOpponents = !!(scene.conflict && scene.conflict.opponents && scene.conflict.opponents.length);
      const runBtn = el('button', { class: 'btn' + (playModeOn ? '' : ' btn-ghost') }, [playModeOn ? 'Back to Scene' : 'Run Encounter ▶']);
      runBtn.hidden = !hasOpponents;
      runBtn.addEventListener('click', () => {
        playModeOn = !playModeOn;
        renderPage();
      });

      const header = el('div', { class: 'scene-header page-scene-header' }, [
        checkbox,
        el('h3', {}, [scene.name]),
        scene.type ? el('span', { class: 'view-sub' }, [scene.type]) : null,
        runBtn,
      ]);

      var card = el('div', { class: 'scene-card page-scene-card' + (st.done ? ' done' : '') }, [header]);

      if (playModeOn && hasOpponents && window.AxisPlayMode) {
        const playWrap = el('div', { class: 'play-mode-wrap' });
        card.appendChild(playWrap);
        window.AxisPlayMode.render(playWrap, adventureId, scene, adversaries, npcs);
      } else {
        card.appendChild(sceneBody(adventureId, scene, adversaries, npcs));
      }

      pageContent.appendChild(card);
    }

    renderPage();
  }

  return { render };
})();
