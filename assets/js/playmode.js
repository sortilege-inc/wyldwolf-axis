// playmode.js — "Run Encounter" live-play panel for a single scene, in the
// spirit of Portents & Fortunes' play/sheet.js (a roller embedded in the
// data view itself) but for D&D 5e: d20+mod rolls, not Roll & Keep. Reuses
// state that already exists — party HP (state.party[].gm.hpCurrent) and
// per-scene adversary overrides (State.encounterOverride) — rather than
// building a parallel HP-tracking system. Only the turn order/round
// counter is new persisted state (State.combatState).
window.AxisPlayMode = (function () {
  const { el, fmtMod, resolveEntity } = window.AxisRender;
  const State = window.AxisState;

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
  // Judgment call: an action with no attack-roll bonus (a save-based
  // effect, a passive, a multiattack line) is shown but not "rollable" as
  // an attack — the GM still sees it, they just don't get a d20 button for
  // it, since there is no single bonus to roll against.
  function parseRollableActions(features) {
    return (features || [])
      .filter((f) => f.category === 'Action' || f.category === 'Reaction' || f.category === 'Bonus Action')
      .map((f) => {
        const desc = f.description || '';
        // Two printed phrasings show up across the merged corpus's sources:
        // the 5.5e SRD's "Melee/Ranged Attack Roll: +9" and the older
        // "Melee/Ranged Weapon Attack: +7 to hit" — both mean the same
        // thing (a flat bonus to a d20 attack roll), so both are matched.
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

  // Builds the combatant roster: party members (state.party[]) + this
  // scene's conflict.opponents. NOTE (flagged judgment call): the source
  // scene's opponents list is a list of adversary HASHES, and the
  // pre-existing encounterOverrides state (built before this task) is
  // already keyed one-entry-per-unique-hash, not per physical creature —
  // so if a scene fields "2× Cultist" via the same hash twice, this reuses
  // that same one-row-per-unique-hash shape rather than inventing instance
  // ids, to stay consistent with the override system already shipped.
  function buildCombatants(adventureId, scene, adversaries, npcs) {
    const combatants = [];
    (State.state.party || []).forEach((m) => {
      combatants.push({
        key: m.id,
        kind: 'party',
        name: m.snapshot.name,
        dexMod: m.snapshot.abilityMods.Dexterity,
        hpMax: m.snapshot.hpMax,
        hpCurrent: m.gm.hpCurrent,
        member: m,
      });
    });
    ((scene.conflict && scene.conflict.opponents) || []).forEach((h) => {
      const found = resolveEntity(h, adversaries, npcs);
      if (!found) return;
      const hpMax = found.properties ? found.properties['Hit Points'] : null;
      const ov = State.encounterOverride(adventureId, scene.hash, h);
      combatants.push({
        key: h,
        kind: found.kind,
        name: found.name,
        dexMod: adversaryDexMod(found.properties),
        hpMax,
        hpCurrent: ov.hpCurrent != null ? ov.hpCurrent : hpMax,
        actions: parseRollableActions(found.features),
      });
    });
    return combatants;
  }

  function applyHpDelta(adventureId, scene, c, delta) {
    const next = Math.max(0, (c.hpCurrent || 0) + delta);
    if (c.kind === 'party') {
      State.setPartyHp(c.member.id, next);
    } else {
      State.setEncounterOverride(adventureId, scene.hash, c.key, { hpCurrent: next });
    }
    c.hpCurrent = next;
  }

  function hpStatusClass(c) {
    if (c.hpMax == null || c.hpCurrent == null) return '';
    if (c.hpCurrent <= 0) return 'combatant-dead';
    if (c.hpCurrent <= c.hpMax / 2) return 'combatant-bloodied';
    return '';
  }

  function rollLogRow(text) {
    return el('div', { class: 'roll-log-line' }, [text]);
  }

  function render(container, adventureId, scene, adversaries, npcs) {
    container.innerHTML = '';
    const combatants = buildCombatants(adventureId, scene, adversaries, npcs);
    const byKey = {};
    combatants.forEach((c) => (byKey[c.key] = c));

    let combat = State.combatState(adventureId, scene.hash);
    if (!combat) {
      combat = { round: 1, turnIndex: 0, order: combatants.map((c) => ({ key: c.key, kind: c.kind, initiative: null })) };
    } else {
      // Reconcile against the current roster (party added/removed since
      // last save, or the scene's opponent list changed) without losing
      // initiative already rolled for combatants still present.
      const existingKeys = new Set(combat.order.map((o) => o.key));
      combatants.forEach((c) => {
        if (!existingKeys.has(c.key)) combat.order.push({ key: c.key, kind: c.kind, initiative: null });
      });
      combat.order = combat.order.filter((o) => byKey[o.key]);
      if (combat.turnIndex >= combat.order.length) combat.turnIndex = 0;
    }

    function persist() {
      State.setCombatState(adventureId, scene.hash, combat);
    }

    const logLines = [];
    function log(text) {
      logLines.unshift(text);
      logNode.innerHTML = '';
      logLines.slice(0, 12).forEach((t) => logNode.appendChild(rollLogRow(t)));
    }

    if (!combatants.length) {
      container.appendChild(el('div', { class: 'view-sub' }, ['No party members or scene opponents to run — add party members under the Party tab, or this scene has no conflict.opponents.']));
      return;
    }

    // ── header: round / turn / controls ────────────────────────────
    const roundLabel = el('div', { class: 'combat-round' }, [`Round ${combat.round}`]);
    const nextBtn = el('button', { class: 'btn' }, ['Next Turn ▶']);
    const endBtn = el('button', { class: 'btn btn-ghost' }, ['End Encounter']);
    const rollAllBtn = el('button', { class: 'btn btn-ghost' }, ['Roll All Initiative']);
    const startBtn = el('button', { class: 'btn' }, ['Sort by Initiative']);

    nextBtn.addEventListener('click', () => {
      if (!combat.order.length) return;
      combat.turnIndex = (combat.turnIndex + 1) % combat.order.length;
      if (combat.turnIndex === 0) combat.round += 1;
      persist();
      renderTable();
      roundLabel.textContent = `Round ${combat.round}`;
    });
    endBtn.addEventListener('click', () => {
      if (!confirm('End this encounter? Turn order and round count are discarded (HP is kept).')) return;
      State.clearCombatState(adventureId, scene.hash);
      render(container, adventureId, scene, adversaries, npcs);
    });
    rollAllBtn.addEventListener('click', () => {
      combat.order.forEach((o) => {
        const c = byKey[o.key];
        const roll = rollDie(20);
        o.initiative = roll + (c.dexMod || 0);
        log(`${c.name}: initiative d20 [${roll}]${fmtMod(c.dexMod || 0)} = ${o.initiative}`);
      });
      persist();
      renderTable();
    });
    startBtn.addEventListener('click', () => {
      combat.order.sort((a, b) => (b.initiative || -Infinity) - (a.initiative || -Infinity));
      combat.turnIndex = 0;
      combat.round = combat.round || 1;
      persist();
      renderTable();
    });

    const header = el('div', { class: 'combat-header' }, [
      el('h2', {}, ['Run Encounter: ' + (scene.name || '')]),
      el('div', { class: 'chiprow' }, [roundLabel, rollAllBtn, startBtn, nextBtn, endBtn]),
    ]);

    const tableWrap = el('div', { class: 'combat-table' });
    const logNode = el('div', { class: 'roll-log' });

    function renderTable() {
      tableWrap.innerHTML = '';
      combat.order.forEach((o, idx) => {
        const c = byKey[o.key];
        if (!c) return;
        const isCurrent = idx === combat.turnIndex;

        const initInput = el('input', { type: 'number', class: 'hp-current-input', placeholder: 'init' });
        initInput.value = o.initiative != null ? String(o.initiative) : '';
        initInput.addEventListener('change', () => {
          const v = parseInt(initInput.value, 10);
          o.initiative = isNaN(v) ? null : v;
          persist();
        });
        const rollInitBtn = el('button', { class: 'btn btn-ghost combat-roll-btn' }, ['🎲']);
        rollInitBtn.addEventListener('click', () => {
          const roll = rollDie(20);
          o.initiative = roll + (c.dexMod || 0);
          initInput.value = String(o.initiative);
          persist();
          log(`${c.name}: initiative d20 [${roll}]${fmtMod(c.dexMod || 0)} = ${o.initiative}`);
        });

        const hpMinus = el('button', { class: 'btn btn-ghost hp-btn' }, ['−']);
        const hpPlus = el('button', { class: 'btn btn-ghost hp-btn' }, ['+']);
        const hpAmount = el('input', { type: 'number', class: 'hp-current-input hp-amount', value: '1', min: '1' });
        hpMinus.addEventListener('click', () => {
          const amt = parseInt(hpAmount.value, 10) || 0;
          applyHpDelta(adventureId, scene, c, -amt);
          renderTable();
        });
        hpPlus.addEventListener('click', () => {
          const amt = parseInt(hpAmount.value, 10) || 0;
          applyHpDelta(adventureId, scene, c, amt);
          renderTable();
        });

        const actionButtons = (c.actions || [])
          .filter((a) => a.attackBonus != null)
          .map((a) => {
            const b = el('button', { class: 'btn btn-ghost action-roll-btn' }, [`${a.name} 🎲`]);
            b.addEventListener('click', () => {
              const d20 = rollDie(20);
              const total = d20 + a.attackBonus;
              let text = `${c.name} — ${a.name}: attack d20 [${d20}]+${a.attackBonus} = ${total}`;
              if (a.damageExpr) {
                const dmg = rollDiceExpr(a.damageExpr);
                text += ` · damage ${a.damageExpr} ${dmg.detail} = ${dmg.total}${a.damageType ? ' ' + a.damageType : ''}`;
              }
              log(text);
            });
            return b;
          });

        const row = el('div', { class: 'combat-row' + (isCurrent ? ' combat-current' : '') + ' ' + hpStatusClass(c) }, [
          el('div', { class: 'combat-turn-mark' }, [isCurrent ? '▶' : '']),
          el('div', { class: 'combat-name' }, [c.name, el('span', { class: 'view-sub' }, [c.kind === 'party' ? ' (party)' : c.kind === 'npc' ? ' (npc)' : ' (adversary)'])]),
          el('div', { class: 'combat-init' }, [initInput, rollInitBtn]),
          el('div', { class: 'combat-hp' }, [
            c.hpMax != null ? el('span', {}, [`HP ${c.hpCurrent} / ${c.hpMax}`]) : el('span', { class: 'view-sub' }, ['no HP tracked']),
            hpMinus, hpAmount, hpPlus,
          ]),
          actionButtons.length ? el('div', { class: 'combat-actions' }, actionButtons) : el('div', { class: 'combat-actions' }),
        ]);
        tableWrap.appendChild(row);
      });
    }

    renderTable();

    container.appendChild(header);
    container.appendChild(tableWrap);
    container.appendChild(el('h3', {}, ['Roll Log']));
    container.appendChild(logNode);

    // Not copied from Portents' sheet.js: it maintains a persisted,
    // exportable roll log per character across sessions. Here the log is
    // in-memory only for the current encounter (cleared on tab switch) —
    // a GM running one table doesn't need a durable dice history, just a
    // few recent rolls to reference mid-turn, so this deliberately skips
    // that persistence layer.
  }

  return { render, parseRollableActions, rollDiceExpr, adversaryDexMod };
})();
