// sheet.js — the character sheet, as played. One renderer for the GM's
// Party panel and (later) the player's own page: opts.player hides what
// only the GM may see or do (GM notes, re-sync, remove).
//
// Everything a player may change lives on member.gm (the live layer):
// HP, temp HP, death saves, inspiration, conditions, player notes, spell
// slots, resources, item quantities. Everything D&D Beyond decides is read
// from the snapshot and never edited here.
//
// Rolls go to the bus as `roll` events ({ who, text }) — play mode's roll
// log and the table show them — and to the sheet's own log.
window.AxisSheet = (function () {
  const { el, markdownish, fmtMod, drawer, statBlock } = window.AxisRender;
  const State = window.AxisState;
  const Bus = window.AxisBus;

  const ABILITY_ORDER = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
  const ACTIVATION_LABEL = { action: 'Actions', bonus: 'Bonus Actions', reaction: 'Reactions', special: 'Other', none: 'Other', minute: 'Other', hour: 'Other' };
  const ACTIVATION_ORDER = ['action', 'bonus', 'reaction', 'special'];

  function classLine(snapshot) {
    return (snapshot.classes || []).map((c) => `${c.name}${c.subclass ? ' (' + c.subclass + ')' : ''} ${c.level}`).join(' / ');
  }

  function rollDie(sides) {
    return 1 + Math.floor(Math.random() * sides);
  }

  function rollExpr(expr) {
    return window.AxisPlayMode.rollDiceExpr(expr);
  }

  // Which scene's encounter a summon joins: the GM's current scene, if it
  // has an encounter running.
  function runningEncounter() {
    const data = window.AXIS;
    if (!data || !window.AxisTracker) return null;
    const adventureId = Object.keys(data.adventures)[0];
    const pages = window.AxisTracker.buildPages(data.adventures[adventureId]);
    const page = pages[State.trackerPage(adventureId)];
    if (!page) return null;
    const combat = State.combatState(adventureId, page.scene.hash);
    return combat ? { adventureId, sceneHash: page.scene.hash, scene: page.scene, combat } : null;
  }

  function characterSheet(member, opts) {
    opts = opts || {};
    const s = member.snapshot;
    const gm = member.gm;
    const player = !!opts.player;
    const root = el('div', { class: 'statblock character-sheet' });
    const logNode = el('div', { class: 'roll-log sheet-log' });
    const logLines = [];

    function log(text) {
      logLines.unshift(text);
      logNode.innerHTML = '';
      logLines.slice(0, 12).forEach((t) => logNode.appendChild(el('div', { class: 'roll-log-line' }, [t])));
      Bus.emit('roll', { who: s.name, memberId: member.id, text });
    }

    function d20(label, mod) {
      const r = rollDie(20);
      log(`${s.name} — ${label}: d20 [${r}]${fmtMod(mod)} = ${r + mod}`);
    }

    function rollAttack(name, attackBonus, damage) {
      const r = rollDie(20);
      let text = `${s.name} — ${name}: attack d20 [${r}]${fmtMod(attackBonus)} = ${r + attackBonus}${r === 20 ? ' CRIT' : r === 1 ? ' (nat 1)' : ''}`;
      if (damage && damage.dice) {
        const d = rollExpr(damage.dice);
        text += d.total != null ? ` · damage ${damage.dice} ${d.detail} = ${d.total}${damage.type ? ' ' + damage.type : ''}` : ` · damage ${damage.dice}`;
      }
      log(text);
    }

    function rollDamage(name, damage) {
      const d = rollExpr(damage.dice);
      log(`${s.name} — ${name}: ${damage.dice} ${d.detail} = ${d.total}${damage.type ? ' ' + damage.type : ''}`);
    }

    function redraw() {
      const fresh = State.member(member.id);
      if (!fresh) return;
      const next = characterSheet(fresh, Object.assign({}, opts, { _log: logLines }));
      root.replaceWith(next);
    }
    if (opts._log) {
      opts._log.forEach((t) => logLines.push(t));
      logLines.slice(0, 12).forEach((t) => logNode.appendChild(el('div', { class: 'roll-log-line' }, [t])));
    }

    // ── pips: a row of ○/● for a counter with a max ─────────────────────
    function pips(max, used, onChange) {
      const wrap = el('span', { class: 'pips' });
      if (max > 14) {
        const inp = el('input', { type: 'number', class: 'hp-current-input', min: '0', max: String(max) });
        inp.value = String(max - used);
        inp.addEventListener('change', () => onChange(Math.max(0, Math.min(max, max - (parseInt(inp.value, 10) || 0)))));
        wrap.appendChild(inp);
        wrap.appendChild(el('span', { class: 'view-sub' }, [` / ${max}`]));
        return wrap;
      }
      for (let i = 0; i < max; i++) {
        const filled = i < max - used; // available pips are filled
        const b = el('button', { class: 'pip-btn' + (filled ? ' on' : ''), type: 'button', title: filled ? 'spend' : 'restore' }, [filled ? '●' : '○']);
        b.addEventListener('click', () => onChange(filled ? used + 1 : used - 1));
        wrap.appendChild(b);
      }
      return wrap;
    }

    // ── header ──────────────────────────────────────────────────────────
    const insp = el('button', { class: 'btn btn-ghost insp-btn' + (gm.inspiration ? ' on' : ''), title: 'Inspiration' }, [gm.inspiration ? '★ Inspiration' : '☆ Inspiration']);
    insp.addEventListener('click', () => {
      State.setPartyLive(member.id, { inspiration: !gm.inspiration });
      redraw();
    });

    const abilRow = el('div', { class: 'abilities-row' }, ABILITY_ORDER.map((a) => {
      const box = el('div', { class: 'ability-box rollable', title: 'Roll ' + a + ' check' }, [
        el('div', { class: 'lbl' }, [a.slice(0, 3).toUpperCase()]),
        el('div', { class: 'val' }, [`${s.abilities[a]} (${fmtMod(s.abilityMods[a])})`]),
      ]);
      box.addEventListener('click', () => d20(a + ' check', s.abilityMods[a]));
      return box;
    }));

    // ── HP block ────────────────────────────────────────────────────────
    const hpInput = el('input', { type: 'number', class: 'hp-current-input', value: String(gm.hpCurrent) });
    hpInput.addEventListener('change', () => {
      const v = parseInt(hpInput.value, 10);
      State.setPartyHp(member.id, isNaN(v) ? 0 : v);
      redraw();
    });
    const tempInput = el('input', { type: 'number', class: 'hp-current-input', value: String(gm.tempHp || 0), title: 'Temporary HP' });
    tempInput.addEventListener('change', () => {
      State.setPartyLive(member.id, { tempHp: Math.max(0, parseInt(tempInput.value, 10) || 0) });
      redraw();
    });
    const amount = el('input', { type: 'number', class: 'hp-current-input hp-amount', value: '1', min: '1' });
    function applyHp(delta) {
      let n = parseInt(amount.value, 10) || 0;
      if (delta < 0) {
        // damage comes off temp HP first
        const temp = gm.tempHp || 0;
        const fromTemp = Math.min(temp, n);
        const rest = n - fromTemp;
        State.setPartyLive(member.id, { tempHp: temp - fromTemp });
        State.setPartyHp(member.id, Math.max(0, gm.hpCurrent - rest));
      } else {
        State.setPartyHp(member.id, Math.min(s.hpMax, gm.hpCurrent + n));
      }
      redraw();
    }
    const dmgBtn = el('button', { class: 'btn btn-danger' }, ['Damage']);
    dmgBtn.addEventListener('click', () => applyHp(-1));
    const healBtn = el('button', { class: 'btn' }, ['Heal']);
    healBtn.addEventListener('click', () => applyHp(1));

    const ds = gm.deathSaves || { success: 0, fail: 0 };
    function dsPips(kind, count) {
      const wrap = el('span', { class: 'pips' });
      for (let i = 0; i < 3; i++) {
        const on = i < count;
        const b = el('button', { class: 'pip-btn' + (on ? (kind === 'fail' ? ' fail' : ' on') : ''), type: 'button' }, [on ? '●' : '○']);
        b.addEventListener('click', () => {
          const patch = {};
          patch.deathSaves = Object.assign({}, ds, { [kind]: on ? i : i + 1 });
          State.setPartyLive(member.id, patch);
          redraw();
        });
        wrap.appendChild(b);
      }
      return wrap;
    }
    const deathRow = el('div', { class: 'stat-row death-saves' }, [
      el('b', {}, ['Death saves: ']),
      el('span', {}, ['successes ']), dsPips('success', ds.success || 0),
      el('span', {}, [' failures ']), dsPips('fail', ds.fail || 0),
    ]);
    deathRow.hidden = gm.hpCurrent > 0 && !(ds.success || ds.fail);

    const hpBlock = el('div', { class: 'hp-block' }, [
      el('div', { class: 'stat-row hp-row' }, [
        el('b', {}, ['Hit Points: ']), hpInput, el('span', {}, [` / ${s.hpMax}`]),
        el('b', { class: 'temp-lbl' }, ['Temp: ']), tempInput,
      ]),
      el('div', { class: 'stat-row' }, [amount, dmgBtn, healBtn]),
      deathRow,
    ]);

    // ── top rows ────────────────────────────────────────────────────────
    const topRows = [
      ['Armor Class', `${s.ac.value} (${s.ac.note})`],
      ['Proficiency Bonus', fmtMod(s.proficiencyBonus)],
      ['Speed', Object.entries(s.speed || {}).map(([k, v]) => `${k} ${v} ft.`).join(', ') || '—'],
    ];
    if (s.senses && Object.keys(s.senses).length) topRows.push(['Senses', Object.entries(s.senses).map(([k, v]) => `${k} ${v} ft.`).join(', ')]);
    if (s.languages && s.languages.length) topRows.push(['Languages', s.languages.join(', ')]);

    const savesRow = el('div', { class: 'stat-row' }, [el('b', {}, ['Saving Throws: ']), el('span', { class: 'chiprow inline' }, ABILITY_ORDER.map((a) => {
      const st = s.savingThrows[a];
      const b = el('button', { class: 'chip roll-chip' + (st && st.proficient ? ' prof' : ''), type: 'button' }, [`${a.slice(0, 3)} ${fmtMod(st ? st.modifier : s.abilityMods[a])}`]);
      b.addEventListener('click', () => d20(a + ' save', st ? st.modifier : s.abilityMods[a]));
      return b;
    }))]);

    const skillsRow = el('div', { class: 'stat-row' }, [el('b', {}, ['Skills: ']), el('span', { class: 'chiprow inline' }, Object.entries(s.skills || {}).map(([name, v]) => {
      const b = el('button', { class: 'chip roll-chip' + (v.proficient ? ' prof' : ''), type: 'button' }, [`${name}${v.expertise ? '*' : ''} ${fmtMod(v.modifier)}`]);
      b.addEventListener('click', () => d20(name, v.modifier));
      return b;
    }))]);

    // ── conditions ──────────────────────────────────────────────────────
    const conds = gm.conditions || [];
    const condSel = el('select', { class: 'hp-current-input' });
    condSel.appendChild(el('option', { value: '' }, ['+ condition…']));
    (window.AxisPlayMode.CONDITION_NAMES || []).forEach((n) => condSel.appendChild(el('option', { value: n }, [n])));
    condSel.addEventListener('change', () => {
      if (!condSel.value) return;
      State.setPartyConditions(member.id, conds.concat([condSel.value]));
      redraw();
    });
    const condRow = el('div', { class: 'stat-row' }, [el('b', {}, ['Conditions: ']), el('span', { class: 'chiprow inline' }, [
      ...conds.map((c) => el('span', { class: 'chip condition-chip' }, [c, el('button', { class: 'condition-remove', onclick: () => { State.setPartyConditions(member.id, conds.filter((x) => x !== c)); redraw(); } }, ['✕'])])),
      condSel,
    ])]);

    // ── rests ───────────────────────────────────────────────────────────
    const shortRest = el('button', { class: 'btn btn-ghost' }, ['Short rest']);
    shortRest.addEventListener('click', () => { State.restParty(member.id, 'short'); log(`${s.name} takes a short rest.`); redraw(); });
    const longRest = el('button', { class: 'btn btn-ghost' }, ['Long rest']);
    longRest.addEventListener('click', () => { if (!confirm('Long rest: HP to max, slots and resources restored?')) return; State.restParty(member.id, 'long'); log(`${s.name} takes a long rest.`); redraw(); });

    // ── slots & resources ───────────────────────────────────────────────
    const slotRows = (s.spellSlots || []).map((sl) =>
      el('div', { class: 'stat-row' }, [el('b', {}, [`Level ${sl.level}: `]), pips(sl.max, gm.slotsUsed[sl.level] || 0, (used) => { State.setSlotUsed(member.id, sl.level, used); redraw(); })])
    );
    (s.pactMagic || []).forEach((sl) => slotRows.push(
      el('div', { class: 'stat-row' }, [el('b', {}, [`Pact (level ${sl.level}): `]), pips(sl.max, gm.pactUsed || 0, (used) => { State.setPactUsed(member.id, used); redraw(); })])
    ));
    const resourceRows = (s.resources || []).map((r) =>
      el('div', { class: 'stat-row' }, [el('b', {}, [r.name + ': ']), pips(r.max, gm.resourcesUsed[r.key] || 0, (used) => { State.setResourceUsed(member.id, r.key, used); redraw(); }), el('span', { class: 'view-sub' }, [` ${r.reset} rest`])])
    );

    // ── actions ─────────────────────────────────────────────────────────
    function actionRow(a) {
      const controls = [];
      if (a.attackBonus != null) {
        const b = el('button', { class: 'btn btn-ghost roll-btn' }, [`Attack ${fmtMod(a.attackBonus)} 🎲`]);
        b.addEventListener('click', () => rollAttack(a.name, a.attackBonus, a.damage));
        controls.push(b);
      } else if (a.damage && a.damage.dice) {
        const b = el('button', { class: 'btn btn-ghost roll-btn' }, [`${a.damage.dice}${a.damage.type ? ' ' + a.damage.type : ''} 🎲`]);
        b.addEventListener('click', () => rollDamage(a.name, a.damage));
        controls.push(b);
      }
      if (a.save) controls.push(el('span', { class: 'chip' }, [`${a.save.ability.slice(0, 3)} save DC ${a.save.dc}`]));
      if (a.resourceKey) {
        const r = (s.resources || []).find((x) => x.key === a.resourceKey);
        if (r) controls.push(pips(r.max, gm.resourcesUsed[r.key] || 0, (used) => { State.setResourceUsed(member.id, r.key, used); redraw(); }));
      }
      const name = el('button', { class: 'sel-link fname', type: 'button' }, [a.name]);
      const desc = el('div', { class: 'action-desc', html: markdownish(a.description || '') });
      desc.hidden = true;
      name.addEventListener('click', () => { desc.hidden = !desc.hidden; });
      return el('div', { class: 'feature action-row' }, [el('div', { class: 'action-head' }, [name, a.source === 'weapon' ? el('span', { class: 'fcat' }, ['weapon']) : null, ...controls]), desc]);
    }
    const actionsByGroup = {};
    (s.actions || []).forEach((a) => {
      const g = ACTIVATION_LABEL[a.activation] || 'Other';
      (actionsByGroup[g] = actionsByGroup[g] || []).push(a);
    });
    const actionNodes = [];
    ACTIVATION_ORDER.forEach((k) => {
      const g = ACTIVATION_LABEL[k];
      if (!actionsByGroup[g] || actionNodes.some((n) => n.dataset && n.dataset.group === g)) return;
      const h = el('h3', {}, [g]);
      h.dataset.group = g;
      actionNodes.push(h);
      actionsByGroup[g].forEach((a) => actionNodes.push(actionRow(a)));
    });

    // ── spells ──────────────────────────────────────────────────────────
    function castSpell(sp, level) {
      if (sp.usesSlot) {
        const slot = (s.spellSlots || []).find((x) => x.level === level);
        const used = gm.slotsUsed[level] || 0;
        if (!slot || used >= slot.max) {
          log(`${s.name} — ${sp.name}: no level ${level} slot left.`);
          return;
        }
        State.setSlotUsed(member.id, level, used + 1);
      }
      if (sp.resourceKey) State.setResourceUsed(member.id, sp.resourceKey, (gm.resourcesUsed[sp.resourceKey] || 0) + 1);
      let text = `${s.name} casts ${sp.name}${sp.usesSlot ? ` (level ${level})` : ''}`;
      if (sp.attack) {
        const r = rollDie(20);
        text += ` · attack d20 [${r}]${fmtMod(sp.attackBonus)} = ${r + sp.attackBonus}`;
      }
      if (sp.save) text += ` · ${sp.save.ability.slice(0, 3)} save DC ${sp.save.dc}`;
      if (sp.damage && sp.damage.dice) {
        const d = rollExpr(sp.damage.dice);
        text += d.total != null ? ` · ${sp.damage.dice} ${d.detail} = ${d.total}${sp.damage.type ? ' ' + sp.damage.type : ''}` : ` · ${sp.damage.dice}`;
      }
      if (sp.healing) {
        const d = rollExpr(sp.healing);
        text += d.total != null ? ` · heals ${sp.healing} ${d.detail} = ${d.total}` : ` · heals ${sp.healing}`;
      }
      log(text);
      redraw();
    }

    // A PDF import has no spell text; the corpus does, verbatim.
    function corpusSpellText(name) {
      const row = ((window.AXIS && window.AXIS.spells) || []).find((r) => r.name.toLowerCase() === String(name).toLowerCase());
      return row && row.properties ? row.properties.Description || '' : '';
    }

    function spellRow(sp) {
      const name = el('button', { class: 'sel-link fname', type: 'button' }, [sp.name]);
      const desc = el('div', { class: 'action-desc', html: markdownish(sp.description || corpusSpellText(sp.name) || '') });
      desc.hidden = true;
      name.addEventListener('click', () => { desc.hidden = !desc.hidden; });
      const tags = [sp.prepared ? 'prepared' : null, sp.concentration ? 'concentration' : null, sp.ritual ? 'ritual' : null, sp.activation !== 'action' ? sp.activation : null].filter(Boolean).join(' · ');
      const controls = [];
      if (sp.usesSlot) {
        const levels = (s.spellSlots || []).filter((x) => x.level >= sp.level);
        const sel = el('select', { class: 'hp-current-input' });
        levels.forEach((x) => sel.appendChild(el('option', { value: String(x.level) }, [`L${x.level} (${x.max - (gm.slotsUsed[x.level] || 0)} left)`])));
        const cast = el('button', { class: 'btn btn-ghost roll-btn' }, ['Cast 🎲']);
        cast.disabled = !levels.length;
        cast.addEventListener('click', () => castSpell(sp, parseInt(sel.value, 10)));
        controls.push(sel, cast);
      } else {
        const cast = el('button', { class: 'btn btn-ghost roll-btn' }, [sp.level === 0 ? 'Cast 🎲' : 'Use 🎲']);
        cast.addEventListener('click', () => castSpell(sp, sp.level));
        controls.push(cast);
      }
      if (sp.attack) controls.push(el('span', { class: 'chip' }, [`atk ${fmtMod(sp.attackBonus)}`]));
      if (sp.save) controls.push(el('span', { class: 'chip' }, [`${sp.save.ability.slice(0, 3)} DC ${sp.save.dc}`]));
      return el('div', { class: 'feature action-row' }, [el('div', { class: 'action-head' }, [name, tags ? el('span', { class: 'fcat' }, [tags]) : null, ...controls]), desc]);
    }
    const spellNodes = [];
    if ((s.spells || []).length) {
      let lvl = -1;
      s.spells.forEach((sp) => {
        if (sp.level !== lvl) {
          lvl = sp.level;
          spellNodes.push(el('h4', {}, [lvl === 0 ? 'Cantrips' : `Level ${lvl}`]));
        }
        spellNodes.push(spellRow(sp));
      });
    }

    // ── equipment ───────────────────────────────────────────────────────
    const equipNodes = (s.equipment || []).map((it) => {
      const ov = gm.inventory[it.key];
      const qty = ov ? ov.quantity : it.quantity;
      const minus = el('button', { class: 'pip-btn', type: 'button', title: 'one fewer' }, ['−']);
      const plus = el('button', { class: 'pip-btn', type: 'button', title: 'one more' }, ['+']);
      minus.addEventListener('click', () => { State.setInventoryQty(member.id, it.key, qty - 1); redraw(); });
      plus.addEventListener('click', () => { State.setInventoryQty(member.id, it.key, qty + 1); redraw(); });
      const charges = it.charges ? pips(it.charges.max, gm.resourcesUsed[it.key] || 0, (used) => { State.setResourceUsed(member.id, it.key, used); redraw(); }) : null;
      return el('div', { class: 'stat-row equip-row' + (qty === 0 ? ' gone' : '') }, [
        el('b', {}, [it.name]), it.equipped ? el('span', { class: 'badge' }, ['equipped']) : null,
        el('span', { class: 'qty' }, [minus, ` ×${qty} `, plus]),
        charges ? el('span', { class: 'view-sub' }, [' charges ']) : null, charges,
      ]);
    });

    // ── companions ──────────────────────────────────────────────────────
    const enc = runningEncounter();
    const companionNodes = (s.companions || []).map((c) => {
      const hp = gm.companionHp[c.key];
      const seated = enc && (enc.combat.instances || []).some((i) => i.defRef === `${member.id}:${c.key}`);
      const summon = el('button', { class: 'btn btn-ghost' }, [seated ? 'In the encounter' : enc ? 'Summon into encounter' : 'No encounter running']);
      summon.disabled = !enc || seated;
      summon.addEventListener('click', () => {
        State.addCompanionInstance(enc.adventureId, enc.sceneHash, member.id, c.key);
        log(`${s.name} brings ${c.name} into ${enc.scene.name}.`);
        redraw();
      });
      const block = el('button', { class: 'btn btn-ghost' }, ['Stat block']);
      block.addEventListener('click', () => drawer(statBlock(c.name, c.statblock, c.features)));
      const rolls = window.AxisPlayMode.parseRollableActions(c.features).filter((a) => a.attackBonus != null).map((a) => {
        const b = el('button', { class: 'btn btn-ghost roll-btn' }, [`${a.name} ${fmtMod(a.attackBonus)} 🎲`]);
        b.addEventListener('click', () => rollAttack(`${c.name}: ${a.name}`, a.attackBonus, a.damageExpr ? { dice: a.damageExpr, type: a.damageType } : null));
        return b;
      });
      return el('div', { class: 'feature companion-row' }, [
        el('div', { class: 'action-head' }, [el('span', { class: 'fname' }, [c.name]), el('span', { class: 'fcat' }, [`${c.group} · ${c.size} · AC ${c.ac} · HP ${hp != null ? hp : c.hpMax}/${c.hpMax}`]), summon, block]),
        rolls.length ? el('div', { class: 'chiprow' }, rolls) : null,
      ]);
    });

    // ── notes ───────────────────────────────────────────────────────────
    const playerNotes = el('textarea', { class: 'notes', placeholder: 'Player notes…' });
    playerNotes.value = gm.playerNotes || '';
    playerNotes.addEventListener('change', () => State.setPartyLive(member.id, { playerNotes: playerNotes.value }));
    const gmNotes = el('textarea', { class: 'notes', placeholder: 'GM notes on this character…' });
    gmNotes.value = gm.notes || '';
    gmNotes.addEventListener('change', () => State.setPartyNotes(member.id, gmNotes.value));

    const featNodes = (s.features || []).map((f) => {
      const name = el('button', { class: 'sel-link fname', type: 'button' }, [f.name]);
      const desc = el('div', { class: 'action-desc', html: markdownish(f.description || '') });
      desc.hidden = true;
      name.addEventListener('click', () => { desc.hidden = !desc.hidden; });
      return el('div', { class: 'feature action-row' }, [el('div', { class: 'action-head' }, [name, f.category ? el('span', { class: 'fcat' }, [f.category]) : null]), desc]);
    });

    [
      el('div', { class: 'sheet-head' }, [el('h2', {}, [s.name]), insp]),
      el('div', { class: 'typeline' }, [`${s.race || 'Unknown race'} · ${classLine(s) || 'no class'}${s.background ? ' · ' + s.background : ''}`]),
      el('hr'),
      abilRow,
      el('hr'),
      hpBlock,
      ...topRows.map(([label, val]) => el('div', { class: 'stat-row' }, [el('b', {}, [label + ': ']), val || '—'])),
      savesRow,
      skillsRow,
      condRow,
      el('div', { class: 'chiprow rest-row' }, [shortRest, longRest]),
      slotRows.length ? el('h3', {}, ['Spell Slots']) : null,
      ...slotRows,
      resourceRows.length ? el('h3', {}, ['Resources']) : null,
      ...resourceRows,
      ...actionNodes,
      spellNodes.length ? el('h3', {}, ['Spells']) : null,
      ...spellNodes,
      companionNodes.length ? el('h3', {}, ['Companions']) : null,
      ...companionNodes,
      equipNodes.length ? el('h3', {}, ['Equipment']) : null,
      equipNodes.length ? el('div', { class: 'equip-list' }, equipNodes) : null,
      featNodes.length ? el('h3', {}, ['Features & Traits']) : null,
      ...featNodes,
      el('h3', {}, ['Roll Log']),
      logNode,
      el('h3', {}, ['Notes']),
      playerNotes,
      player ? null : el('h3', {}, ['GM Notes']),
      player ? null : gmNotes,
      player ? null : el('div', { class: 'sheet-actions' }, [
        el('button', { class: 'btn', onclick: () => opts.onResync && opts.onResync(member) }, ['Re-sync from D&D Beyond']),
        el('button', { class: 'btn btn-danger', onclick: () => opts.onRemove && opts.onRemove(member) }, ['Remove from party']),
      ]),
    ].forEach((n) => n && root.appendChild(n));

    return root;
  }

  return { characterSheet, classLine };
})();
