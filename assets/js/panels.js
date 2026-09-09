// panels.js — the panel registry and the two panels that only make sense
// in a tiled layout (Inspector, and the selection model it reads).
//
// A panel is { label, render(container, ctx) }. `ctx` is per mount:
//   ctx.on(type, fn)   subscribe to the bus; dropped automatically when the
//                      tile is torn down, so re-rendering a layout never
//                      leaks handlers
//   ctx.navigate(id)   ask the shell to show another panel
// Every existing view (party, catalogs, lore, …) is wrapped here unchanged;
// tracker/scene are the two halves of the old Adventure Tracker.
window.AxisPanels = (function () {
  const { el, statBlock, propList, markdownish, resolveEntity, fmtMod } = window.AxisRender;
  const State = window.AxisState;
  const Bus = window.AxisBus;
  const data = window.AXIS;

  // First adventure module is the active one. A campaign switcher is the
  // point at which this becomes state rather than a constant.
  const adventureId = Object.keys(data.adventures)[0];
  const adventure = data.adventures[adventureId];

  // ── selection ──────────────────────────────────────────────────────
  // Shapes (kind → fields):
  //   instance  { adventureId, sceneHash, instanceId }   a live combatant
  //   ref       { ref }            an opponent hash from scene.conflict
  //   party     { id }             a party member
  //   entity    { bucket, hash }   any catalog row
  //   location  { name }           an adventure location
  let current = null;

  function select(sel) {
    current = sel;
    Bus.emit('select', sel);
  }

  function selection() {
    return current;
  }

  // Selections from another window (a token click in the VTT) land here too.
  Bus.on('select', (sel, meta) => {
    if (meta && meta.remote) current = sel;
  });

  function hasInspector() {
    return !!(window.AxisLayout && window.AxisLayout.mounted().indexOf('inspector') !== -1);
  }

  // ── ctx ────────────────────────────────────────────────────────────
  function makeCtx(navigate) {
    const subs = [];
    return {
      on(type, fn) {
        subs.push(Bus.on(type, fn));
      },
      navigate: navigate || ((id) => window.AxisApp && window.AxisApp.open(id)),
      teardown() {
        subs.splice(0).forEach((u) => u());
      },
    };
  }

  // ── inspector ──────────────────────────────────────────────────────
  function partySummary(member, live) {
    const s = member.snapshot || {};
    const hp = live ? live.hpCurrent : member.gm.hpCurrent;
    const rows = [];
    const line = (k, v) => rows.push(el('div', { class: 'stat-row' }, [el('b', {}, [k + ': ']), String(v)]));
    if (s.race || s.classLine || s.classes) line('Character', [s.race, s.classLine || (Array.isArray(s.classes) ? s.classes.map((c) => c.name + ' ' + c.level).join(' / ') : s.classes)].filter(Boolean).join(' · '));
    line('HP', `${hp != null ? hp : '—'} / ${s.hpMax != null ? s.hpMax : '—'}`);
    if (s.ac != null) line('AC', s.ac);
    if (s.proficiencyBonus != null) line('Proficiency', fmtMod(s.proficiencyBonus));
    if (s.abilityScores || s.abilityMods) {
      const names = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
      rows.push(
        el('div', { class: 'ability-grid' }, names.map((n) => {
          const score = s.abilityScores ? s.abilityScores[n] : null;
          const mod = s.abilityMods ? s.abilityMods[n] : null;
          return el('div', { class: 'ability' }, [el('div', { class: 'ab-name' }, [n.slice(0, 3).toUpperCase()]), el('div', { class: 'ab-score' }, [score != null ? String(score) : '—']), el('div', { class: 'ab-mod' }, [fmtMod(mod)])]);
        }))
      );
    }
    const conds = live ? (live.conditions || []).map((c) => c.name + (c.duration != null ? ` (${c.duration}r)` : '')) : member.gm.conditions || [];
    if (conds.length) line('Conditions', conds.join(', '));
    if (member.gm.notes) rows.push(el('div', { class: 'read-aloud' }, [member.gm.notes]));
    return el('div', {}, [el('h2', {}, [s.name || 'Character']), ...rows]);
  }

  function liveHeader(inst) {
    const conds = (inst.conditions || []).map((c) => c.name + (c.duration != null ? ` (${c.duration}r)` : ''));
    return el('div', { class: 'inspector-live' }, [
      el('span', { class: 'chip' }, [`HP ${inst.hpCurrent != null ? inst.hpCurrent : '—'}${inst.hpMax != null ? ' / ' + inst.hpMax : ''}`]),
      inst.initiative != null ? el('span', { class: 'chip' }, [`Init ${inst.initiative}`]) : null,
      ...conds.map((c) => el('span', { class: 'chip condition-chip' }, [c])),
    ]);
  }

  function renderSelection(container, sel) {
    container.innerHTML = '';
    if (!sel) {
      container.appendChild(el('div', { class: 'inspector-empty' }, ['Nothing selected. Click a combatant, an opponent, a location, or any catalog entry.']));
      return;
    }
    let node = null;
    if (sel.kind === 'instance') {
      const combat = State.combatState(sel.adventureId, sel.sceneHash);
      const inst = combat && (combat.instances || []).find((i) => i.instanceId === sel.instanceId);
      if (!inst) {
        node = el('div', { class: 'inspector-empty' }, ['That combatant is no longer on the roster.']);
      } else if (inst.sourceKind === 'party') {
        const m = (State.state.party || []).find((mm) => mm.id === inst.defRef);
        node = m ? partySummary(m, inst) : el('div', { class: 'inspector-empty' }, ['Party member not found.']);
      } else if (inst.sourceKind === 'companion') {
        const c = State.companionFor(inst.defRef);
        node = c
          ? el('div', {}, [el('h2', {}, [inst.displayName]), el('div', { class: 'view-sub' }, [`${c.companion.group} of ${c.member.snapshot.name}`]), liveHeader(inst), statBlock(c.companion.name, c.companion.statblock, c.companion.features)])
          : el('div', { class: 'inspector-empty' }, ['Companion not found.']);
      } else {
        const found = resolveEntity(inst.defRef, data.adversaries, data.npcs);
        node = el('div', {}, [
          el('h2', {}, [inst.displayName]),
          liveHeader(inst),
          found ? statBlock(found.name, found.properties, found.features) : el('div', { class: 'inspector-empty' }, ['No stat block resolved for ' + inst.defRef]),
        ]);
      }
    } else if (sel.kind === 'ref') {
      const found = resolveEntity(sel.ref, data.adversaries, data.npcs);
      node = found ? statBlock(found.name, found.properties, found.features) : el('div', { class: 'inspector-empty' }, ['Unresolved reference ' + sel.ref]);
    } else if (sel.kind === 'party') {
      const m = (State.state.party || []).find((mm) => mm.id === sel.id);
      node = m ? partySummary(m, null) : el('div', { class: 'inspector-empty' }, ['Party member not found.']);
    } else if (sel.kind === 'entity') {
      const rows = data[sel.bucket] || [];
      const row = rows.find((r) => r.hash === sel.hash) || rows.find((r) => r.name === sel.name);
      if (!row) node = el('div', { class: 'inspector-empty' }, ['Entry not found.']);
      else if (sel.bucket === 'adversaries') node = statBlock(row.name, row.properties, row.features);
      else if (sel.bucket === 'npcs') node = row.statblock ? statBlock(row.name, row.statblock, row.features) : el('div', {}, [el('h2', {}, [row.name]), propList(row.profile || {}, ['Name'])]);
      else node = el('div', {}, [el('h2', {}, [row.name]), row.extends ? el('div', { class: 'view-sub' }, [row.extends]) : null, propList(row.properties, ['Name'])]);
    } else if (sel.kind === 'location') {
      const loc = (adventure.locations || []).find((l) => l.name === sel.name);
      const scenesHere = (adventure.scenes || []).filter((s) => s.location === sel.name);
      node = el('div', {}, [
        el('h2', {}, [sel.name]),
        loc && loc.description ? el('div', { html: markdownish(loc.description) }) : el('div', { class: 'inspector-empty' }, ['No description on file for this location.']),
        scenesHere.length ? el('div', { class: 'view-sub' }, ['Scenes here: ' + scenesHere.map((s) => s.name).join(', ')]) : null,
      ]);
    } else {
      node = el('div', { class: 'inspector-empty' }, ['Unknown selection.']);
    }
    container.appendChild(node);
  }

  function renderInspector(container, ctx) {
    container.innerHTML = '';
    const body = el('div', { class: 'inspector' });
    container.appendChild(body);
    const draw = () => renderSelection(body, current);
    ctx.on('select', draw);
    // HP/conditions of a selected combatant change under us during a fight.
    ctx.on('state:changed', () => {
      if (current && (current.kind === 'instance' || current.kind === 'party')) draw();
    });
    draw();
  }

  // ── registry ───────────────────────────────────────────────────────
  const catalog = (bucket, label) => ({
    label,
    count: () => data[bucket].length,
    render: (c) => window.AxisCatalog.render(c, bucket, data[bucket]),
  });

  const PANELS = {
    dashboard: { label: 'Dashboard', render: (c, ctx) => window.AxisDashboard.render(c, data, ctx.navigate) },
    tracker: { label: 'Adventure Tracker', render: (c, ctx) => window.AxisTracker.renderTracker(c, adventureId, adventure, data.adversaries, data.npcs, ctx) },
    scene: { label: 'Scene / Encounter', render: (c, ctx) => window.AxisTracker.renderScene(c, adventureId, adventure, data.adversaries, data.npcs, ctx) },
    inspector: { label: 'Inspector', render: renderInspector },
    party: { label: 'Party', count: () => State.state.party.length, render: (c) => window.AxisParty.render(c) },
    npcs: { label: 'NPCs', count: () => data.npcs.length, render: (c) => window.AxisNpcs.render(c, data.npcs) },
    adversaries: catalog('adversaries', 'Adversaries'),
    spells: catalog('spells', 'Spells'),
    items: catalog('items', 'Items'),
    subclasses: catalog('subclasses', 'Subclasses'),
    artifacts: catalog('artifacts', 'Artifacts'),
    rules: catalog('rules', 'Rules Glossary'),
    lore: { label: 'Lore', count: () => data.lore.length, render: (c) => window.AxisLore.render(c, data.lore) },
  };

  // Sidebar order; tile pickers use the same list.
  const ORDER = ['dashboard', 'tracker', 'scene', 'inspector', 'party', 'npcs', 'adversaries', 'spells', 'items', 'subclasses', 'artifacts', 'rules', 'lore'];

  function list() {
    return ORDER.map((id) => ({ id, label: PANELS[id].label, count: PANELS[id].count }));
  }

  function mount(container, id, ctx) {
    const p = PANELS[id];
    if (!p) {
      container.innerHTML = '';
      container.appendChild(el('div', { class: 'inspector-empty' }, ['Unknown panel: ' + id]));
      return;
    }
    p.render(container, ctx);
  }

  return { PANELS, list, mount, makeCtx, select, selection, hasInspector, adventureId };
})();
