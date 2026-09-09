// creator.js — character creator and level-up wizard, built entirely
// from the corpus: SRD 5.2.1 species, backgrounds, classes and feats plus
// the Axis preview's subclasses and items. The wizard keeps its choices
// as `build` on the member, derives the same snapshot shape the D&D
// Beyond paths produce, and can be reopened to level up.
//
// Rules text shown here is the corpus's, verbatim. Derived numbers follow
// the 2024 rules: background gives +2/+1 (or +1/+1/+1) among its three
// abilities and an origin feat; HP is the die's max at level 1 and its
// average (rounded up) after; prepared/cantrip counts and slots come from
// the class progression table.
window.AxisCreator = (function () {
  const { el, markdownish, drawer, fmtMod } = window.AxisRender;
  const State = window.AxisState;
  const data = window.AXIS;

  const ABILITIES = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
  const SKILLS = {
    Acrobatics: 'Dexterity', 'Animal Handling': 'Wisdom', Arcana: 'Intelligence', Athletics: 'Strength', Deception: 'Charisma',
    History: 'Intelligence', Insight: 'Wisdom', Intimidation: 'Charisma', Investigation: 'Intelligence', Medicine: 'Wisdom',
    Nature: 'Intelligence', Perception: 'Wisdom', Performance: 'Charisma', Persuasion: 'Charisma', Religion: 'Intelligence',
    'Sleight of Hand': 'Dexterity', Stealth: 'Dexterity', Survival: 'Wisdom',
  };
  const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
  const POINT_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
  const ASI_LEVELS = [4, 8, 12, 16, 19];
  // progression columns that are not per-rest resources
  const NOT_RESOURCES = ['Proficiency Bonus', 'Class Features', 'Cantrips', 'Prepared Spells', 'Spell Slots', 'Slot Level', 'Weapon Mastery', 'Eldritch Invocations', 'Rage Damage', 'Martial Arts', 'Sneak Attack', 'Unarmored Movement', 'Infusions Known', 'Invocations Known'];
  const SHORT_REST = ['Channel Divinity', 'Focus Points', 'Ki Points', 'Second Wind', 'Action Surge', 'Bardic Inspiration', 'Wild Shape'];

  // ── corpus access ──────────────────────────────────────────────────
  const rules = (ext) => data.rules.filter((r) => r.extends === ext);
  const byName = (rows, name) => rows.find((r) => r.name === name) || null;
  function list(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    try {
      const j = JSON.parse(v);
      if (Array.isArray(j)) return j;
    } catch (e) {
      /* not JSON */
    }
    return String(v).split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  }
  const classes = () => rules('Class');
  const species = () => rules('Species');
  const backgrounds = () => rules('Background');
  const feats = () => rules('Feat');
  const subclassesOf = (cls) => data.subclasses.filter((s) => s.properties['Parent Class'] === cls);
  const levelFeatures = (row, maxLevel) =>
    (row.features || [])
      .map((f) => {
        const m = /^Level (\d+):\s*(.*)$/.exec(f.name);
        return m ? { level: parseInt(m[1], 10), name: m[2], description: f.description || '' } : null;
      })
      .filter((f) => f && f.level <= maxLevel);
  const dieOf = (cls) => {
    const m = /D(\d+)/i.exec(cls.properties['Hit Point Die'] || '');
    return m ? parseInt(m[1], 10) : 8;
  };
  const progression = (cls, level) => (cls.properties.Progression || {})['Level ' + level] || {};
  const mod = (score) => Math.floor((score - 10) / 2);
  const num = (v) => {
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };

  // ── the build ──────────────────────────────────────────────────────
  function newBuild() {
    return {
      name: '',
      level: 1,
      method: 'pointbuy',
      base: { Strength: 8, Dexterity: 8, Constitution: 8, Intelligence: 8, Wisdom: 8, Charisma: 8 },
      species: null,
      background: null,
      bgBonus: { mode: '2+1', plus2: null, plus1: null, ones: [] },
      className: null,
      subclass: null,
      skills: [],
      equipmentOption: 'A',
      extraItems: [],
      languages: ['Common'],
      asi: {}, // level -> { kind: 'feat'|'asi', feat, scores: { Ability: n } }
      cantrips: [],
      prepared: [],
      notes: '',
    };
  }

  // ── derive the snapshot ────────────────────────────────────────────
  function abilities(build) {
    const out = Object.assign({}, build.base);
    const bg = build.bgBonus || {};
    if (bg.mode === '2+1') {
      if (bg.plus2) out[bg.plus2] += 2;
      if (bg.plus1) out[bg.plus1] += 1;
    } else (bg.ones || []).forEach((a) => (out[a] += 1));
    Object.keys(build.asi || {}).forEach((lv) => {
      const a = build.asi[lv];
      if (a && a.kind === 'asi' && a.scores) Object.keys(a.scores).forEach((k) => (out[k] += a.scores[k] || 0));
    });
    ABILITIES.forEach((a) => (out[a] = Math.min(20, out[a])));
    return out;
  }

  function armorItems() {
    return data.items.filter((i) => i.extends === 'Armor');
  }
  function weaponItems() {
    return data.items.filter((i) => i.extends === 'Weapon');
  }

  function equipmentList(build) {
    const cls = byName(classes(), build.className);
    const bg = byName(backgrounds(), build.background);
    const out = [];
    const gold = { gp: 0 };
    const take = (opt) => {
      if (!opt) return;
      list(opt).forEach((raw) => {
        const g = /^(\d+)\s*GP$/i.exec(raw);
        if (g) {
          gold.gp += parseInt(g[1], 10);
          return;
        }
        const q = /^(\d+)\s+(.+)$/.exec(raw);
        const name = q ? q[2].replace(/s$/, '') : raw;
        const qty = q ? parseInt(q[1], 10) : 1;
        const existing = out.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (existing) existing.quantity += qty;
        else out.push({ name, quantity: qty });
      });
    };
    if (cls && cls.properties['Starting Equipment']) take(cls.properties['Starting Equipment']['Option ' + (build.equipmentOption || 'A')]);
    if (bg && bg.properties.Equipment) take(bg.properties.Equipment['Option ' + (build.bgEquipmentOption || 'A')]);
    (build.extraItems || []).forEach((e) => out.push({ name: e.name, quantity: e.quantity || 1 }));
    return { items: out, gold: gold.gp };
  }

  function findItem(name) {
    const n = String(name).toLowerCase().replace(/\s*\(.*\)$/, '');
    return data.items.find((i) => i.name.toLowerCase() === n) || data.items.find((i) => i.name.toLowerCase().replace(/s$/, '') === n.replace(/s$/, '')) || null;
  }

  function armorClass(build, ab, items) {
    const dex = mod(ab.Dexterity);
    let best = { value: 10 + dex, note: 'unarmored' };
    if (build.className === 'Barbarian') best = { value: 10 + dex + mod(ab.Constitution), note: 'Unarmored Defense' };
    if (build.className === 'Monk') best = { value: 10 + dex + mod(ab.Wisdom), note: 'Unarmored Defense' };
    let shield = 0;
    items.forEach((it) => {
      const row = findItem(it.name);
      // the SRD prints Shield in the armor table but not as its own item
      if (!row && /^shield$/i.test(String(it.name).trim())) {
        shield = Math.max(shield, 2);
        return;
      }
      if (!row || row.extends !== 'Armor') return;
      const cat = String(row.properties.Category || '');
      const base = num(row.properties['Base Armor Class']);
      if (/shield/i.test(row.name) || /shield/i.test(cat)) {
        shield = Math.max(shield, base || 2);
        return;
      }
      if (base == null) return;
      let v = base;
      if (/light/i.test(cat)) v += dex;
      else if (/medium/i.test(cat)) v += Math.min(2, dex);
      if (v > best.value) best = { value: v, note: row.name };
    });
    return { value: best.value + shield, note: best.note + (shield ? ' + shield' : '') };
  }

  function weaponActions(build, ab, pb, items, cls) {
    const profs = list(cls ? cls.properties['Weapon Proficiencies'] : []).map((s) => s.toLowerCase());
    const out = [];
    items.forEach((it, i) => {
      const row = findItem(it.name);
      if (!row || row.extends !== 'Weapon') return;
      const props = list(row.properties.Properties).map(String);
      const cat = String(row.properties.Category || '');
      const ranged = /ranged/i.test(cat);
      const finesse = props.some((p) => /finesse/i.test(p));
      const abMod = finesse ? Math.max(mod(ab.Strength), mod(ab.Dexterity)) : ranged ? mod(ab.Dexterity) : mod(ab.Strength);
      const proficient = profs.some((p) => cat.toLowerCase().indexOf(p) !== -1) || profs.some((p) => p === row.name.toLowerCase());
      const dice = row.properties.Damage;
      out.push({
        key: 'wpn:' + i,
        name: row.name,
        source: 'weapon',
        activation: 'action',
        description: [props.join(', '), row.properties.Mastery ? 'Mastery: ' + row.properties.Mastery : ''].filter(Boolean).join(' · '),
        attackBonus: abMod + (proficient ? pb : 0),
        damage: dice ? { dice: `${dice}${abMod ? fmtMod(abMod) : ''}`, type: String(row.properties['Damage Type'] || '').toLowerCase() || null } : null,
        save: null,
        resourceKey: null,
        range: null,
      });
    });
    return out;
  }

  function spellRow(name) {
    return data.spells.find((s) => s.name === name) || null;
  }

  function spellEntry(row, i, casting, pb, ab) {
    const p = row.properties;
    const desc = String(p.Description || '');
    const saveM = /(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/i.exec(desc);
    const dmgM = /(\d+d\d+)\s+(\w+)\s+damage/i.exec(desc);
    const castMod = casting ? mod(ab[casting]) : 0;
    const level = num(p.Level) || 0;
    return {
      key: 'spl:' + i,
      name: row.name,
      level,
      school: p.School || null,
      prepared: true,
      description: desc,
      activation: /bonus action/i.test(p['Casting Time'] || '') ? 'bonus' : /reaction/i.test(p['Casting Time'] || '') ? 'reaction' : 'action',
      concentration: /concentration/i.test(p.Duration || ''),
      ritual: /ritual/i.test(p['Casting Time'] || '') || row.name.indexOf('[R]') !== -1,
      castingAbility: casting,
      attack: /spell attack/i.test(desc),
      attackBonus: /spell attack/i.test(desc) ? pb + castMod : null,
      save: saveM ? { ability: saveM[1][0].toUpperCase() + saveM[1].slice(1).toLowerCase(), dc: 8 + pb + castMod } : null,
      damage: dmgM ? { dice: dmgM[1], type: dmgM[2].toLowerCase() } : null,
      healing: null,
      usesSlot: level > 0,
      resourceKey: null,
      source: 'Prepared',
      range: p.Range || '',
      components: p.Components || '',
      duration: p.Duration || '',
    };
  }

  function snapshotFrom(build) {
    const cls = byName(classes(), build.className);
    const sp = byName(species(), build.species);
    const bg = byName(backgrounds(), build.background);
    const sub = build.subclass ? byName(data.subclasses, build.subclass) : null;
    const level = Math.max(1, Math.min(20, build.level || 1));
    const ab = abilities(build);
    const prog = cls ? progression(cls, level) : {};
    const pb = num(prog['Proficiency Bonus']) || Math.floor((level - 1) / 4) + 2;
    const die = cls ? dieOf(cls) : 8;
    const con = mod(ab.Constitution);
    const hpMax = Math.max(1, die + con + (level - 1) * (Math.floor(die / 2) + 1 + con));

    const saveProfs = cls ? list(cls.properties['Saving Throw Proficiencies']) : [];
    const savingThrows = {};
    ABILITIES.forEach((a) => (savingThrows[a] = { proficient: saveProfs.indexOf(a) !== -1, modifier: mod(ab[a]) + (saveProfs.indexOf(a) !== -1 ? pb : 0) }));
    const skillProfs = new Set((build.skills || []).concat(bg ? list(bg.properties['Skill Proficiencies']) : []));
    const skills = {};
    Object.keys(SKILLS).forEach((s) => (skills[s] = { ability: SKILLS[s], proficient: skillProfs.has(s), expertise: false, modifier: mod(ab[SKILLS[s]]) + (skillProfs.has(s) ? pb : 0) }));

    const eq = equipmentList(build);
    const features = [];
    if (sp) (sp.features || []).forEach((f) => features.push({ name: f.name, category: sp.name + ' trait', description: f.description || '' }));
    if (bg && bg.properties['Origin Feat']) {
      const f = byName(feats(), bg.properties['Origin Feat']);
      features.push({ name: bg.properties['Origin Feat'], category: 'Origin feat (' + bg.name + ')', description: f ? String(f.properties.Description || '') : '' });
    }
    if (cls) levelFeatures(cls, level).forEach((f) => features.push({ name: f.name, category: cls.name + ' ' + f.level, description: f.description }));
    if (sub) levelFeatures(sub, level).forEach((f) => features.push({ name: f.name, category: sub.name + ' ' + f.level, description: f.description }));
    Object.keys(build.asi || {}).forEach((lv) => {
      const a = build.asi[lv];
      if (a && a.kind === 'feat' && a.feat) {
        const f = byName(feats(), a.feat);
        features.push({ name: a.feat, category: 'Feat (level ' + lv + ')', description: f ? String(f.properties.Description || '') : '' });
      }
    });

    const resources = [];
    Object.keys(prog).forEach((k) => {
      if (NOT_RESOURCES.indexOf(k) !== -1) return;
      const n = num(prog[k]);
      if (n == null || typeof prog[k] === 'object') return;
      resources.push({ key: 'res:' + k.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: k, max: n, used: 0, reset: SHORT_REST.indexOf(k) !== -1 ? 'short' : 'long' });
    });

    let spellSlots = [];
    let pactMagic = [];
    const slots = prog['Spell Slots'];
    if (slots && typeof slots === 'object') {
      spellSlots = Object.keys(slots).map((k) => ({ level: num(k.replace(/\D/g, '')) || 0, max: num(slots[k]) || 0, used: 0 })).filter((s) => s.level && s.max);
    } else if (num(slots) && prog['Slot Level']) {
      pactMagic = [{ level: num(prog['Slot Level']), max: num(slots), used: 0 }];
    }
    const casting = cls ? cls.properties['Spellcasting Ability'] || null : null;
    const spells = [];
    (build.cantrips || []).concat(build.prepared || []).forEach((n, i) => {
      const row = spellRow(n);
      if (row) spells.push(spellEntry(row, i, casting, pb, ab));
    });
    spells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

    const speedM = /(\d+)/.exec(sp ? sp.properties.Speed || '' : '');
    const senses = {};
    (sp ? sp.features || [] : []).forEach((f) => {
      const d = /Darkvision.*?(\d+)\s*feet/i.exec((f.name || '') + ' ' + (f.description || ''));
      if (d) senses.Darkvision = parseInt(d[1], 10);
    });

    return {
      importedFrom: 'creator',
      build: JSON.parse(JSON.stringify(build)),
      name: build.name || 'Unnamed',
      race: sp ? sp.name : null,
      background: bg ? bg.name : null,
      classes: cls ? [{ name: cls.name, level, subclass: sub ? sub.name : null, spellcastingAbility: casting }] : [],
      totalLevel: level,
      proficiencyBonus: pb,
      abilities: ab,
      abilityMods: ABILITIES.reduce((acc, a) => ((acc[a] = mod(ab[a])), acc), {}),
      ac: armorClass(build, ab, eq.items),
      hpMax,
      removedHp: 0,
      tempHp: 0,
      hitDice: `${level}d${die}`,
      deathSaves: { success: 0, fail: 0 },
      inspiration: false,
      currencies: { gp: eq.gold },
      speed: { walk: speedM ? parseInt(speedM[1], 10) : 30 },
      senses,
      languages: build.languages || ['Common'],
      savingThrows,
      skills,
      features,
      actions: weaponActions(build, ab, pb, eq.items, cls),
      resources,
      spellSlots,
      pactMagic,
      spellcasting: { ability: casting, dc: casting ? 8 + pb + mod(ab[casting]) : null, attack: casting ? pb + mod(ab[casting]) : null },
      spells,
      equipment: eq.items.map((it, i) => {
        const row = findItem(it.name);
        const wearable = !!(row && (row.extends === 'Armor' || row.extends === 'Weapon')) || /^shield$/i.test(String(it.name).trim());
        return { key: 'item:' + i, name: it.name, quantity: it.quantity, equipped: wearable, type: row ? row.extends : null, description: row ? String(row.properties.Description || '') : '', charges: null };
      }),
      companions: [],
      importedAt: new Date().toISOString(),
    };
  }

  // ── wizard UI ──────────────────────────────────────────────────────
  const STEPS = ['Basics', 'Species', 'Background', 'Class', 'Feats', 'Spells', 'Review'];

  function open(member) {
    const build = member && member.snapshot && member.snapshot.build ? JSON.parse(JSON.stringify(member.snapshot.build)) : newBuild();
    let step = 0;
    const root = el('div', { class: 'creator' });
    const overlay = drawer(root);

    function summary() {
      const s = snapshotFrom(build);
      return el('div', { class: 'creator-summary' }, [
        el('div', { class: 'cs-name' }, [s.name]),
        el('div', { class: 'view-sub' }, [[s.race, s.classes[0] ? `${s.classes[0].name} ${s.totalLevel}${s.classes[0].subclass ? ' (' + s.classes[0].subclass + ')' : ''}` : null, s.background].filter(Boolean).join(' · ')]),
        el('div', { class: 'cs-grid' }, ABILITIES.map((a) => el('div', { class: 'ability-box' }, [el('div', { class: 'lbl' }, [a.slice(0, 3).toUpperCase()]), el('div', { class: 'val' }, [`${s.abilities[a]} (${fmtMod(s.abilityMods[a])})`])]))),
        el('div', { class: 'chiprow' }, [el('span', { class: 'chip' }, [`HP ${s.hpMax}`]), el('span', { class: 'chip' }, [`AC ${s.ac.value}`]), el('span', { class: 'chip' }, [`PB ${fmtMod(s.proficiencyBonus)}`]), s.spellcasting.dc ? el('span', { class: 'chip' }, [`Spell DC ${s.spellcasting.dc}`]) : null]),
      ]);
    }

    function draw() {
      root.innerHTML = '';
      const nav = el('div', { class: 'creator-steps' }, STEPS.map((s, i) => {
        const b = el('button', { class: 'creator-step' + (i === step ? ' active' : ''), type: 'button' }, [`${i + 1}. ${s}`]);
        b.addEventListener('click', () => { step = i; draw(); });
        return b;
      }));
      const body = el('div', { class: 'creator-body' });
      body.appendChild([basics, speciesStep, backgroundStep, classStep, featsStep, spellsStep, review][step]());
      const prev = el('button', { class: 'btn btn-ghost' }, ['◀ Back']);
      prev.disabled = step === 0;
      prev.addEventListener('click', () => { step -= 1; draw(); });
      const next = el('button', { class: 'btn' }, [step === STEPS.length - 1 ? (member ? 'Save changes' : 'Create character') : 'Next ▶']);
      next.addEventListener('click', () => {
        if (step < STEPS.length - 1) {
          step += 1;
          draw();
          return;
        }
        const snap = snapshotFrom(build);
        if (member) State.resyncPartyMember(member.id, snap);
        else State.addPartyMember(snap);
        overlay.remove();
        if (window.AxisApp) window.AxisApp.refreshNav();
        if (window.AxisParty && window.AxisParty.rerender) window.AxisParty.rerender();
      });
      root.appendChild(el('div', { class: 'creator-head' }, [el('h2', {}, [member ? 'Edit ' + (build.name || 'character') : 'Create a character']), summary()]));
      root.appendChild(nav);
      root.appendChild(body);
      root.appendChild(el('div', { class: 'chiprow creator-nav' }, [prev, next]));
    }

    function field(label, node) {
      return el('label', { class: 'creator-field' }, [el('span', { class: 'cf-label' }, [label]), node]);
    }

    function textInput(value, onChange, attrs) {
      const i = el('input', Object.assign({ type: 'text', class: 'searchbar' }, attrs || {}));
      i.value = value == null ? '' : value;
      i.addEventListener('change', () => onChange(i.value));
      return i;
    }

    function select(options, value, onChange, placeholder) {
      const s = el('select', { class: 'searchbar' });
      if (placeholder) s.appendChild(el('option', { value: '' }, [placeholder]));
      options.forEach((o) => {
        const opt = el('option', { value: o.value }, [o.label]);
        if (o.value === value) opt.selected = true;
        s.appendChild(opt);
      });
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }

    function pickList(rows, value, onPick, render) {
      return el('div', { class: 'creator-pick' }, rows.map((r) => {
        const card = el('div', { class: 'card pick-card' + (r.name === value ? ' active' : '') }, render(r));
        card.addEventListener('click', () => onPick(r.name));
        return card;
      }));
    }

    // 1 ────────────────────────────────────────────────────────────────
    function basics() {
      const wrap = el('div', {});
      wrap.appendChild(field('Name', textInput(build.name, (v) => { build.name = v; draw(); })));
      wrap.appendChild(field('Level', select(Array.from({ length: 20 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), String(build.level), (v) => { build.level = parseInt(v, 10); draw(); })));
      wrap.appendChild(field('Ability scores', select([{ value: 'pointbuy', label: 'Point buy (27 points)' }, { value: 'array', label: 'Standard array (15 14 13 12 10 8)' }, { value: 'manual', label: 'Enter scores' }], build.method, (v) => {
        build.method = v;
        if (v === 'array') ABILITIES.forEach((a, i) => (build.base[a] = STANDARD_ARRAY[i]));
        if (v === 'pointbuy') ABILITIES.forEach((a) => (build.base[a] = Math.max(8, Math.min(15, build.base[a]))));
        draw();
      })));
      const spent = ABILITIES.reduce((sum, a) => sum + (POINT_COST[build.base[a]] != null ? POINT_COST[build.base[a]] : 0), 0);
      if (build.method === 'pointbuy') wrap.appendChild(el('div', { class: 'view-sub' + (spent > 27 ? ' session-error' : '') }, [`${spent} / 27 points spent`]));
      const grid = el('div', { class: 'creator-scores' }, ABILITIES.map((a) => {
        let ctl;
        if (build.method === 'array') {
          ctl = select(STANDARD_ARRAY.map((n) => ({ value: String(n), label: String(n) })), String(build.base[a]), (v) => { build.base[a] = parseInt(v, 10); draw(); });
        } else if (build.method === 'pointbuy') {
          ctl = select(Object.keys(POINT_COST).map((n) => ({ value: n, label: `${n} (${POINT_COST[n]} pt)` })), String(build.base[a]), (v) => { build.base[a] = parseInt(v, 10); draw(); });
        } else {
          ctl = el('input', { type: 'number', class: 'hp-current-input', min: '1', max: '20' });
          ctl.value = String(build.base[a]);
          ctl.addEventListener('change', () => { build.base[a] = Math.max(1, Math.min(20, parseInt(ctl.value, 10) || 8)); draw(); });
        }
        return el('div', { class: 'creator-score' }, [el('b', {}, [a]), ctl]);
      }));
      wrap.appendChild(grid);
      wrap.appendChild(field('Languages', textInput((build.languages || []).join(', '), (v) => { build.languages = v.split(/,\s*/).filter(Boolean); }, { placeholder: 'Common, Elvish' })));
      return wrap;
    }

    // 2 ────────────────────────────────────────────────────────────────
    function speciesStep() {
      const wrap = el('div', {});
      wrap.appendChild(pickList(species(), build.species, (n) => { build.species = n; draw(); }, (r) => [
        el('h3', {}, [r.name]),
        el('div', { class: 'tag' }, [[r.properties.Size, r.properties.Speed].filter(Boolean).join(' · ')]),
        el('div', { class: 'excerpt' }, [(r.features || []).map((f) => f.name).join(', ')]),
      ]));
      const chosen = byName(species(), build.species);
      if (chosen) wrap.appendChild(el('div', { class: 'creator-detail' }, (chosen.features || []).map((f) => el('div', { class: 'feature' }, [el('span', { class: 'fname' }, [f.name]), el('div', { html: markdownish(f.description || '') })]))));
      return wrap;
    }

    // 3 ────────────────────────────────────────────────────────────────
    function backgroundStep() {
      const wrap = el('div', {});
      wrap.appendChild(pickList(backgrounds(), build.background, (n) => { build.background = n; build.bgBonus = { mode: '2+1', plus2: null, plus1: null, ones: [] }; draw(); }, (r) => [
        el('h3', {}, [r.name]),
        el('div', { class: 'tag' }, [list(r.properties['Ability Scores']).join(' / ')]),
        el('div', { class: 'excerpt' }, [`Feat: ${r.properties['Origin Feat'] || '—'} · Skills: ${list(r.properties['Skill Proficiencies']).join(', ')}`]),
      ]));
      const bg = byName(backgrounds(), build.background);
      if (!bg) return wrap;
      const opts = list(bg.properties['Ability Scores']);
      const bb = build.bgBonus;
      wrap.appendChild(field('Ability bonus', select([{ value: '2+1', label: '+2 and +1' }, { value: '1+1+1', label: '+1 to all three' }], bb.mode, (v) => { bb.mode = v; bb.ones = v === '1+1+1' ? opts.slice() : []; draw(); })));
      if (bb.mode === '2+1') {
        wrap.appendChild(field('+2', select(opts.map((a) => ({ value: a, label: a })), bb.plus2, (v) => { bb.plus2 = v; if (bb.plus1 === v) bb.plus1 = null; draw(); }, 'choose…')));
        wrap.appendChild(field('+1', select(opts.filter((a) => a !== bb.plus2).map((a) => ({ value: a, label: a })), bb.plus1, (v) => { bb.plus1 = v; draw(); }, 'choose…')));
      }
      if (bg.properties.Equipment) {
        wrap.appendChild(field('Equipment', select(Object.keys(bg.properties.Equipment).map((k) => ({ value: k.replace('Option ', ''), label: `${k}: ${list(bg.properties.Equipment[k]).join(', ')}` })), build.bgEquipmentOption || 'A', (v) => { build.bgEquipmentOption = v; draw(); })));
      }
      const feat = byName(feats(), bg.properties['Origin Feat']);
      if (feat) wrap.appendChild(el('div', { class: 'creator-detail' }, [el('div', { class: 'feature' }, [el('span', { class: 'fname' }, [feat.name]), el('span', { class: 'fcat' }, ['origin feat']), el('div', { html: markdownish(String(feat.properties.Description || '')) })])]));
      return wrap;
    }

    // 4 ────────────────────────────────────────────────────────────────
    function classStep() {
      const wrap = el('div', {});
      wrap.appendChild(pickList(classes(), build.className, (n) => { build.className = n; build.subclass = null; build.skills = []; build.cantrips = []; build.prepared = []; draw(); }, (r) => [
        el('h3', {}, [r.name]),
        el('div', { class: 'tag' }, [`${r.properties['Hit Point Die'] || ''} · ${r.properties['Primary Ability'] || ''}`]),
        el('div', { class: 'excerpt' }, [`Saves: ${list(r.properties['Saving Throw Proficiencies']).join(', ')}`]),
      ]));
      const cls = byName(classes(), build.className);
      if (!cls) return wrap;
      const subs = subclassesOf(cls.name);
      if (subs.length && build.level >= 3) {
        wrap.appendChild(field('Subclass', select(subs.map((s) => ({ value: s.name, label: s.name + (s.thirdParty ? ' (Axis)' : '') })), build.subclass, (v) => { build.subclass = v || null; draw(); }, 'choose…')));
        const sub = build.subclass ? byName(data.subclasses, build.subclass) : null;
        if (sub) wrap.appendChild(el('div', { class: 'creator-detail' }, [el('div', { html: markdownish(String(sub.properties.Description || '')) }), ...levelFeatures(sub, build.level).map((f) => el('div', { class: 'feature' }, [el('span', { class: 'fname' }, [f.name]), el('span', { class: 'fcat' }, ['level ' + f.level]), el('div', { html: markdownish(f.description) })]))]));
      }
      const sc = cls.properties['Skill Choices'] || {};
      const count = num(sc.Count) || 0;
      const options = list(sc.Options);
      if (count) {
        const bgSkills = build.background ? list((byName(backgrounds(), build.background) || { properties: {} }).properties['Skill Proficiencies']) : [];
        wrap.appendChild(el('div', { class: 'cf-label' }, [`Skills: choose ${count} (${(build.skills || []).length} chosen)`]));
        wrap.appendChild(el('div', { class: 'chiprow' }, options.map((s) => {
          const on = (build.skills || []).indexOf(s) !== -1;
          const fromBg = bgSkills.indexOf(s) !== -1;
          const b = el('button', { class: 'chip roll-chip' + (on || fromBg ? ' prof' : ''), type: 'button', title: fromBg ? 'from background' : '' }, [s + (fromBg ? ' ✓' : '')]);
          b.disabled = fromBg;
          b.addEventListener('click', () => {
            if (on) build.skills = build.skills.filter((x) => x !== s);
            else if (build.skills.length < count) build.skills.push(s);
            draw();
          });
          return b;
        })));
      }
      const se = cls.properties['Starting Equipment'];
      if (se) wrap.appendChild(field('Starting equipment', select(Object.keys(se).map((k) => ({ value: k.replace('Option ', ''), label: `${k}: ${list(se[k]).join(', ')}` })), build.equipmentOption || 'A', (v) => { build.equipmentOption = v; draw(); })));
      // extra items from the catalog (Axis artifacts included)
      const search = el('input', { type: 'search', class: 'searchbar', placeholder: 'Add an item (weapons, armor, gear, magic items, artifacts)…' });
      const results = el('div', { class: 'chiprow' });
      search.addEventListener('input', () => {
        results.innerHTML = '';
        const q = search.value.trim().toLowerCase();
        if (q.length < 2) return;
        data.items.concat(data.artifacts || []).filter((i) => i.name.toLowerCase().indexOf(q) !== -1).slice(0, 12).forEach((i) => {
          const b = el('button', { class: 'chip chip-btn', type: 'button' }, ['+ ' + i.name]);
          b.addEventListener('click', () => { (build.extraItems = build.extraItems || []).push({ name: i.name, quantity: 1 }); search.value = ''; draw(); });
          results.appendChild(b);
        });
      });
      wrap.appendChild(field('Extra items', search));
      wrap.appendChild(results);
      if ((build.extraItems || []).length) wrap.appendChild(el('div', { class: 'chiprow' }, build.extraItems.map((it, i) => el('span', { class: 'chip condition-chip' }, [it.name, el('button', { class: 'condition-remove', onclick: () => { build.extraItems.splice(i, 1); draw(); } }, ['✕'])]))));
      wrap.appendChild(el('div', { class: 'creator-detail' }, levelFeatures(cls, build.level).map((f) => el('div', { class: 'feature' }, [el('span', { class: 'fname' }, [f.name]), el('span', { class: 'fcat' }, ['level ' + f.level]), el('div', { html: markdownish(f.description) })]))));
      return wrap;
    }

    // 5 ────────────────────────────────────────────────────────────────
    function featsStep() {
      const wrap = el('div', {});
      const levels = ASI_LEVELS.filter((l) => l <= build.level);
      if (!levels.length) {
        wrap.appendChild(el('div', { class: 'view-sub' }, ['Ability Score Improvements and feats come at levels 4, 8, 12, 16 and 19.']));
        return wrap;
      }
      // any feat the character qualifies for, origin feats included (2024);
      // prerequisites are shown, not enforced
      const general = feats().filter((f) => f.name !== 'Ability Score Improvement').sort((a, b) => a.name.localeCompare(b.name));
      levels.forEach((lv) => {
        const a = (build.asi[lv] = build.asi[lv] || { kind: 'asi', feat: null, scores: {} });
        const box = el('div', { class: 'creator-detail' }, [el('h3', {}, ['Level ' + lv])]);
        box.appendChild(field('Choice', select([{ value: 'asi', label: 'Ability Score Improvement (+2 or +1/+1)' }, { value: 'feat', label: 'Feat' }], a.kind, (v) => { a.kind = v; draw(); })));
        if (a.kind === 'asi') {
          const total = Object.values(a.scores || {}).reduce((s, n) => s + n, 0);
          box.appendChild(el('div', { class: 'view-sub' + (total > 2 ? ' session-error' : '') }, [`${total} / 2 points`]));
          box.appendChild(el('div', { class: 'chiprow' }, ABILITIES.map((ab) => {
            const n = (a.scores || {})[ab] || 0;
            const b = el('button', { class: 'chip roll-chip' + (n ? ' prof' : ''), type: 'button' }, [`${ab.slice(0, 3)} +${n}`]);
            b.addEventListener('click', () => { a.scores[ab] = (n + 1) % 3; draw(); });
            return b;
          })));
        } else {
          box.appendChild(field('Feat', select(general.map((f) => ({ value: f.name, label: f.name })), a.feat, (v) => { a.feat = v; draw(); }, 'choose…')));
          const f = a.feat ? byName(feats(), a.feat) : null;
          if (f) box.appendChild(el('div', { class: 'feature' }, [el('span', { class: 'fcat' }, [String(f.properties.Prerequisite || '')]), el('div', { html: markdownish(String(f.properties.Description || '')) })]));
        }
        wrap.appendChild(box);
      });
      return wrap;
    }

    // 6 ────────────────────────────────────────────────────────────────
    function spellsStep() {
      const wrap = el('div', {});
      const cls = byName(classes(), build.className);
      const prog = cls ? progression(cls, build.level) : {};
      const cantripCount = num(prog.Cantrips) || 0;
      const preparedCount = num(prog['Prepared Spells']) || 0;
      if (!cls || (!cantripCount && !preparedCount)) {
        wrap.appendChild(el('div', { class: 'view-sub' }, ['This class has no spells at this level.']));
        return wrap;
      }
      const slots = prog['Spell Slots'];
      const maxLevel = slots && typeof slots === 'object' ? Math.max.apply(null, Object.keys(slots).map((k) => num(k.replace(/\D/g, '')) || 0)) : num(prog['Slot Level']) || 1;
      const pool = data.spells.filter((s) => list(s.properties.Classes).indexOf(cls.name) !== -1);
      const search = el('input', { type: 'search', class: 'searchbar', placeholder: 'Filter spells…' });
      const listEl = el('div', { class: 'creator-spells' });
      function drawList() {
        listEl.innerHTML = '';
        const q = search.value.trim().toLowerCase();
        pool.filter((s) => (num(s.properties.Level) || 0) <= maxLevel && (!q || s.name.toLowerCase().indexOf(q) !== -1)).forEach((s) => {
          const lvl = num(s.properties.Level) || 0;
          const bucket = lvl === 0 ? build.cantrips : build.prepared;
          const limit = lvl === 0 ? cantripCount : preparedCount;
          const on = bucket.indexOf(s.name) !== -1;
          const b = el('button', { class: 'chip roll-chip' + (on ? ' prof' : ''), type: 'button', title: String(s.properties.Description || '').slice(0, 200) }, [`${s.name} ${lvl ? 'L' + lvl : 'C'}`]);
          b.addEventListener('click', () => {
            if (on) bucket.splice(bucket.indexOf(s.name), 1);
            else if (bucket.length < limit) bucket.push(s.name);
            drawCounts();
            drawList();
          });
          listEl.appendChild(b);
        });
      }
      const counts = el('div', { class: 'view-sub' });
      function drawCounts() {
        counts.textContent = `Cantrips ${build.cantrips.length} / ${cantripCount} · Prepared ${build.prepared.length} / ${preparedCount} · up to level ${maxLevel}`;
      }
      search.addEventListener('input', drawList);
      wrap.appendChild(counts);
      wrap.appendChild(search);
      wrap.appendChild(listEl);
      drawCounts();
      drawList();
      return wrap;
    }

    // 7 ────────────────────────────────────────────────────────────────
    function review() {
      const s = snapshotFrom(build);
      const problems = [];
      if (!build.name) problems.push('No name.');
      if (!build.species) problems.push('No species.');
      if (!build.background) problems.push('No background.');
      if (!build.className) problems.push('No class.');
      if (build.background && build.bgBonus.mode === '2+1' && (!build.bgBonus.plus2 || !build.bgBonus.plus1)) problems.push('Background ability bonus not assigned.');
      const wrap = el('div', {});
      if (problems.length) wrap.appendChild(el('div', { class: 'session-error' }, [problems.join(' ')]));
      wrap.appendChild(el('div', { class: 'view-sub' }, [`${s.features.length} features · ${s.actions.length} attacks · ${s.spells.length} spells · ${s.equipment.length} items`]));
      const m = { id: 'preview', snapshot: s, gm: Object.assign({ hpCurrent: s.hpMax, tempHp: 0, conditions: [], notes: '', playerNotes: '', slotsUsed: {}, pactUsed: 0, resourcesUsed: {}, deathSaves: { success: 0, fail: 0 }, inspiration: false, inventory: {}, companionHp: {} }) };
      // a read-only look: the real sheet, but its edits would target a
      // member that doesn't exist yet, so render it inert
      const sheet = window.AxisSheet.characterSheet(m, { inspector: true, player: true });
      sheet.querySelectorAll('input, select, button, textarea').forEach((n) => (n.disabled = true));
      wrap.appendChild(sheet);
      return wrap;
    }

    draw();
    return overlay;
  }

  return { open, newBuild, snapshotFrom };
})();
