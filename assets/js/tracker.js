// tracker.js — the adventure tracker. Generic over any adventure object
// shaped like data.adventures[<id>] (name/description/themes/locations/
// phases/scenes/cast); "Exorcism of Mikko" is the first content module,
// not baked into this code — a second adventure just needs a second key
// under data.adventures and a nav entry pointing at the same render fn.
window.AxisTracker = (function () {
  const { el, markdownish } = window.AxisRender;
  const State = window.AxisState;

  function findScene(scenes, hash) {
    return scenes.find((s) => s.hash === hash);
  }

  function findAdversary(hash, adversaries, npcs) {
    const a = adversaries.find((x) => x.hash === hash);
    if (a) return { kind: 'adversary', row: a };
    const n = npcs.find((x) => x.hash === hash || x.linked_to === hash);
    if (n) return { kind: 'npc', row: n };
    return null;
  }

  function sceneCard(adventureId, scene, adversaries, npcs) {
    const st = State.sceneState(adventureId, scene.hash);
    const bodyWrap = el('div', { class: 'scene-body' });
    bodyWrap.hidden = !expanded.has(scene.hash);

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
          const found = findAdversary(h, adversaries, npcs);
          return found ? found.row.name : h;
        })
        .join(', ');
      bodyWrap.appendChild(
        el('div', { class: 'check-line' }, [el('b', {}, ['Conflict: ']), `${scene.conflict.stakes || ''}${opp ? ' — opponents: ' + opp : ''}`])
      );
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

    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = st.done;
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      State.setSceneDone(adventureId, scene.hash, checkbox.checked);
      card.classList.toggle('done', checkbox.checked);
    });

    const header = el('div', { class: 'scene-header', onclick: () => toggle(scene.hash, card, bodyWrap) }, [
      checkbox,
      el('h3', {}, [scene.name]),
      scene.type ? el('span', { class: 'view-sub' }, [scene.type]) : null,
    ]);

    var card = el('div', { class: 'scene-card' + (st.done ? ' done' : '') }, [header, bodyWrap]);
    return card;
  }

  const expanded = new Set();
  function toggle(hash, card, bodyWrap) {
    if (expanded.has(hash)) expanded.delete(hash);
    else expanded.add(hash);
    bodyWrap.hidden = !expanded.has(hash);
  }

  function render(container, adventureId, adventure, adversaries, npcs) {
    container.innerHTML = '';
    const totalScenes = adventure.scenes.length;
    const prog = State.adventureProgress(adventureId, totalScenes);

    container.appendChild(
      el('div', { class: 'view-header' }, [
        el('h1', {}, [adventure.name || 'Adventure']),
        el('div', { class: 'view-sub' }, [`${prog.done} / ${prog.total} scenes marked done`]),
      ])
    );
    container.appendChild(
      el('div', { class: 'progress-bar' }, [el('div', { style: `width:${totalScenes ? (100 * prog.done) / totalScenes : 0}%` })])
    );
    if (adventure.description) container.appendChild(el('div', { html: markdownish(adventure.description) }));

    if (adventure.themes && adventure.themes.length) {
      container.appendChild(el('h2', {}, ['Themes']));
      container.appendChild(el('ul', { class: 'themes-list' }, adventure.themes.map((t) => el('li', {}, [t]))));
    }

    (adventure.phases || []).forEach((phase) => {
      const scenes = (phase.scene_hashes || []).map((h) => findScene(adventure.scenes, h)).filter(Boolean);
      const doneCount = scenes.filter((s) => State.sceneState(adventureId, s.hash).done).length;
      const block = el('div', { class: 'phase-block' }, [
        el('div', { class: 'phase-title' }, [el('h2', {}, [phase.name]), el('span', { class: 'view-sub' }, [`${doneCount}/${scenes.length}`])]),
        phase.description ? el('div', { class: 'phase-desc' }, [phase.description]) : null,
        ...scenes.map((s) => sceneCard(adventureId, s, adversaries, npcs)),
      ]);
      container.appendChild(block);
    });

    // scenes not referenced by any phase (defensive — should not happen, but
    // never let content silently disappear from the tracker)
    const referenced = new Set();
    (adventure.phases || []).forEach((p) => (p.scene_hashes || []).forEach((h) => referenced.add(h)));
    const orphans = adventure.scenes.filter((s) => !referenced.has(s.hash));
    if (orphans.length) {
      container.appendChild(el('h2', {}, ['Other scenes']));
      orphans.forEach((s) => container.appendChild(sceneCard(adventureId, s, adversaries, npcs)));
    }
  }

  return { render };
})();
