// ddb-pdf.js — D&D Beyond's exported character-sheet PDF → the same
// snapshot shape ddb-import.js builds from the API, so the sheet, play
// mode and sessions don't care which way a character arrived.
//
// The export looks like flat text, but every value is a widget
// annotation with a field name (CharacterName, STR, STRmod, ST Wisdom,
// ArcanaProf, MaxHP, Wpn1 AtkBonus, FeaturesTraits1…, Eq Name0…,
// spellName0…). pdf.js hands those back with getAnnotations(), so this
// parses a field map, not positioned text. Multi-line fields keep the
// template's line breaks and indentation: entries flush, their first
// description line indented, blank lines between entries.
//
// Pure: parse(fields) takes [{ page, name, value, type }] in document
// order. The browser gets them through fromFile(); Node through the same
// pdf.js call (see the harness in the decision log).
//
// What the PDF cannot give that the API does: spell text (the app links
// names to the corpus), companions, item descriptions, subclass names.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.AxisDdbPdf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ABILITIES = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
  const ABBR = { Strength: 'str', Dexterity: 'dex', Constitution: 'con', Intelligence: 'int', Wisdom: 'wis', Charisma: 'cha' };
  const ABIL_BY_ABBR = { STR: 'Strength', DEX: 'Dexterity', CON: 'Constitution', INT: 'Intelligence', WIS: 'Wisdom', CHA: 'Charisma' };
  // sheet field stem, display name, ability
  const SKILLS = [
    ['acrobatics', 'Acrobatics', 'Dexterity'], ['animal', 'Animal Handling', 'Wisdom', 'animalhandling'], ['arcana', 'Arcana', 'Intelligence'],
    ['athletics', 'Athletics', 'Strength'], ['deception', 'Deception', 'Charisma'], ['history', 'History', 'Intelligence'],
    ['insight', 'Insight', 'Wisdom'], ['intimidation', 'Intimidation', 'Charisma'], ['investigation', 'Investigation', 'Intelligence'],
    ['medicine', 'Medicine', 'Wisdom'], ['nature', 'Nature', 'Intelligence'], ['perception', 'Perception', 'Wisdom'],
    ['performance', 'Performance', 'Charisma'], ['persuasion', 'Persuasion', 'Charisma'], ['religion', 'Religion', 'Intelligence'],
    ['sleightofhand', 'Sleight of Hand', 'Dexterity'], ['stealth', 'Stealth', 'Dexterity'], ['survival', 'Survival', 'Wisdom'],
  ];
  const LEVEL_WORDS = { CANTRIPS: 0, '1ST': 1, '2ND': 2, '3RD': 3, '4TH': 4, '5TH': 5, '6TH': 6, '7TH': 7, '8TH': 8, '9TH': 9 };

  // Field names are inconsistent about spaces and case ("DEXmod ",
  // "CHamod", "Wpn2 AtkBonus  ", "Stealth "): key on lowercase letters
  // and digits only.
  function keyOf(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function num(v) {
    if (v == null) return null;
    const m = /^\s*([+-]?\d+)\s*$/.exec(String(v));
    return m ? parseInt(m[1], 10) : null;
  }

  function slugKey(prefix, name) {
    return prefix + ':' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function lines(text) {
    return String(text || '').split(/\r\n|\r|\n/);
  }

  // ── "=== SECTION ===" blocks: proficiencies, actions ───────────────
  function sections(text) {
    const out = [];
    let cur = null;
    lines(text).forEach((raw) => {
      const h = /^\s*===\s*(.+?)\s*===\s*$/.exec(raw);
      if (h) {
        cur = { title: h[1], lines: [] };
        out.push(cur);
      } else if (cur) cur.lines.push(raw);
    });
    return out;
  }

  // Entries in the actions box: a flush line is an entry name; the
  // indented line(s) after it are its description. "Standard Actions" is
  // the rules list, not a thing to trigger.
  function parseActions(text) {
    const actions = [];
    const resources = [];
    sections(text).forEach((sec) => {
      const t = sec.title.toUpperCase();
      const activation = t.indexOf('BONUS') !== -1 ? 'bonus' : t.indexOf('REACTION') !== -1 ? 'reaction' : t.indexOf('OTHER') !== -1 || t.indexOf('SPECIAL') !== -1 ? 'special' : 'action';
      let cur = null;
      sec.lines.forEach((raw) => {
        if (!raw.trim()) return;
        const indented = /^\s/.test(raw);
        // later paragraphs of a description come back flush too; an entry
        // name is short and never reads like a sentence
        const looksLikeEntry = !indented && !/[.,;]/.test(raw.trim()) && raw.trim().length <= 60;
        if (looksLikeEntry) {
          const s = raw.trim();
          if (/^Standard Actions$/i.test(s)) {
            cur = { skip: true };
            return;
          }
          const m = /^(.+?)(?:\s+•\s*(\d+)\s*\/\s*(Short|Long)\s*Rest)?\s*$/i.exec(s);
          cur = { name: m[1].trim(), activation, description: '' };
          if (m[2]) {
            const key = slugKey('pdf', cur.name);
            resources.push({ key, name: cur.name, max: parseInt(m[2], 10), used: 0, reset: m[3].toLowerCase() });
            cur.resourceKey = key;
          }
          actions.push(cur);
        } else if (cur && !cur.skip) cur.description += (cur.description ? '\n' : '') + raw.trim();
      });
    });
    return { actions: actions.filter((a) => !a.skip), resources };
  }

  // Features & Traits: "=== CATEGORY ===", "* Name • Source", "| Sub •
  // Source" (indented), description lines in between. Column fields are
  // concatenated in order first, so a feature split across columns
  // reads whole.
  function parseFeatures(text) {
    const out = [];
    let category = 'Feature';
    let cur = null;
    let parent = null;
    lines(text).forEach((raw) => {
      const s = raw.trim();
      if (!s) return;
      const h = /^===\s*(.+?)\s*===$/.exec(s);
      if (h) {
        category = titleCase(h[1]);
        cur = null;
        parent = null;
        return;
      }
      const f = /^\*\s+(.+?)(?:\s+•\s*(.*))?$/.exec(s);
      if (f) {
        cur = { name: f[1].trim(), category, source: (f[2] || '').trim(), description: '' };
        parent = cur.name;
        out.push(cur);
        return;
      }
      const sub = /^\|\s+(.+?)(?:\s+•\s*(.*))?$/.exec(s);
      if (sub) {
        cur = { name: sub[1].trim(), category: parent || category, source: (sub[2] || '').trim(), description: '' };
        out.push(cur);
        return;
      }
      if (cur) cur.description += (cur.description ? '\n' : '') + s;
    });
    return out;
  }

  function titleCase(s) {
    return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function parseDamage(s) {
    const m = /^\s*(\d+(?:d\d+)?(?:\s*[+-]\s*\d+)?)\s*(.*?)\s*$/.exec(s || '');
    return m && m[1] ? { dice: m[1].replace(/\s+/g, ''), type: (m[2] || '').toLowerCase() || null } : null;
  }

  // ── the parser ─────────────────────────────────────────────────────
  function parse(fields, meta) {
    meta = meta || {};
    const byKey = {};
    fields.forEach((f) => {
      const k = keyOf(f.name);
      // first occurrence wins (later pages repeat the header fields)
      if (!(k in byKey) || (byKey[k] === '' && f.value)) byKey[k] = f.value == null ? '' : String(f.value);
    });
    const get = (name) => (byKey[keyOf(name)] || '').trim();
    if (!('charactername' in byKey) || !('maxhp' in byKey)) throw new Error('This does not look like a D&D Beyond character sheet PDF (no CharacterName / MaxHP fields).');

    // header
    const name = get('CharacterName') || 'Unnamed';
    const classes = get('CLASS LEVEL')
      .split('/')
      .map((s) => /^(.*?)\s+(\d+)\s*$/.exec(s.trim()))
      .filter(Boolean)
      .map((m) => ({ name: m[1], level: parseInt(m[2], 10), subclass: null, spellcastingAbility: null }));
    const totalLevel = classes.reduce((a, c) => a + c.level, 0) || 1;

    // abilities
    const abilities = {};
    const abilityMods = {};
    ABILITIES.forEach((a) => {
      const score = num(get(ABBR[a]));
      const m = num(get(ABBR[a] + 'mod'));
      if (score != null) {
        abilities[a] = score;
        abilityMods[a] = m != null ? m : Math.floor((score - 10) / 2);
      }
    });
    const savingThrows = {};
    ABILITIES.forEach((a) => {
      savingThrows[a] = { proficient: !!get(ABBR[a] + 'prof'), modifier: num(get('ST ' + a)) != null ? num(get('ST ' + a)) : abilityMods[a] || 0 };
    });
    const skills = {};
    SKILLS.forEach(([stem, label, ability, profStem]) => {
      const mark = get((profStem || stem) + 'prof') || get(stem + 'prof');
      skills[label] = { ability, proficient: !!mark, expertise: /E/i.test(mark), modifier: num(get(stem)) != null ? num(get(stem)) : 0 };
    });
    for (let i = 1; i <= 3; i++) {
      const label = get('CustomSkill' + i);
      if (label) skills[label] = { ability: null, proficient: !!get('CustomProf' + i), expertise: false, modifier: num(get('Custom Skill Bonus ' + i)) || 0 };
    }

    const pb = num(get('ProfBonus'));
    const proficiencyBonus = pb != null ? pb : Math.floor((totalLevel - 1) / 4) + 2;
    const hpMax = num(get('MaxHP'));
    const hpCurrent = num(get('CurrentHP'));
    const tempHp = num(get('TempHP')) || 0;
    const successes = [12, 13, 14].filter((n) => get('Check Box ' + n) && get('Check Box ' + n) !== 'Off').length;
    const failures = [15, 16, 17].filter((n) => get('Check Box ' + n) && get('Check Box ' + n) !== 'Off').length;
    const inspiration = !!get('Inspiration') && get('Inspiration') !== 'Off';

    const speed = {};
    get('Speed').split(',').forEach((part) => {
      const sp = /(\d+)\s*ft\.?\s*\((\w+)\)/i.exec(part);
      if (sp) speed[sp[2].toLowerCase().replace('walking', 'walk').replace('flying', 'fly').replace('swimming', 'swim').replace('climbing', 'climb').replace('burrowing', 'burrow')] = parseInt(sp[1], 10);
    });
    const senses = {};
    lines(get('AdditionalSenses')).forEach((s) => {
      const sm = /^\s*(\w+)\s+(\d+)\s*ft/i.exec(s);
      if (sm) senses[sm[1][0].toUpperCase() + sm[1].slice(1)] = parseInt(sm[2], 10);
    });
    const training = {};
    sections(get('ProficienciesLang')).forEach((sec) => {
      training[sec.title.toLowerCase()] = sec.lines.join(' ').split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    });
    const defenses = lines(get('Defenses')).map((s) => s.trim()).filter(Boolean);

    // actions: the printed entries plus the weapon/cantrip attack table
    const ab = parseActions([get('Actions1'), get('Actions2')].filter(Boolean).join('\n'));
    const actions = ab.actions.map((a) => ({
      key: slugKey('pdf', a.name),
      name: a.name,
      source: 'sheet',
      activation: a.activation,
      description: a.description,
      attackBonus: null,
      damage: null,
      save: null,
      resourceKey: a.resourceKey || null,
      range: null,
    }));
    const attacks = [];
    for (let i = 1; i <= 6; i++) {
      const wname = get(i === 1 ? 'Wpn Name' : 'Wpn Name ' + i);
      if (!wname) continue;
      attacks.push({ name: wname, hit: num(get('Wpn' + i + ' AtkBonus')), damage: get('Wpn' + i + ' Damage'), notes: get('Wpn Notes ' + i) });
    }
    attacks.forEach((r, i) => {
      actions.push({
        key: 'atk:' + i,
        name: r.name,
        source: 'weapon',
        activation: 'action',
        description: r.notes,
        attackBonus: r.hit,
        damage: parseDamage(r.damage),
        save: null,
        resourceKey: null,
        range: null,
      });
    });

    // features, in column order across pages
    const featureText = fields
      .filter((f) => /^featurestraits\d+$/.test(keyOf(f.name)))
      .sort((a, b) => parseInt(keyOf(a.name).slice(14), 10) - parseInt(keyOf(b.name).slice(14), 10))
      .map((f) => String(f.value || ''))
      .join('\n');
    const features = parseFeatures(featureText);

    // resources: from actions, and from feature lines like
    // "Lay On Hands: Healing Pool: 45 / Long Rest"
    const resources = ab.resources.slice();
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    features.forEach((f) => {
      const u = /^(.*?):?\s*(\d+)\s*\/\s*(Short|Long)\s*Rest\b/i.exec(f.name);
      if (!u) return;
      const rname = u[1].replace(/:\s*$/, '').trim() || f.category;
      const max = parseInt(u[2], 10);
      const dup = resources.some((r) => r.max === max && (norm(r.name).indexOf(norm(rname)) !== -1 || norm(rname).indexOf(norm(r.name)) !== -1));
      if (!dup) resources.push({ key: slugKey('pdf', rname), name: rname, max, used: 0, reset: u[3].toLowerCase() });
    });

    // equipment
    const equipment = [];
    for (let i = 0; i < 200; i++) {
      const k = 'eqname' + i;
      if (!(k in byKey)) {
        if (i > 60) break;
        continue;
      }
      const ename = get('Eq Name' + i);
      if (!ename) continue;
      equipment.push({ key: 'item:pdf:' + i, name: ename, quantity: num(get('Eq Qty' + i)) || 1, weight: get('Eq Weight' + i), equipped: false, attuned: false, type: null, description: '', charges: null });
    }
    for (let i = 1; i <= 6; i++) {
      const an = get('Attuned Name' + i);
      if (!an) continue;
      const it = equipment.find((e) => e.name === an && !e.attuned);
      if (it) {
        it.attuned = true;
        it.equipped = true;
      } else equipment.push({ key: 'item:pdf:att' + i, name: an, quantity: num(get('Attuned Qty' + i)) || 1, weight: '', equipped: true, attuned: true, type: null, description: '', charges: null });
    }
    equipment.forEach((e) => {
      if (e.weight && e.weight !== '--') e.description = 'Weight ' + e.weight;
      delete e.weight;
    });
    const currencies = {};
    ['cp', 'sp', 'ep', 'gp', 'pp'].forEach((c) => {
      const v = num(get(c));
      if (v != null) currencies[c] = v;
    });

    // spells: rows take the level of the most recent header before them
    const spells = [];
    const slots = [];
    const pact = [];
    const casting = { ability: ABIL_BY_ABBR[get('spellCastingAbility0')] || null, dc: num(get('spellSaveDC0')), attack: num(get('spellAtkBonus0')), casterClass: get('spellCastingClass0') || null };
    let level = 0;
    const rowLevel = {};
    fields.forEach((f) => {
      const k = keyOf(f.name);
      const hm = /^spellheader(\d+)$/.exec(k);
      if (hm) {
        const lv = /===\s*(\w+)\s*(?:LEVEL)?\s*===/i.exec(String(f.value || ''));
        if (lv && LEVEL_WORDS[lv[1].toUpperCase()] != null) level = LEVEL_WORDS[lv[1].toUpperCase()];
        const slot = String(byKey['spellslotheader' + hm[1]] || '');
        const sm = /(\d+)\s*(Pact)?\s*([O●•◯○]+)?/.exec(slot);
        if (sm && level > 0) {
          const entry = { level, max: parseInt(sm[1], 10), used: ((sm[3] || '').match(/[●•]/g) || []).length };
          const list = sm[2] ? pact : slots;
          if (!list.some((x) => x.level === level)) list.push(entry);
        }
        return;
      }
      const rm = /^spellname(\d+)$/.exec(k);
      if (rm && String(f.value || '').trim()) rowLevel[rm[1]] = level;
    });
    const attackByName = {};
    attacks.forEach((r) => (attackByName[r.name.toLowerCase()] = r));
    const seen = new Set();
    Object.keys(rowLevel).forEach((i) => {
      const rawName = get('spellName' + i);
      const nameClean = rawName.replace(/\s*\[R\]\s*/g, '').trim();
      const lvl = rowLevel[i];
      const dedupe = nameClean.toLowerCase() + '@' + lvl;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      const atkField = get('spellSaveHit' + i);
      const time = get('spellCastingTime' + i);
      const notes = get('spellNotes' + i);
      const source = get('spellSource' + i);
      const saveM = /^([A-Z]{3})\s+(\d+)$/.exec(atkField);
      const lu = /(\d+)\s*\/\s*(LR|SR)(\s*\(Used\))?/i.exec(notes);
      let resourceKey = null;
      if (lu) {
        resourceKey = 'spl:pdf:' + i;
        resources.push({ key: resourceKey, name: nameClean + (source ? ` (${source})` : ''), max: parseInt(lu[1], 10), used: lu[3] ? parseInt(lu[1], 10) : 0, reset: lu[2].toUpperCase() === 'SR' ? 'short' : 'long' });
      }
      const atk = attackByName[nameClean.toLowerCase()];
      spells.push({
        key: 'spl:pdf:' + i,
        name: nameClean,
        level: lvl,
        school: null,
        prepared: /P/.test(get('spellPrepared' + i)) || /Always Prepared/i.test(source),
        description: '',
        activation: /BA$/i.test(time) ? 'bonus' : /R$/.test(time) ? 'reaction' : 'action',
        concentration: /Concentration/i.test(get('spellDuration' + i)),
        ritual: /\[R\]/.test(rawName),
        castingAbility: casting.ability,
        attack: /^[+-]\d+$/.test(atkField),
        attackBonus: /^[+-]\d+$/.test(atkField) ? parseInt(atkField, 10) : null,
        save: saveM ? { ability: ABIL_BY_ABBR[saveM[1]] || saveM[1], dc: parseInt(saveM[2], 10) } : null,
        damage: atk ? parseDamage(atk.damage) : null,
        healing: null,
        usesSlot: lvl > 0 && !lu,
        resourceKey,
        source,
        range: get('spellRange' + i),
        components: get('spellComponents' + i),
        duration: get('spellDuration' + i),
        notes,
      });
    });
    spells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

    const bio = {};
    ['GENDER', 'AGE', 'SIZE', 'HEIGHT', 'WEIGHT', 'ALIGNMENT', 'FAITH', 'SKIN', 'EYES', 'HAIR', 'PersonalityTraits', 'Ideals', 'Bonds', 'Flaws', 'Appearance', 'Backstory', 'AlliesOrganizations', 'AdditionalNotes1', 'AdditionalNotes2'].forEach((k) => {
      const v = get(k);
      if (v) bio[/^[A-Z]+$/.test(k) ? k.toLowerCase() : k.replace(/^./, (c) => c.toLowerCase())] = v;
    });

    return {
      ddbId: meta.ddbId || null,
      importedFrom: 'pdf',
      name,
      playerName: get('PLAYER NAME') || null,
      race: get('RACE') || null,
      background: get('BACKGROUND') || null,
      classes,
      totalLevel,
      proficiencyBonus,
      abilities,
      abilityMods,
      ac: { value: num(get('AC')), note: 'from D&D Beyond sheet' },
      hpMax,
      removedHp: hpMax != null && hpCurrent != null ? Math.max(0, hpMax - hpCurrent) : 0,
      tempHp,
      hitDice: get('Total') || null,
      initiativeBonus: num(get('Init')),
      deathSaves: { success: successes, fail: failures },
      inspiration,
      currencies,
      speed,
      senses,
      languages: training.languages || [],
      defenses,
      saveNotes: lines(get('SaveModifiers')).map((s) => s.trim()).filter(Boolean).join(' '),
      passives: { perception: num(get('Passive1')), insight: num(get('Passive2')), investigation: num(get('Passive3')) },
      training,
      savingThrows,
      skills,
      features: features.map((f) => ({ name: f.name, category: f.category, description: f.description + (f.source ? `\n(${f.source})` : '') })),
      actions,
      resources,
      spellSlots: slots.sort((a, b) => a.level - b.level),
      pactMagic: pact,
      spellcasting: casting,
      spells,
      equipment,
      companions: [],
      bio,
      importedAt: new Date().toISOString(),
    };
  }

  // ── browser: from a File via pdf.js (loaded on demand from cdnjs) ──
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

  async function fieldsFromDocument(doc) {
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const ann = await page.getAnnotations();
      ann.forEach((a) => {
        if (a.subtype !== 'Widget') return;
        out.push({ page: i, name: a.fieldName, value: a.fieldValue != null ? a.fieldValue : a.contents || '', type: a.fieldType });
      });
    }
    return out;
  }

  async function fieldsFromArrayBuffer(buf) {
    const pdfjs = await import(/* webpackIgnore: true */ PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    return fieldsFromDocument(doc);
  }

  async function fromFile(file) {
    const buf = await file.arrayBuffer();
    const fields = await fieldsFromArrayBuffer(buf);
    const idm = /_(\d{6,})\.pdf$/i.exec(file.name || '');
    return parse(fields, { ddbId: idm ? idm[1] : null });
  }

  return { parse, fromFile, fieldsFromArrayBuffer, fieldsFromDocument, _internal: { parseActions, parseFeatures, sections, keyOf } };
});
