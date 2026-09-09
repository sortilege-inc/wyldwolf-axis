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

  // Source order: the FLOW's phases, then any scene no phase references.
  function sourcePages(adventure) {
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

  function adventureIdOf(adventure) {
    const advs = (window.AXIS && window.AXIS.adventures) || {};
    return Object.keys(advs).find((k) => advs[k] === adventure) || null;
  }

  // The GM may reorder and nest (State.sceneOrder: [{ h, p }] in
  // depth-first order). Each scene keeps its source phase as its label;
  // a child's depth is its parent's + 1 when the parent appears earlier,
  // otherwise it is a root. Scenes missing from a saved order go to the
  // end; hashes that no longer exist are dropped.
  function buildPages(adventure) {
    const base = sourcePages(adventure).map((p) => Object.assign({ depth: 0, parent: null }, p));
    const id = adventureIdOf(adventure);
    const order = id && State.sceneOrder ? State.sceneOrder(id) : null;
    if (!order || !order.length) return base;
    const byHash = {};
    base.forEach((p) => (byHash[p.scene.hash] = p));
    const out = [];
    const depthOf = {};
    order.forEach((e) => {
      const h = typeof e === 'string' ? e : e.h;
      const parent = typeof e === 'string' ? null : e.p || null;
      const p = byHash[h];
      if (!p) return;
      const d = parent && depthOf[parent] != null ? Math.min(3, depthOf[parent] + 1) : 0;
      depthOf[h] = d;
      out.push(Object.assign({}, p, { depth: d, parent: d ? parent : null }));
      delete byHash[h];
    });
    base.forEach((p) => {
      if (byHash[p.scene.hash]) out.push(p);
    });
    return out;
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
    let pages = buildPages(adventure);
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

    // Scene list: number, name, source phase; drag a row to reorder. The
    // order is shared state so the table and players page the same way.
    const pickerWrap = el('div', { class: 'page-picker' });
    let dragFrom = null;

    function keepCurrent(current) {
      pages = buildPages(adventure);
      const keep = pages.findIndex((p) => p.scene.hash === current.scene.hash);
      if (keep !== -1 && keep !== State.trackerPage(adventureId)) State.setTrackerPage(adventureId, keep);
      buildPicker();
      refresh();
    }

    // The order is a depth-first list of { h, p }. A move takes the
    // dragged scene WITH its descendants and puts the block before or
    // after the target (as the target's sibling) or inside it (as its
    // last child). Nesting is capped at three levels deep.
    function entriesNow() {
      return pages.map((p) => ({ h: p.scene.hash, p: p.parent || null }));
    }

    function subtree(entries, i) {
      const root = entries[i];
      const ids = new Set([root.h]);
      let j = i + 1;
      while (j < entries.length && entries[j].p && ids.has(entries[j].p)) {
        ids.add(entries[j].h);
        j++;
      }
      return entries.slice(i, j);
    }

    function lastOfSubtree(entries, i) {
      return i + subtree(entries, i).length - 1;
    }

    function move(from, to, where) {
      if (from == null || to == null || from === to) return;
      const current = pages[pageIndexFor(adventureId, pages)];
      let entries = entriesNow();
      const block = subtree(entries, from);
      if (block.some((e) => e.h === entries[to].h)) return; // can't drop into itself
      const target = entries[to];
      entries = entries.filter((e) => !block.some((b) => b.h === e.h));
      const ti = entries.findIndex((e) => e.h === target.h);
      let parent = target.p || null;
      let at = ti;
      if (where === 'after') at = lastOfSubtree(entries, ti) + 1;
      if (where === 'into') {
        parent = target.h;
        at = lastOfSubtree(entries, ti) + 1;
      }
      const depthOf = (h) => {
        let d = 0;
        let cur = entries.find((e) => e.h === h);
        while (cur && cur.p) {
          d++;
          cur = entries.find((e) => e.h === cur.p);
        }
        return d;
      };
      if (parent && depthOf(parent) >= 2) parent = entries.find((e) => e.h === parent).p || null; // cap depth
      block[0].p = parent;
      entries.splice(at, 0, ...block);
      State.setSceneOrder(adventureId, entries);
      keepCurrent(current);
    }

    function indent(idx, dir) {
      const entries = entriesNow();
      const me = entries[idx];
      if (dir > 0) {
        // become the last child of the previous sibling at my depth
        for (let i = idx - 1; i >= 0; i--) {
          if ((entries[i].p || null) === (me.p || null)) return move(idx, i, 'into');
          if (entries[i].h === me.p) return;
        }
      } else if (me.p) {
        // become a sibling of my parent, placed after its subtree
        const pi = entries.findIndex((e) => e.h === me.p);
        move(idx, pi, 'after');
      }
    }

    function buildPicker() {
      pickerWrap.innerHTML = '';
      let phaseCursor = null;
      pages.forEach((p, idx) => {
        if (p.depth === 0 && p.phaseName !== phaseCursor) {
          phaseCursor = p.phaseName;
          pickerWrap.appendChild(el('div', { class: 'page-picker-phase' }, [phaseCursor]));
        }
        const done = el('input', { type: 'checkbox', class: 'scene-row-done', title: 'Mark done' });
        done.checked = State.sceneState(adventureId, p.scene.hash).done;
        done.addEventListener('click', (e) => e.stopPropagation());
        done.addEventListener('change', () => State.setSceneDone(adventureId, p.scene.hash, done.checked));
        const outBtn = el('button', { class: 'scene-nest', type: 'button', title: 'Move out of parent' }, ['⇤']);
        const inBtn = el('button', { class: 'scene-nest', type: 'button', title: 'Nest under the scene above' }, ['⇥']);
        outBtn.hidden = !p.depth;
        inBtn.hidden = p.depth >= 3 || idx === 0;
        outBtn.addEventListener('click', (e) => { e.stopPropagation(); indent(idx, -1); });
        inBtn.addEventListener('click', (e) => { e.stopPropagation(); indent(idx, 1); });
        const row = el('div', { class: 'scene-row depth-' + p.depth, draggable: 'true', title: 'Drag to reorder · drop onto a scene to nest under it', style: `--depth:${p.depth}` }, [
          el('span', { class: 'scene-grip' }, ['⋮⋮']),
          done,
          el('span', { class: 'page-dot' }, [String(idx + 1)]),
          el('span', { class: 'scene-row-name' }, [p.scene.name]),
          p.scene.type ? el('span', { class: 'scene-row-type' }, [p.scene.type]) : null,
          outBtn,
          inBtn,
        ]);
        row.addEventListener('click', () => goToPage(adventureId, pages, idx));
        row.addEventListener('dragstart', (e) => {
          dragFrom = idx;
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          pickerWrap.querySelectorAll('.scene-row').forEach((r) => r.classList.remove('over-before', 'over-after', 'over-into'));
        });
        const zone = (e) => {
          const r = row.getBoundingClientRect();
          const f = (e.clientY - r.top) / r.height;
          return f < 0.3 ? 'before' : f > 0.7 ? 'after' : 'into';
        };
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const z = zone(e);
          row.classList.toggle('over-before', z === 'before');
          row.classList.toggle('over-after', z === 'after');
          row.classList.toggle('over-into', z === 'into');
        });
        row.addEventListener('dragleave', () => row.classList.remove('over-before', 'over-after', 'over-into'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          const from = dragFrom != null ? dragFrom : parseInt(e.dataTransfer.getData('text/plain'), 10);
          dragFrom = null;
          move(from, idx, zone(e));
        });
        pickerWrap.appendChild(row);
      });
      const reset = el('button', { class: 'btn btn-ghost' }, ['Restore source order']);
      reset.hidden = !State.sceneOrder(adventureId);
      reset.addEventListener('click', () => {
        const current = pages[pageIndexFor(adventureId, pages)];
        State.setSceneOrder(adventureId, null);
        keepCurrent(current);
      });
      pickerWrap.appendChild(el('div', { class: 'chiprow' }, [reset]));
    }
    buildPicker();

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
      Array.from(pickerWrap.querySelectorAll('.scene-row')).forEach((r, i) => {
        const isDone = State.sceneState(adventureId, pages[i].scene.hash).done;
        r.classList.toggle('active', i === idx);
        r.classList.toggle('done', isDone);
        const cb = r.querySelector('.scene-row-done');
        if (cb) cb.checked = isDone;
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
    ctx.on('state:changed', () => {
      // a reorder from another window rebuilds the list
      const fresh = buildPages(adventure);
      if (fresh.map((p) => p.scene.hash).join() !== pages.map((p) => p.scene.hash).join()) {
        pages = fresh;
        buildPicker();
      }
      refresh();
    });
    refresh();
  }

  // ── scene half ─────────────────────────────────────────────────────
  // Which scenes are in play mode. Survives re-renders (a remote HP change
  // must not kick the GM out of the encounter view); reset when the GM
  // navigates to a different scene.
  const playModeOn = {};

  function renderScene(container, adventureId, adventure, adversaries, npcs, ctx) {
    let pages = buildPages(adventure);

    function draw() {
      pages = buildPages(adventure);
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
        el('div', { class: 'view-sub' }, [`${page.phaseName} — Scene ${idx + 1} of ${pages.length}${page.parent ? ' · under ' + ((pages.find((q) => q.scene.hash === page.parent) || {}).scene || {}).name : ''}`]),
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
