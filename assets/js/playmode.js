// playmode.js — "Run Encounter" live-play panel for a single scene, in the
// spirit of Portents & Fortunes' play/sheet.js (a roller embedded in the
// data view itself) but for D&D 5e: d20+mod rolls, not Roll & Keep.
//
// ARCHITECTURE (instance-based roster — see the `combat` shape documented
// in state.js's defaults()): once a GM hits "Run Encounter", State.combat
// holds one row per PHYSICAL combatant instance, not one row per unique
// adversary DEF. This is what lets three Cultists from the same statblock
// be tracked as three separate creatures with separate HP/conditions/
// initiative. The instance list is seeded from the scene's party + default
// conflict.opponents on first render, then the GM can add/remove ANY party
// member or ANY adversary (via search) at any time — the roster is no
// longer locked to the scene's pre-authored opponent list.
//
// Reconciliation with pre-existing per-scene state (deliberate call):
//   - encounterOverrides (scene+DEF-hash keyed) is now read ONLY as the
//     "scene default" HP a fresh instance seeds from when first added —
//     it is a pre-encounter nudge, not the live HP store any more. Once an
//     instance exists, only the instance's own hpCurrent is read/written.
//   - party[].gm.hpCurrent stays authoritative for the Party tab; an
//     active party instance mirrors both ways (see State.setInstanceHp).
window.AxisPlayMode = (function () {
  const { el, esc, fmtMod, markdownish, propList, drawer, resolveEntity } = window.AxisRender;
  const State = window.AxisState;
  // NOT captured at module-eval time: playmode.js loads (via index.html's
  // script order) before data/data.js, so window.AXIS is still undefined
  // when this IIFE runs. Every use below reads window.AXIS fresh instead.

  const CONDITION_NAMES = [
    'Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled',
    'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned',
    'Prone', 'Restrained', 'Stunned', 'Unconscious',
  ];

  function rollDie(sides) {
    return 1 + Math.floor(Math.random() * sides);
  }

  // Parses a dice expression like "2d6+5" or "1d12" — the shape D&D 5e
  // damage lines are always printed in.
  function rollDiceExpr(expr) {
    const m = /^(\d+)d(\d+)\s*([+-]\s*\d+)?$/i.exec(String(expr).replace(/\s+/g, ''));
    if (!m) return { total: null, detail: expr };
    const n = parseInt(m[1], 10);
    const sides = parseInt(m[2], 10);
    const mod = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0;
    const rolls = [];
    for (let i = 0; i < n; i++) rolls.push(rollDie(sides));
    const total = rolls.reduce((a, b) => a + b, 0) + mod;
    return { total, detail: `[${rolls.join(', ')}]${mod ? (mod >= 0 ? '+' + mod : mod) : ''}` };
  }

  function abilityModFromScore(score) {
    const n = parseInt(score, 10);
    if (isNaN(n)) return 0;
    return Math.floor((n - 10) / 2);
  }

  // Pulls the adversary's DEX mod straight from the same properties shape
  // render.js's statBlock() already reads (props.Abilities.Dexterity) — no
  // re-parsing of a different representation.
  function adversaryDexMod(properties) {
    const dex = properties && properties.Abilities && properties.Abilities.Dexterity;
    return dex != null ? abilityModFromScore(dex) : 0;
  }

  // Pulls rollable actions out of the SAME `features` list render.js's
  // statBlock() already renders (name/category/description) — this does
  // not re-parse the stat block from raw text, it just looks for the
  // printed "Melee/Ranged Attack Roll: +N" and a "(NdM[+K]) <type> damage"
  // clause the 5.5e SRD statblock always prints for a weapon-style action.
  function parseRollableActions(features) {
    return (features || [])
      .filter((f) => f.category === 'Action' || f.category === 'Reaction' || f.category === 'Bonus Action')
      .map((f) => {
        const desc = f.description || '';
        const atkMatch = /Attack Roll:\s*\+\s*(\d+)/i.exec(desc) || /\+\s*(\d+)\s*to hit/i.exec(desc);
        const dmgMatch = /\(([\dd\s+-]+)\)\s*([A-Za-z]+)?\s*damage/i.exec(desc);
        return {
          name: f.name,
          description: desc,
          attackBonus: atkMatch ? parseInt(atkMatch[1], 10) : null,
          damageExpr: dmgMatch ? dmgMatch[1].replace(/\s+/g, '') : null,
          damageType: dmgMatch && dmgMatch[2] ? dmgMatch[2] : null,
        };
      });
  }

  // ── Spell-name extraction from a "Spellcasting" feature body ─────────
  // The merged corpus prints spell names in *italics* inside the feature
  // description (e.g. "*Acid Arrow* (level 3 version), *Detect Magic*").
  // Pull every *…* run that looks like a spell name (not a stray emphasis)
  // and match it case-insensitively against AXIS.spells by name; anything
  // with a trailing parenthetical like "(level 3 version)" is stripped
  // before matching. Judgment call: this is a best-effort regex parse, not
  // a guaranteed 100% match — see the hit-rate note in the final report.
  function extractSpellRefs(features) {
    const spellByLowerName = {};
    (window.AXIS.spells || []).forEach((s) => (spellByLowerName[s.name.toLowerCase()] = s));
    const refs = [];
    const seen = new Set();
    (features || [])
      .filter((f) => /spellcast/i.test(f.name || ''))
      .forEach((f) => {
        const desc = f.description || '';
        // Strip **bold** section headers ("At Will:", "1/Day Each:") FIRST
        // — matching single "*…*" italics against the raw text with bold
        // spans still in it consumes "*" pairs asymmetrically across a
        // "**Header:** *Spell*" boundary and produces garbage captures.
        const cleaned = desc.replace(/\*\*[^*]+\*\*/g, ' ');
        const matches = cleaned.match(/\*([^*]+)\*/g) || [];
        matches.forEach((raw) => {
          let name = raw.replace(/^\*+|\*+$/g, '').trim();
          name = name.replace(/\s*\([^)]*\)\s*$/, '').trim(); // strip "(level 3 version)"
          // Skip bold section headers the same **…** markup also matches
          // ("At Will:", "1/Day Each:", "3/Day:") — a spell name never
          // ends in a colon.
          if (!name || /:$/.test(name) || seen.has(name.toLowerCase())) return;
          seen.add(name.toLowerCase());
          const spell = spellByLowerName[name.toLowerCase()];
          refs.push({ rawName: name, spell: spell || null });
        });
      });
    return refs;
  }

  function spellPopover(ref) {
    if (!ref.spell) {
      drawer(el('div', {}, [
        el('h2', {}, [ref.rawName]),
        el('div', { class: 'view-sub' }, ['No matching entry found in the Spells catalog for this name.']),
      ]));
      return;
    }
    const s = ref.spell;
    drawer(el('div', {}, [
      el('h2', {}, [s.name]),
      s.extends ? el('div', { class: 'view-sub' }, [s.extends]) : null,
      propList(s.properties, ['Name']),
    ]));
  }

  // ── Instance seeding ──────────────────────────────────────────────────
  function displayNameFor(baseName, usedNames) {
    if (!usedNames[baseName]) {
      usedNames[baseName] = 1;
      return baseName;
    }
    usedNames[baseName] += 1;
    // Re-number: if this is the 2nd instance of a name that was previously
    // unnumbered, the first also needs renumbering — handled by caller
    // (buildSeedInstances) doing a two-pass count instead. This helper is
    // only used by the "add one more" path, where the base is already
    // known to be used at least once.
    return `${baseName} ${usedNames[baseName]}`;
  }

  function seedInstancesFromScene(adventureId, scene, adversaries, npcs) {
    const instances = [];
    const nameCounts = {};
    ((scene.conflict && scene.conflict.opponents) || []).forEach((h) => {
      nameCounts[h] = (nameCounts[h] || 0) + 1;
    });
    const seenSoFar = {};
    (State.state.party || []).forEach((m) => {
      instances.push({
        defRef: m.id,
        sourceKind: 'party',
        displayName: m.snapshot.name,
        hpMax: m.snapshot.hpMax,
        hpCurrent: m.gm.hpCurrent,
        initiative: null,
        conditions: [],
        notes: '',
      });
    });
    ((scene.conflict && scene.conflict.opponents) || []).forEach((h) => {
      const found = resolveEntity(h, adversaries, npcs);
      if (!found) return;
      const hpMax = found.properties ? found.properties['Hit Points'] : null;
      const ov = State.encounterOverride(adventureId, scene.hash, h);
      seenSoFar[h] = (seenSoFar[h] || 0) + 1;
      const displayName = nameCounts[h] > 1 ? `${found.name} ${seenSoFar[h]}` : found.name;
      instances.push({
        defRef: h,
        sourceKind: found.kind,
        displayName,
        hpMax,
        hpCurrent: ov.hpCurrent != null ? ov.hpCurrent : hpMax,
        initiative: null,
        conditions: [],
        notes: '',
      });
    });
    return instances;
  }

  // Adds one fresh instance of an already-resolved entity (adversary/NPC
  // row from the catalog, or a party member) to a running/not-yet-started
  // encounter, auto-numbering the display name against what's already on
  // the roster so "Cultist"/"Cultist 2"/"Cultist 3" reads unambiguously.
  function nextDisplayName(combat, baseName) {
    const existing = (combat.instances || []).filter((i) => i.displayName === baseName || new RegExp('^' + baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\d+$').test(i.displayName));
    if (!existing.length) return baseName;
    // Renumber the first existing plain-named instance to "N 1" once a
    // second is added, so the roster is never ambiguous.
    const plain = (combat.instances || []).find((i) => i.displayName === baseName);
    if (plain) plain.displayName = baseName + ' 1';
    let n = existing.length + 1;
    while ((combat.instances || []).some((i) => i.displayName === `${baseName} ${n}`)) n++;
    return `${baseName} ${n}`;
  }

  function hpStatusClass(inst) {
    if (inst.hpMax == null || inst.hpCurrent == null) return '';
    if (inst.hpCurrent <= 0) return 'combatant-dead';
    if (inst.hpCurrent <= inst.hpMax / 2) return 'combatant-bloodied';
    return '';
  }

  function render(container, adventureId, scene, adversaries, npcs) {
    container.innerHTML = '';

    let combat = State.combatState(adventureId, scene.hash);
    const started = !!combat;

    const logLines = [];
    const logNode = el('div', { class: 'roll-log' });
    function log(text) {
      logLines.unshift(text);
      logNode.innerHTML = '';
      logLines.slice(0, 16).forEach((t) => logNode.appendChild(el('div', { class: 'roll-log-line' }, [t])));
    }

    if (!started) {
      const seed = seedInstancesFromScene(adventureId, scene, adversaries, npcs);
      const startBtn = el('button', { class: 'btn' }, [seed.length ? `Start Encounter (${seed.length} combatant${seed.length === 1 ? '' : 's'})` : 'Start Encounter (empty roster)']);
      startBtn.addEventListener('click', () => {
        seed.forEach((s) => State.addCombatInstance(adventureId, scene.hash, s));
        render(container, adventureId, scene, adversaries, npcs);
      });
      container.appendChild(el('div', { class: 'view-sub' }, [
        `Not started. Starting seeds the roster from ${State.state.party.length} party member(s) and this scene's default opponents — you can add or remove combatants freely once it's running.`,
      ]));
      container.appendChild(startBtn);
      return;
    }

    if (!combat.instances) combat.instances = [];
    if (combat.round == null) combat.round = 1;
    if (combat.turnIndex == null) combat.turnIndex = 0;
    if (combat.turnIndex >= combat.instances.length) combat.turnIndex = 0;

    function persist() {
      State.setCombatState(adventureId, scene.hash, combat);
    }

    // Resolve the def each instance points at, for adversary/npc rows
    // (name/features/abilities lookup) — party instances carry their own
    // snapshot via State.state.party.
    function resolvedFor(inst) {
      if (inst.sourceKind === 'party') {
        const m = (State.state.party || []).find((mm) => mm.id === inst.defRef);
        if (!m) return null;
        return { kind: 'party', name: m.snapshot.name, dexMod: m.snapshot.abilityMods.Dexterity, properties: null, features: [], member: m };
      }
      const found = resolveEntity(inst.defRef, adversaries, npcs);
      if (!found) return null;
      return { kind: found.kind, name: found.name, dexMod: adversaryDexMod(found.properties), properties: found.properties, features: found.features };
    }

    // ── header: round / turn / controls ────────────────────────────
    const roundLabel = el('div', { class: 'combat-round' }, [`Round ${combat.round}`]);
    const nextBtn = el('button', { class: 'btn' }, ['Next Turn ▶']);
    const endBtn = el('button', { class: 'btn btn-ghost' }, ['End Encounter']);
    const rollAllBtn = el('button', { class: 'btn btn-ghost' }, ['Roll All Initiative']);
    const sortBtn = el('button', { class: 'btn' }, ['Sort by Initiative']);

    nextBtn.addEventListener('click', () => {
      if (!combat.instances.length) return;
      combat.turnIndex = (combat.turnIndex + 1) % combat.instances.length;
      if (combat.turnIndex === 0) {
        combat.round += 1;
        persist();
        const expired = State.tickDurations(adventureId, scene.hash);
        combat = State.combatState(adventureId, scene.hash);
        expired.forEach((e) => log(`⏱ ${e.conditionName} expired on ${e.instanceName} (round ${combat.round}).`));
      }
      persist();
      roundLabel.textContent = `Round ${combat.round}`;
      renderAll();
    });
    endBtn.addEventListener('click', () => {
      if (!confirm('End this encounter? Turn order, round count, conditions and instance HP are discarded. Party HP is kept.')) return;
      State.clearCombatState(adventureId, scene.hash);
      render(container, adventureId, scene, adversaries, npcs);
    });
    rollAllBtn.addEventListener('click', () => {
      combat.instances.forEach((inst) => {
        const r = resolvedFor(inst);
        const roll = rollDie(20);
        const dexMod = (r && r.dexMod) || 0;
        inst.initiative = roll + dexMod;
        log(`${inst.displayName}: initiative d20 [${roll}]${fmtMod(dexMod)} = ${inst.initiative}`);
      });
      persist();
      renderTable();
    });
    sortBtn.addEventListener('click', () => {
      combat.instances.sort((a, b) => (b.initiative || -Infinity) - (a.initiative || -Infinity));
      combat.turnIndex = 0;
      persist();
      renderTable();
      renderPicker();
    });

    const header = el('div', { class: 'combat-header' }, [
      el('h2', {}, ['Run Encounter: ' + (scene.name || '')]),
      el('div', { class: 'chiprow' }, [roundLabel, rollAllBtn, sortBtn, nextBtn, endBtn]),
    ]);

    // ── roster editor: add a PC or search for a creature ──────────────
    const rosterIds = new Set(combat.instances.filter((i) => i.sourceKind === 'party').map((i) => i.defRef));
    const addPcSelect = el('select', { class: 'searchbar' });
    addPcSelect.appendChild(el('option', { value: '' }, ['Add a party member…']));
    (State.state.party || []).forEach((m) => {
      if (rosterIds.has(m.id)) return;
      addPcSelect.appendChild(el('option', { value: m.id }, [m.snapshot.name]));
    });
    addPcSelect.disabled = !(State.state.party || []).some((m) => !rosterIds.has(m.id));
    addPcSelect.addEventListener('change', () => {
      const id = addPcSelect.value;
      if (!id) return;
      const m = (State.state.party || []).find((mm) => mm.id === id);
      if (!m) return;
      State.addCombatInstance(adventureId, scene.hash, {
        defRef: m.id, sourceKind: 'party', displayName: m.snapshot.name,
        hpMax: m.snapshot.hpMax, hpCurrent: m.gm.hpCurrent,
      });
      combat = State.combatState(adventureId, scene.hash);
      renderAll();
    });

    const searchInput = el('input', { class: 'searchbar', type: 'search', placeholder: 'Search adversaries by name…' });
    const typeFilter = el('select', { class: 'searchbar' });
    const crFilter = el('select', { class: 'searchbar' });
    const searchResults = el('div', { class: 'card-grid creature-search-results' });

    const allTypes = Array.from(new Set((adversaries || []).map((a) => (a.properties && a.properties.Type ? String(a.properties.Type).replace(/\s*\([^)]*\)/, '') : null)).filter(Boolean))).sort();
    typeFilter.appendChild(el('option', { value: '' }, ['All types']));
    allTypes.forEach((t) => typeFilter.appendChild(el('option', { value: t }, [t])));

    const allCrs = Array.from(new Set((adversaries || []).map((a) => a.properties && a.properties['Challenge Rating'] && a.properties['Challenge Rating'].Printed).filter((v) => v != null)));
    allCrs.sort((a, b) => crToNumber(a) - crToNumber(b));
    crFilter.appendChild(el('option', { value: '' }, ['All CRs']));
    allCrs.forEach((c) => crFilter.appendChild(el('option', { value: c }, ['CR ' + c])));

    function crToNumber(printed) {
      if (printed == null) return 0;
      if (String(printed).indexOf('/') !== -1) {
        const [n, d] = String(printed).split('/').map(Number);
        return n / d;
      }
      return Number(printed) || 0;
    }

    function drawSearch() {
      const q = searchInput.value.trim().toLowerCase();
      searchResults.innerHTML = '';
      if (!q && !typeFilter.value && !crFilter.value) return;
      const hits = (adversaries || []).filter((a) => {
        if (q && a.name.toLowerCase().indexOf(q) === -1) return false;
        if (typeFilter.value && !(a.properties && a.properties.Type && String(a.properties.Type).indexOf(typeFilter.value) !== -1)) return false;
        if (crFilter.value && !(a.properties && a.properties['Challenge Rating'] && a.properties['Challenge Rating'].Printed === crFilter.value)) return false;
        return true;
      }).slice(0, 40);
      if (!hits.length) {
        searchResults.appendChild(el('div', { class: 'view-sub' }, ['No matches.']));
        return;
      }
      hits.forEach((a) => {
        const cr = a.properties && a.properties['Challenge Rating'] ? a.properties['Challenge Rating'].Printed : null;
        const addBtn = el('button', { class: 'btn' }, ['+ Add']);
        addBtn.addEventListener('click', () => {
          const hpMax = a.properties ? a.properties['Hit Points'] : null;
          combat = State.combatState(adventureId, scene.hash);
          const name = nextDisplayName(combat, a.name);
          persist();
          State.addCombatInstance(adventureId, scene.hash, {
            defRef: a.hash, sourceKind: 'adversary', displayName: name, hpMax, hpCurrent: hpMax,
          });
          combat = State.combatState(adventureId, scene.hash);
          renderAll();
        });
        searchResults.appendChild(el('div', { class: 'card creature-search-card' }, [
          el('h3', {}, [a.name, a.mikko ? el('span', { class: 'badge mikko' }, ['Mikko']) : a.thirdParty ? el('span', { class: 'badge' }, ['Axis']) : null]),
          el('div', { class: 'tag' }, [[a.properties && a.properties.Type, cr ? 'CR ' + cr : null].filter(Boolean).join(' · ')]),
          addBtn,
        ]));
      });
    }
    searchInput.addEventListener('input', drawSearch);
    typeFilter.addEventListener('change', drawSearch);
    crFilter.addEventListener('change', drawSearch);

    const rosterEditor = el('div', { class: 'roster-editor' }, [
      el('h3', {}, ['Add to roster']),
      el('div', { class: 'chiprow' }, [addPcSelect]),
      el('div', { class: 'chiprow' }, [searchInput, typeFilter, crFilter]),
      searchResults,
    ]);

    // ── combat table ────────────────────────────────────────────────
    const tableWrap = el('div', { class: 'combat-table' });

    function renderRow(inst) {
      const r = resolvedFor(inst);
      const isCurrent = combat.instances.indexOf(inst) === combat.turnIndex;

      const initInput = el('input', { type: 'number', class: 'hp-current-input', placeholder: 'init' });
      initInput.value = inst.initiative != null ? String(inst.initiative) : '';
      initInput.addEventListener('change', () => {
        const v = parseInt(initInput.value, 10);
        State.setInstanceInitiative(adventureId, scene.hash, inst.instanceId, isNaN(v) ? null : v);
        combat = State.combatState(adventureId, scene.hash);
      });
      const rollInitBtn = el('button', { class: 'btn btn-ghost combat-roll-btn' }, ['🎲']);
      rollInitBtn.addEventListener('click', () => {
        const roll = rollDie(20);
        const dexMod = (r && r.dexMod) || 0;
        const total = roll + dexMod;
        State.setInstanceInitiative(adventureId, scene.hash, inst.instanceId, total);
        combat = State.combatState(adventureId, scene.hash);
        initInput.value = String(total);
        log(`${inst.displayName}: initiative d20 [${roll}]${fmtMod(dexMod)} = ${total}`);
      });

      const hpMinus = el('button', { class: 'btn btn-ghost hp-btn' }, ['−']);
      const hpPlus = el('button', { class: 'btn btn-ghost hp-btn' }, ['+']);
      const hpAmount = el('input', { type: 'number', class: 'hp-current-input hp-amount', value: '1', min: '1' });
      function applyDelta(delta) {
        const next = Math.max(0, (inst.hpCurrent || 0) + delta);
        State.setInstanceHp(adventureId, scene.hash, inst.instanceId, next);
        combat = State.combatState(adventureId, scene.hash);
        renderTable();
      }
      hpMinus.addEventListener('click', () => applyDelta(-(parseInt(hpAmount.value, 10) || 0)));
      hpPlus.addEventListener('click', () => applyDelta(parseInt(hpAmount.value, 10) || 0));

      // ── conditions: chips + add-with-duration row ───────────────────
      const condChips = (inst.conditions || []).map((c) => {
        const ruleDef = (window.AXIS.rules || []).find((rr) => rr.name.toLowerCase() === c.name.toLowerCase());
        const chip = el('span', { class: 'chip condition-chip', title: ruleDef ? (ruleDef.properties.Description || '').slice(0, 300) : '' }, [
          c.name + (c.duration != null ? ` (${c.duration}r)` : ''),
          el('button', { class: 'condition-remove', onclick: () => {
            State.removeInstanceCondition(adventureId, scene.hash, inst.instanceId, c.id);
            combat = State.combatState(adventureId, scene.hash);
            renderTable();
            renderSidebar();
          } }, ['✕']),
        ]);
        return chip;
      });

      const condSelect = el('select', { class: 'hp-current-input' });
      condSelect.appendChild(el('option', { value: '' }, ['+ condition…']));
      CONDITION_NAMES.forEach((n) => condSelect.appendChild(el('option', { value: n }, [n])));
      const condDuration = el('input', { type: 'number', class: 'hp-current-input hp-amount', placeholder: 'rounds' });
      const condAddBtn = el('button', { class: 'btn btn-ghost' }, ['Apply']);
      condAddBtn.addEventListener('click', () => {
        if (!condSelect.value) return;
        State.addInstanceCondition(adventureId, scene.hash, inst.instanceId, condSelect.value, condDuration.value);
        combat = State.combatState(adventureId, scene.hash);
        condSelect.value = '';
        condDuration.value = '';
        renderTable();
        renderSidebar();
      });

      // ── rollable actions ─────────────────────────────────────────────
      const actions = r ? parseRollableActions(r.features) : [];
      const actionButtons = actions.filter((a) => a.attackBonus != null).map((a) => {
        const b = el('button', { class: 'btn btn-ghost action-roll-btn' }, [`${a.name} 🎲`]);
        b.addEventListener('click', () => {
          const d20 = rollDie(20);
          const total = d20 + a.attackBonus;
          let text = `${inst.displayName} — ${a.name}: attack d20 [${d20}]+${a.attackBonus} = ${total}`;
          if (a.damageExpr) {
            const dmg = rollDiceExpr(a.damageExpr);
            text += ` · damage ${a.damageExpr} ${dmg.detail} = ${dmg.total}${a.damageType ? ' ' + a.damageType : ''}`;
          }
          log(text);
        });
        return b;
      });

      // ── spellcasting: clickable spell names pulled from the feature ──
      const spellRefs = r ? extractSpellRefs(r.features) : [];
      const spellButtons = spellRefs.map((ref) => {
        const b = el('button', { class: 'btn btn-ghost spell-link-btn' + (ref.spell ? '' : ' spell-link-miss') }, [ref.rawName]);
        b.addEventListener('click', () => spellPopover(ref));
        return b;
      });

      const removeBtn = el('button', { class: 'btn btn-danger remove-combatant-btn' }, ['Remove']);
      removeBtn.addEventListener('click', () => {
        State.removeCombatInstance(adventureId, scene.hash, inst.instanceId);
        combat = State.combatState(adventureId, scene.hash);
        renderAll();
      });

      const row = el('div', { class: 'combat-row' + (isCurrent ? ' combat-current' : '') + ' ' + hpStatusClass(inst) }, [
        el('div', { class: 'combat-turn-mark' }, [isCurrent ? '▶' : '']),
        el('div', { class: 'combat-name' }, [
          inst.displayName,
          el('span', { class: 'view-sub' }, [inst.sourceKind === 'party' ? ' (party)' : inst.sourceKind === 'npc' ? ' (npc)' : ' (adversary)']),
        ]),
        el('div', { class: 'combat-init' }, [initInput, rollInitBtn]),
        el('div', { class: 'combat-hp' }, [
          inst.hpMax != null ? el('span', {}, [`HP ${inst.hpCurrent} / ${inst.hpMax}`]) : el('span', { class: 'view-sub' }, ['no HP tracked']),
          hpMinus, hpAmount, hpPlus,
        ]),
        el('div', { class: 'combat-actions' }, [...actionButtons, ...spellButtons, removeBtn]),
        el('div', { class: 'combat-conditions' }, [
          el('div', { class: 'chiprow' }, condChips),
          el('div', { class: 'chiprow' }, [condSelect, condDuration, condAddBtn]),
        ]),
      ]);
      return row;
    }

    function renderTable() {
      tableWrap.innerHTML = '';
      if (!combat.instances.length) {
        tableWrap.appendChild(el('div', { class: 'view-sub' }, ['No combatants on the roster — add one above.']));
        return;
      }
      combat.instances.forEach((inst) => tableWrap.appendChild(renderRow(inst)));
    }

    // ── active-effects sidebar ─────────────────────────────────────────
    const sidebar = el('div', { class: 'effects-sidebar' });
    function renderSidebar() {
      sidebar.innerHTML = '';
      sidebar.appendChild(el('h3', {}, ['Active Effects']));
      const rows = [];
      combat.instances.forEach((inst) => {
        (inst.conditions || []).forEach((c) => {
          rows.push(el('div', { class: 'effect-row' }, [
            el('span', { class: 'effect-name' }, [inst.displayName]),
            el('span', { class: 'effect-condition' }, [c.name]),
            el('span', { class: 'effect-duration' }, [c.duration != null ? `${c.duration} rd${c.duration === 1 ? '' : 's'}` : '—']),
          ]));
        });
      });
      if (!rows.length) sidebar.appendChild(el('div', { class: 'view-sub' }, ['No active conditions.']));
      else rows.forEach((r) => sidebar.appendChild(r));
    }

    const bodyLayout = el('div', { class: 'combat-body-layout' }, [tableWrap, sidebar]);

    function renderPicker() {}

    function renderAll() {
      combat = State.combatState(adventureId, scene.hash);
      if (!combat) { render(container, adventureId, scene, adversaries, npcs); return; }
      if (combat.turnIndex >= combat.instances.length) combat.turnIndex = 0;
      addPcSelect.innerHTML = '';
      addPcSelect.appendChild(el('option', { value: '' }, ['Add a party member…']));
      const seatedIds = new Set(combat.instances.filter((i) => i.sourceKind === 'party').map((i) => i.defRef));
      (State.state.party || []).forEach((m) => {
        if (seatedIds.has(m.id)) return;
        addPcSelect.appendChild(el('option', { value: m.id }, [m.snapshot.name]));
      });
      renderTable();
      renderSidebar();
    }

    renderAll();

    container.appendChild(header);
    container.appendChild(rosterEditor);
    container.appendChild(bodyLayout);
    container.appendChild(el('h3', {}, ['Roll Log']));
    container.appendChild(logNode);
  }

  return { render, parseRollableActions, rollDiceExpr, adversaryDexMod, extractSpellRefs };
})();
