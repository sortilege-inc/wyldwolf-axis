// inspector.js — the Inspector's view of a combatant or party member:
// a status banner (HP with its controls, AC / initiative / DC, every
// condition and standing modifier, the resources that decide the turn),
// then tabs by activation — Actions · Bonus · Reactions · Spells or
// Traits · Sheet or Stats. One renderer for PCs (from the snapshot) and
// NPCs/adversaries (from the stat block's features).
//
// Rolls made here go to the bus as `roll` events like the sheet's, so
// play mode's log shows them.
window.AxisInspector = (function () {
  const { el, markdownish, fmtMod, statBlock, resolveEntity, toInt } = window.AxisRender;
  const State = window.AxisState;
  const Bus = window.AxisBus;
  const data = window.AXIS;

  let tab = 'actions'; // remembered across selections

  function rollDie(n) {
    return 1 + Math.floor(Math.random() * n);
  }

  function log(who, text) {
    Bus.emit('roll', { who, text });
  }

  // Targets come from the running encounter (targeting.js); the actor is
  // excluded from its own target list.
  function rollAttack(who, name, bonus, damage, selfId) {
    window.AxisTargeting.attack(who, name, bonus, damage, { excludeInstanceId: selfId });
  }
  function rollSave(who, name, ability, dc, damage, selfId) {
    window.AxisTargeting.save(who, name, ability, dc, damage, { excludeInstanceId: selfId });
  }
  function useOn(who, name, selfId) {
    window.AxisTargeting.use(who, name, { excludeInstanceId: selfId });
  }

  // ── build the model ────────────────────────────────────────────────
  // { name, kind, subtitle, hp: {cur, max, set(n)}, ac, init, dc, chips: [{label, remove?}],
  //   resources: [{label, text}], groups: {actions, bonus, reactions, extra}, extraLabel, sheetNode, addCondition(name, rounds) }
  function partyModel(member, inst, ctx) {
    const s = member.snapshot;
    const gm = member.gm;
    const cur = inst ? toInt(inst.hpCurrent) : gm.hpCurrent;
    const chips = [];
    if (inst) {
      (inst.conditions || []).forEach((c) => chips.push({ label: c.name + (c.duration != null ? ` · ${c.duration} rd${c.duration === 1 ? '' : 's'}` : ''), cond: true, remove: () => State.removeInstanceCondition(ctx.adventureId, ctx.sceneHash, inst.instanceId, c.id) }));
    } else {
      (gm.conditions || []).forEach((c) => chips.push({ label: c, cond: true, remove: () => State.setPartyConditions(member.id, gm.conditions.filter((x) => x !== c)) }));
    }
    if (gm.tempHp) chips.push({ label: `Temp HP ${gm.tempHp}` });
    (s.defenses || []).forEach((d) => chips.push({ label: d }));
    if (gm.inspiration) chips.push({ label: 'Inspiration' });
    const resources = [];
    (s.pactMagic || []).forEach((p) => resources.push({ label: `Pact L${p.level}`, text: `${p.max - (gm.pactUsed || 0)} / ${p.max}` }));
    (s.spellSlots || []).forEach((sl) => resources.push({ label: `L${sl.level}`, text: `${sl.max - (gm.slotsUsed[sl.level] || 0)}/${sl.max}` }));
    (s.resources || []).forEach((r) => resources.push({ label: r.name, text: `${r.max - (gm.resourcesUsed[r.key] || 0)} / ${r.max}` }));

    const selfId = inst ? inst.instanceId : null;
    const who = inst ? inst.displayName : s.name;
    const groups = { actions: [], bonus: [], reactions: [], extra: [] };
    (s.actions || []).forEach((a) => {
      const row = {
        name: a.name,
        note: [a.attackBonus != null ? fmtMod(a.attackBonus) : null, a.damage ? a.damage.dice + (a.damage.type ? ' ' + a.damage.type : '') : null, a.save ? `${a.save.ability.slice(0, 3)} DC ${a.save.dc}` : null].filter(Boolean).join(' · '),
        desc: a.description,
        roll: a.attackBonus != null ? () => rollAttack(who, a.name, a.attackBonus, a.damage, selfId) : a.save ? () => rollSave(who, a.name, a.save.ability, a.save.dc, a.damage, selfId) : null,
        use: a.attackBonus == null && !a.save ? () => useOn(who, a.name, selfId) : null,
      };
      (a.activation === 'bonus' ? groups.bonus : a.activation === 'reaction' ? groups.reactions : groups.actions).push(row);
    });
    (s.spells || []).forEach((sp) => {
      const row = {
        name: sp.name,
        note: [sp.level ? 'L' + sp.level : 'cantrip', sp.attack ? fmtMod(sp.attackBonus) : null, sp.save ? `${sp.save.ability.slice(0, 3)} DC ${sp.save.dc}` : null, sp.damage ? sp.damage.dice : null, sp.concentration ? 'conc.' : null].filter(Boolean).join(' · '),
        desc: sp.description || corpusSpellText(sp.name),
        roll: sp.attack ? () => rollAttack(who, sp.name, sp.attackBonus, sp.damage, selfId) : sp.save ? () => rollSave(who, sp.name, sp.save.ability, sp.save.dc, sp.damage, selfId) : null,
        use: !sp.attack && !sp.save ? () => useOn(who, sp.name, selfId) : null,
      };
      groups.extra.push(row);
      if (sp.activation === 'bonus') groups.bonus.push(row);
      else if (sp.activation === 'reaction') groups.reactions.push(row);
    });
    // the API mapper stores no DC; derive it from the casting class
    let casting = s.spellcasting && s.spellcasting.dc ? s.spellcasting : null;
    if (!casting) {
      const cls = (s.classes || []).find((c) => c.spellcastingAbility);
      if (cls && s.abilityMods && s.abilityMods[cls.spellcastingAbility] != null) {
        const m = s.abilityMods[cls.spellcastingAbility];
        casting = { dc: 8 + s.proficiencyBonus + m, attack: s.proficiencyBonus + m };
      }
    }
    return {
      name: inst ? inst.displayName : s.name,
      kind: 'party',
      subtitle: [s.race, (s.classes || []).map((c) => `${c.name} ${c.level}${c.subclass ? ' (' + c.subclass + ')' : ''}`).join(' / '), s.background].filter(Boolean).join(' · '),
      hp: { cur, max: s.hpMax, set: (n) => (inst ? State.setInstanceHp(ctx.adventureId, ctx.sceneHash, inst.instanceId, n) : State.setPartyHp(member.id, n)) },
      ac: s.ac ? s.ac.value : null,
      init: inst ? inst.initiative : null,
      dc: casting ? `DC ${casting.dc} · ${fmtMod(casting.attack)}` : null,
      chips,
      resources,
      groups,
      extraLabel: 'Spells',
      sheetLabel: 'Sheet',
      sheetNode: () => window.AxisSheet.characterSheet(member, { inspector: true }),
      addCondition: inst ? (n, r) => State.addInstanceCondition(ctx.adventureId, ctx.sceneHash, inst.instanceId, n, r) : (n) => State.setPartyConditions(member.id, (gm.conditions || []).concat([n])),
    };
  }

  function corpusSpellText(name) {
    const row = (data.spells || []).find((r) => r.name.toLowerCase() === String(name).toLowerCase());
    return row && row.properties ? row.properties.Description || '' : '';
  }

  function blockModel(found, inst, ctx, displayName) {
    const p = found.properties || {};
    const feats = found.features || [];
    const rollable = window.AxisPlayMode.parseRollableActions(feats);
    const rollFor = (name) => rollable.find((r) => r.name === name);
    const selfId = inst ? inst.instanceId : null;
    const groups = { actions: [], bonus: [], reactions: [], extra: [] };
    feats.forEach((f) => {
      const r = rollFor(f.name);
      // "Dexterity saving throw … DC 15" in the text → a save effect
      const sv = /(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/i.exec(f.description || '');
      const dcM = /DC\s*(\d+)/.exec(f.description || '');
      const dmgM = /\(?(\d+d\d+(?:\s*[+-]\s*\d+)?)\)?\s*(\w+)\s+damage/i.exec(f.description || '');
      const isAttack = r && r.attackBonus != null;
      const isSave = !isAttack && sv && dcM;
      const row = {
        name: f.name,
        note: isAttack ? [fmtMod(r.attackBonus), r.damageExpr ? r.damageExpr + (r.damageType ? ' ' + r.damageType : '') : null].filter(Boolean).join(' · ') : isSave ? `${sv[1].slice(0, 3)} DC ${dcM[1]}` : '',
        desc: f.description,
        roll: isAttack ? () => rollAttack(displayName, f.name, r.attackBonus, r.damageExpr ? { dice: r.damageExpr, type: r.damageType } : null, selfId)
          : isSave ? () => rollSave(displayName, f.name, sv[1][0].toUpperCase() + sv[1].slice(1).toLowerCase(), parseInt(dcM[1], 10), dmgM ? { dice: dmgM[1].replace(/\s+/g, ''), type: dmgM[2].toLowerCase() } : null, selfId)
          : null,
        use: !isAttack && !isSave && /^(Action|Bonus|Reaction|Legendary)/i.test(String(f.category || '')) ? () => useOn(displayName, f.name, selfId) : null,
      };
      const cat = String(f.category || '');
      if (/^Bonus/i.test(cat)) groups.bonus.push(row);
      else if (/^Reaction/i.test(cat)) groups.reactions.push(row);
      else if (/^(Action|Legendary)/i.test(cat)) groups.actions.push(row);
      else groups.extra.push(row);
    });
    const spellRefs = window.AxisPlayMode.extractSpellRefs(feats);
    spellRefs.forEach((ref) => groups.extra.push({ name: ref.rawName, note: ref.spell ? 'spell' : 'spell (not in catalog)', desc: ref.spell ? ref.spell.properties.Description || '' : '' }));
    const chips = [];
    if (inst) (inst.conditions || []).forEach((c) => chips.push({ label: c.name + (c.duration != null ? ` · ${c.duration} rd${c.duration === 1 ? '' : 's'}` : ''), cond: true, remove: () => State.removeInstanceCondition(ctx.adventureId, ctx.sceneHash, inst.instanceId, c.id) }));
    const listy = (v) => (Array.isArray(v) ? v.join(', ') : v ? String(v) : '');
    if (p['Damage Resistances']) chips.push({ label: 'Resist: ' + listy(p['Damage Resistances']) });
    if (p['Damage Immunities']) chips.push({ label: 'Immune: ' + listy(p['Damage Immunities']) });
    if (p['Condition Immunities']) chips.push({ label: 'Immune: ' + listy(p['Condition Immunities']) });
    if (p['Damage Vulnerabilities']) chips.push({ label: 'Vulnerable: ' + listy(p['Damage Vulnerabilities']) });
    const dcM = /spell save DC (\d+)/i.exec(feats.map((f) => f.description || '').join(' '));
    return {
      name: displayName,
      kind: found.kind,
      subtitle: [p['Printed Type Line'], p['Challenge Rating'] && p['Challenge Rating'].Printed ? 'CR ' + p['Challenge Rating'].Printed : null].filter(Boolean).join(' · '),
      hp: inst ? { cur: toInt(inst.hpCurrent), max: toInt(inst.hpMax), set: (n) => State.setInstanceHp(ctx.adventureId, ctx.sceneHash, inst.instanceId, n) } : { cur: toInt(p['Hit Points']), max: toInt(p['Hit Points']), set: null },
      ac: p['Armor Class'] != null ? p['Armor Class'] : null,
      init: inst ? inst.initiative : null,
      dc: dcM ? 'DC ' + dcM[1] : null,
      chips,
      resources: [],
      groups,
      extraLabel: 'Traits',
      sheetLabel: 'Stats',
      sheetNode: () => statBlock(found.name, found.properties, found.features),
      addCondition: inst ? (n, r) => State.addInstanceCondition(ctx.adventureId, ctx.sceneHash, inst.instanceId, n, r) : null,
    };
  }

  function modelFor(sel) {
    if (sel.kind === 'instance') {
      const combat = State.combatState(sel.adventureId, sel.sceneHash);
      const inst = combat && (combat.instances || []).find((i) => i.instanceId === sel.instanceId);
      if (!inst) return null;
      const ctx = { adventureId: sel.adventureId, sceneHash: sel.sceneHash };
      if (inst.sourceKind === 'party') {
        const m = State.member(inst.defRef);
        return m ? partyModel(m, inst, ctx) : null;
      }
      if (inst.sourceKind === 'companion') {
        const c = State.companionFor(inst.defRef);
        return c ? blockModel({ kind: 'companion', name: c.companion.name, properties: c.companion.statblock, features: c.companion.features }, inst, ctx, inst.displayName) : null;
      }
      const found = resolveEntity(inst.defRef, data.adversaries, data.npcs);
      return found ? blockModel(found, inst, ctx, inst.displayName) : null;
    }
    if (sel.kind === 'party') {
      const m = State.member(sel.id);
      return m ? partyModel(m, null, {}) : null;
    }
    if (sel.kind === 'ref') {
      const found = resolveEntity(sel.ref, data.adversaries, data.npcs);
      return found ? blockModel(found, null, {}, found.name) : null;
    }
    if (sel.kind === 'entity' && (sel.bucket === 'adversaries' || sel.bucket === 'npcs')) {
      const rows = data[sel.bucket] || [];
      const row = rows.find((r) => r.hash === sel.hash) || rows.find((r) => r.name === sel.name);
      if (!row) return null;
      const found = sel.bucket === 'adversaries' ? { kind: 'adversary', name: row.name, properties: row.properties, features: row.features } : { kind: 'npc', name: row.name, properties: row.statblock || {}, features: row.features || [] };
      return blockModel(found, null, {}, row.name);
    }
    return null;
  }

  // ── render ─────────────────────────────────────────────────────────
  function render(container, sel, redraw) {
    const m = modelFor(sel);
    if (!m) return false;
    container.innerHTML = '';

    // header
    container.appendChild(el('div', { class: 'ins-head' }, [
      el('span', { class: 'ins-name' }, [m.name]),
      el('span', { class: 'cc-kind' }, [m.kind]),
    ]));
    if (m.subtitle) container.appendChild(el('div', { class: 'ins-sub' }, [m.subtitle]));

    // banner
    const frac = m.hp.max ? Math.max(0, Math.min(1, (m.hp.cur || 0) / m.hp.max)) : null;
    const amount = el('input', { type: 'number', class: 'hp-current-input hp-amount', value: '1', min: '1' });
    const minus = el('button', { class: 'btn btn-ghost hp-btn' }, ['−']);
    const plus = el('button', { class: 'btn btn-ghost hp-btn' }, ['+']);
    const delta = (sign) => {
      if (!m.hp.set) return;
      const n = parseInt(amount.value, 10) || 0;
      m.hp.set(Math.max(0, Math.min(m.hp.max != null ? Math.max(m.hp.max, m.hp.cur || 0) : Infinity, (m.hp.cur || 0) + sign * n)));
      redraw();
    };
    minus.addEventListener('click', () => delta(-1));
    plus.addEventListener('click', () => delta(1));
    minus.disabled = plus.disabled = !m.hp.set;
    const bar = frac != null ? el('div', { class: 'hp-bar ins-bar' + (frac <= 0.25 ? ' crit' : frac <= 0.5 ? ' bloodied' : '') }, [el('div', { class: 'hp-bar-fill', style: `width:${Math.round(frac * 100)}%` })]) : null;

    const condAdd = el('div', { class: 'chiprow cc-cond-add' });
    condAdd.hidden = true;
    if (m.addCondition) {
      const sel2 = el('select', { class: 'hp-current-input' });
      sel2.appendChild(el('option', { value: '' }, ['condition…']));
      (window.AxisPlayMode.CONDITION_NAMES || []).forEach((n) => sel2.appendChild(el('option', { value: n }, [n])));
      const rounds = el('input', { type: 'number', class: 'hp-current-input hp-amount', placeholder: 'rounds' });
      const apply = el('button', { class: 'btn btn-ghost' }, ['Apply']);
      apply.addEventListener('click', () => {
        if (!sel2.value) return;
        m.addCondition(sel2.value, rounds.value);
        redraw();
      });
      condAdd.appendChild(sel2);
      condAdd.appendChild(rounds);
      condAdd.appendChild(apply);
    }
    const addChip = el('button', { class: 'chip chip-btn on', type: 'button' }, ['+ condition']);
    addChip.hidden = !m.addCondition;
    addChip.addEventListener('click', () => { condAdd.hidden = !condAdd.hidden; });

    container.appendChild(el('div', { class: 'ins-banner' }, [
      el('div', { class: 'ins-hp-row' }, [
        el('span', { class: 'ins-hp' }, [m.hp.cur != null ? String(m.hp.cur) : '—', el('span', { class: 'ins-hp-max' }, [m.hp.max != null ? ` / ${m.hp.max}` : ''])]),
        bar,
        m.hp.set ? el('span', { class: 'cc-hp-ctl' }, [minus, amount, plus]) : null,
      ]),
      el('div', { class: 'ins-nums' }, [
        m.ac != null ? el('span', {}, [`AC ${m.ac}`]) : null,
        m.init != null ? el('span', {}, [`Init ${m.init}`]) : null,
        m.dc ? el('span', {}, [m.dc]) : null,
      ]),
      el('div', { class: 'chiprow ins-chips' }, [
        ...m.chips.map((c) => el('span', { class: 'chip' + (c.cond ? ' condition-chip' : '') }, [c.label, c.remove ? el('button', { class: 'condition-remove', onclick: () => { c.remove(); redraw(); } }, ['✕']) : null])),
        addChip,
      ]),
      condAdd,
      m.resources.length ? el('div', { class: 'ins-resources' }, m.resources.map((r) => el('span', { class: 'ins-res' }, [el('span', { class: 'ins-res-label' }, [r.label]), el('span', { class: 'ins-res-val' }, [r.text])]))) : null,
    ]));

    // tabs
    const tabs = [
      ['actions', 'Actions', m.groups.actions],
      ['bonus', 'Bonus', m.groups.bonus],
      ['reactions', 'Reactions', m.groups.reactions],
      ['extra', m.extraLabel, m.groups.extra],
      ['sheet', m.sheetLabel, null],
    ];
    if (!tabs.some((t) => t[0] === tab)) tab = 'actions';
    const tabRow = el('div', { class: 'ins-tabs' }, tabs.map(([id, label, rows]) => {
      const b = el('button', { class: 'ins-tab' + (id === tab ? ' on' : ''), type: 'button' }, [label + (rows ? ` · ${rows.length}` : '')]);
      b.addEventListener('click', () => { tab = id; redraw(); });
      return b;
    }));
    container.appendChild(tabRow);

    const body = el('div', { class: 'ins-body' });
    const current = tabs.find((t) => t[0] === tab);
    if (current[2]) {
      if (!current[2].length) body.appendChild(el('div', { class: 'inspector-empty' }, ['Nothing here.']));
      current[2].forEach((row) => {
        const act = row.roll || row.use;
        const nameNode = act ? el('button', { class: 'btn ins-roll' + (row.roll ? '' : ' btn-ghost'), type: 'button', title: row.roll ? 'Roll against a target' : 'Use on a target' }, [row.name + (row.roll ? ' 🎲' : ' →')]) : el('span', { class: 'ins-act-name' }, [row.name]);
        if (act) nameNode.addEventListener('click', act);
        const desc = el('div', { class: 'ins-act-desc', html: markdownish(row.desc || '') });
        const head = el('div', { class: 'ins-act-head' }, [nameNode, row.note ? el('span', { class: 'ins-act-note' }, [row.note]) : null]);
        head.addEventListener('click', (e) => { if (!e.target.closest('button')) desc.classList.toggle('open'); });
        body.appendChild(el('div', { class: 'ins-act' }, [head, desc]));
      });
    } else {
      body.appendChild(m.sheetNode());
    }
    container.appendChild(body);
    return true;
  }

  return { render, modelFor };
})();
