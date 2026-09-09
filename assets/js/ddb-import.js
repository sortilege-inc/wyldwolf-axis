// ddb-import.js — D&D Beyond character import: link parsing, proxy fetch,
// and mapping D&D Beyond's raw character-service JSON into a flat snapshot
// the sheet (sheet.js), the Party panel and play mode can use.
//
// D&D Beyond has no supported public API. The community-documented (and,
// as of this build, live-verified-working) endpoint is:
//
//   GET https://character-service.dndbeyond.com/character/v5/character/<id>?includeCustomItems=true
//
// verified 2026-09-08 against a real public character (id 48690485) —
// HTTP 200 with the full character JSON when called WITH
// `Origin`/`Referer: https://www.dndbeyond.com` headers (403 without, 404
// for a bad id). Undocumented and unsupported; it can change at any time.
// worker/ is the proxy that calls it server-side (the browser can't set
// Origin/Referer, and the response has no CORS headers).
//
// What the snapshot keeps, and why: everything a player is allowed to
// *use* at the table — actions with their activation type and attack /
// damage / save numbers, spells with slots, limited-use counters (class
// resources, item charges), companions with full stat blocks — plus the
// descriptive sheet. Numbers are best-effort: D&D Beyond's own calculator
// handles situational modifiers and homebrew this does not.
window.AxisDdbImport = (function () {
  // The Worker (config.js): localhost:8787 under `wrangler dev`, the
  // deployed URL otherwise.
  const DDB_PROXY_URL = window.AxisConfig && window.AxisConfig.configured ? window.AxisConfig.WORKER_URL : 'REPLACE_ME';

  function parseCharacterId(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (/^\d+$/.test(s)) return s;
    const m = s.match(/dndbeyond\.com\/characters\/(\d+)/i);
    return m ? m[1] : null;
  }

  async function fetchCharacterJson(characterId) {
    if (!DDB_PROXY_URL || DDB_PROXY_URL === 'REPLACE_ME') {
      throw new Error('Worker URL not configured. Deploy worker/ (see worker/README.md) and set DEPLOYED in assets/js/config.js.');
    }
    const url = `${DDB_PROXY_URL.replace(/\/$/, '')}/?id=${encodeURIComponent(characterId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Proxy returned HTTP ${res.status} for character ${characterId}`);
    const body = await res.json();
    if (!body || body.success === false || !body.data) {
      throw new Error(body && body.message ? body.message : 'D&D Beyond returned no character data (private, deleted, or bad id?)');
    }
    return body.data;
  }

  // ── D&D Beyond enumerations (community-documented) ───────────────────
  const ABILITY_NAMES = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
  const ABILITY_SLUGS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
  const STAT_BY_ID = { 1: 'Strength', 2: 'Dexterity', 3: 'Constitution', 4: 'Intelligence', 5: 'Wisdom', 6: 'Charisma' };
  const ACTIVATION = { 1: 'action', 2: 'none', 3: 'bonus', 4: 'reaction', 6: 'minute', 7: 'hour', 8: 'special' };
  const RESET = { 1: 'short', 2: 'long', 3: 'dawn', 4: 'other' };
  const DAMAGE_TYPE = { 1: 'bludgeoning', 2: 'piercing', 3: 'slashing', 4: 'necrotic', 5: 'acid', 6: 'cold', 7: 'fire', 8: 'lightning', 9: 'thunder', 10: 'poison', 11: 'psychic', 12: 'radiant', 13: 'force' };
  const SIZE_BY_ID = { 2: 'Tiny', 3: 'Small', 4: 'Medium', 5: 'Large', 6: 'Huge', 7: 'Gargantuan' };
  const TYPE_BY_ID = { 1: 'Aberration', 2: 'Beast', 3: 'Celestial', 4: 'Construct', 5: 'Dragon', 6: 'Elemental', 7: 'Fey', 8: 'Fiend', 9: 'Giant', 10: 'Humanoid', 11: 'Monstrosity', 12: 'Ooze', 13: 'Plant', 14: 'Undead' };
  const MOVEMENT_BY_ID = { 1: 'walk', 2: 'burrow', 3: 'climb', 4: 'fly', 5: 'swim' };
  const SENSE_BY_ID = { 1: 'Blindsight', 2: 'Darkvision', 3: 'Tremorsense', 4: 'Truesight' };
  const SKILL_BY_ID = { 2: 'Athletics', 3: 'Acrobatics', 4: 'Sleight of Hand', 5: 'Stealth', 6: 'Arcana', 7: 'History', 8: 'Investigation', 9: 'Nature', 10: 'Religion', 11: 'Animal Handling', 12: 'Insight', 13: 'Medicine', 14: 'Perception', 15: 'Survival', 16: 'Deception', 17: 'Intimidation', 18: 'Performance', 19: 'Persuasion' };
  // creatures[].groupId: 1 and 2 are what the fixture shows for Wild Shape
  // forms and Find Familiar forms; anything else is treated as a companion.
  const CREATURE_GROUP = { 1: 'Wild Shape', 2: 'Familiar' };

  const SKILLS = [
    ['Acrobatics', 'Dexterity'], ['Animal Handling', 'Wisdom'], ['Arcana', 'Intelligence'],
    ['Athletics', 'Strength'], ['Deception', 'Charisma'], ['History', 'Intelligence'],
    ['Insight', 'Wisdom'], ['Intimidation', 'Charisma'], ['Investigation', 'Intelligence'],
    ['Medicine', 'Wisdom'], ['Nature', 'Intelligence'], ['Perception', 'Wisdom'],
    ['Performance', 'Charisma'], ['Persuasion', 'Charisma'], ['Religion', 'Intelligence'],
    ['Sleight of Hand', 'Dexterity'], ['Stealth', 'Dexterity'], ['Survival', 'Wisdom'],
  ];

  function slug(name) {
    return String(name).toLowerCase().replace(/\s+/g, '-');
  }

  function abilityMod(score) {
    return Math.floor((score - 10) / 2);
  }

  function proficiencyBonus(totalLevel) {
    return Math.floor((totalLevel - 1) / 4) + 2;
  }

  function fmt(n) {
    return n >= 0 ? `+${n}` : `${n}`;
  }

  function allModifiers(char) {
    const groups = char.modifiers || {};
    return Object.keys(groups).reduce((acc, k) => acc.concat(groups[k] || []), []);
  }

  function proficiencyLevel(mods, subType) {
    let level = 0;
    mods.forEach((m) => {
      if (m.subType !== subType) return;
      if (m.type === 'expertise') level = Math.max(level, 2);
      else if (m.type === 'proficiency') level = Math.max(level, 1);
    });
    return level;
  }

  function stripHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<\/(p|li|div|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
      .replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── Character basics ─────────────────────────────────────────────────
  function computeAbilities(char) {
    const stats = char.stats || [];
    const bonus = char.bonusStats || [];
    const override = char.overrideStats || [];
    const out = {};
    ABILITY_NAMES.forEach((name, i) => {
      const id = i + 1;
      const ov = (override.find((s) => s.id === id) || {}).value;
      if (ov != null) {
        out[name] = ov;
        return;
      }
      const base = (stats.find((s) => s.id === id) || {}).value || 10;
      const b = (bonus.find((s) => s.id === id) || {}).value || 0;
      out[name] = base + b;
    });
    return out;
  }

  function computeSpeed(char) {
    const ws = ((char.race || {}).weightSpeeds || {}).normal || {};
    const out = {};
    ['walk', 'fly', 'swim', 'climb', 'burrow'].forEach((k) => {
      if (ws[k]) out[k] = ws[k];
    });
    return out;
  }

  function computeSenses(mods) {
    const senseTypes = ['darkvision', 'blindsight', 'tremorsense', 'truesight'];
    const out = {};
    mods.forEach((m) => {
      if (m.type === 'set-base' && senseTypes.indexOf(m.subType) !== -1) {
        const label = m.subType[0].toUpperCase() + m.subType.slice(1);
        out[label] = Math.max(out[label] || 0, m.value || m.fixedValue || 0);
      }
    });
    return out;
  }

  function computeLanguages(mods) {
    const out = [];
    mods.forEach((m) => {
      if (m.type === 'language' && m.friendlySubtypeName) out.push(m.friendlySubtypeName);
    });
    return Array.from(new Set(out));
  }

  function computeAC(char, abilities) {
    const dexMod = abilityMod(abilities.Dexterity);
    const inv = char.inventory || [];
    const equippedArmor = inv.find((i) => i.equipped && i.definition && i.definition.armorClass != null && (i.definition.type || '').toLowerCase().indexOf('shield') === -1);
    const equippedShield = inv.find((i) => i.equipped && i.definition && (i.definition.type || '').toLowerCase().indexOf('shield') !== -1);
    let base = 10 + dexMod;
    let note = 'unarmored (best-effort)';
    if (equippedArmor) {
      base = equippedArmor.definition.armorClass + ((equippedArmor.definition.type || '').toLowerCase() === 'light armor' ? dexMod : 0);
      note = equippedArmor.definition.name;
    }
    if (equippedShield) {
      base += equippedShield.definition.armorClass || 2;
      note += ' + shield';
    }
    let bonus = 0;
    allModifiers(char).forEach((m) => {
      if (m.type === 'bonus' && m.subType === 'armor-class') bonus += m.value || m.fixedValue || 0;
    });
    return { value: base + bonus, note };
  }

  function computeHp(char, abilities, totalLevel) {
    const conMod = abilityMod(abilities.Constitution);
    const base = char.baseHitPoints || 0;
    const bonus = char.bonusHitPoints || 0;
    const override = char.overrideHitPoints;
    return { max: override != null ? override : base + conMod * totalLevel + bonus };
  }

  function computeClasses(char) {
    return (char.classes || []).map((c) => ({
      name: c.definition ? c.definition.name : 'Class',
      level: c.level,
      subclass: c.subclassDefinition ? c.subclassDefinition.name : null,
      spellcastingAbility: c.definition && c.definition.spellCastingAbilityId ? STAT_BY_ID[c.definition.spellCastingAbilityId] : null,
    }));
  }

  function computeSavingThrows(mods, abilities, pb) {
    const out = {};
    ABILITY_SLUGS.forEach((s, i) => {
      const name = ABILITY_NAMES[i];
      const level = proficiencyLevel(mods, `${s}-saving-throws`);
      out[name] = { proficient: level > 0, modifier: abilityMod(abilities[name]) + (level ? pb : 0) };
    });
    return out;
  }

  function computeSkills(mods, abilities, pb) {
    const out = {};
    SKILLS.forEach(([name, ability]) => {
      const level = proficiencyLevel(mods, slug(name));
      const mod = abilityMod(abilities[ability]) + (level === 2 ? pb * 2 : level === 1 ? pb : 0);
      out[name] = { ability, proficient: level > 0, expertise: level === 2, modifier: mod };
    });
    return out;
  }

  function computeFeatures(char) {
    const out = [];
    (char.classes || []).forEach((c) => {
      (c.classFeatures || []).forEach((f) => {
        const def = f.definition || {};
        if (def.name) out.push({ name: def.name, category: c.definition ? c.definition.name : 'Class', description: stripHtml(def.description) });
      });
    });
    ((char.race || {}).racialTraits || []).forEach((t) => {
      const def = t.definition || {};
      if (def.name) out.push({ name: def.name, category: 'Race', description: stripHtml(def.description) });
    });
    (char.feats || []).forEach((f) => {
      const def = f.definition || {};
      if (def.name) out.push({ name: def.name, category: 'Feat', description: stripHtml(def.description) });
    });
    return out;
  }

  // ── Limited uses → resources ─────────────────────────────────────────
  function limitedUseOf(lu, pb) {
    if (!lu) return null;
    const max = lu.useProficiencyBonus ? pb : lu.maxUses;
    if (!max) return null;
    return { max, used: lu.numberUsed || 0, reset: RESET[lu.resetType] || 'other' };
  }

  // ── Actions: class/race/feat/item actions plus equipped weapons ──────
  function computeActions(char, abilities, pb) {
    const groups = char.actions || {};
    const out = [];
    Object.keys(groups).forEach((source) => {
      (groups[source] || []).forEach((a) => {
        const abilityName = STAT_BY_ID[a.abilityModifierStatId];
        const mod = abilityName ? abilityMod(abilities[abilityName]) : 0;
        const isAttack = !!(a.attackTypeRange || a.displayAsAttack || a.fixedToHit != null);
        const lu = limitedUseOf(a.limitedUse, pb);
        out.push({
          key: 'act:' + a.id,
          name: a.name,
          source,
          activation: ACTIVATION[(a.activation || {}).activationType] || 'special',
          description: stripHtml(a.description || a.snippet || ''),
          attackBonus: isAttack ? (a.fixedToHit != null ? a.fixedToHit : mod + (a.isProficient ? pb : 0)) : null,
          damage: a.dice && a.dice.diceString ? { dice: a.dice.diceString, type: DAMAGE_TYPE[a.damageTypeId] || null } : null,
          save: a.saveStatId ? { ability: STAT_BY_ID[a.saveStatId], dc: a.fixedSaveDc != null ? a.fixedSaveDc : 8 + pb + mod } : null,
          resourceKey: lu ? 'act:' + a.id : null,
          range: a.range && a.range.range ? a.range.range : null,
        });
      });
    });
    (char.inventory || [])
      .filter((i) => i.equipped && i.definition && (i.definition.filterType === 'Weapon' || i.definition.attackType))
      .forEach((i) => {
        const def = i.definition;
        const props = (def.properties || []).map((p) => p.name);
        const ranged = def.attackType === 2;
        const finesse = props.indexOf('Finesse') !== -1;
        const strMod = abilityMod(abilities.Strength);
        const dexMod = abilityMod(abilities.Dexterity);
        const mod = finesse ? Math.max(strMod, dexMod) : ranged ? dexMod : strMod;
        let magic = 0;
        (def.grantedModifiers || []).forEach((m) => {
          if (m.type === 'bonus' && m.subType === 'magic') magic += m.value || m.fixedValue || 0;
        });
        const dice = def.damage && def.damage.diceString ? def.damage.diceString : null;
        out.push({
          key: 'wpn:' + i.id,
          name: def.name,
          source: 'weapon',
          activation: 'action',
          description: [props.join(', '), def.range ? `range ${def.range}${def.longRange && def.longRange !== def.range ? '/' + def.longRange : ''} ft.` : ''].filter(Boolean).join(' · '),
          // proficiency is assumed — D&D Beyond doesn't put it on the item
          attackBonus: mod + pb + magic,
          damage: dice ? { dice: `${dice}${mod + magic ? fmt(mod + magic) : ''}`, type: (def.damageType || '').toLowerCase() || null } : null,
          save: null,
          resourceKey: null,
          range: def.range || null,
        });
      });
    return out;
  }

  function computeResources(char, pb) {
    const out = [];
    const groups = char.actions || {};
    Object.keys(groups).forEach((source) => {
      (groups[source] || []).forEach((a) => {
        const lu = limitedUseOf(a.limitedUse, pb);
        if (lu) out.push(Object.assign({ key: 'act:' + a.id, name: a.name, source }, lu));
      });
    });
    (char.inventory || []).forEach((i) => {
      const lu = limitedUseOf(i.limitedUse, pb);
      if (lu && i.definition) out.push(Object.assign({ key: 'item:' + i.id, name: i.definition.name, source: 'item' }, lu));
    });
    return out;
  }

  // D&D Beyond's spellSlots[].available is 0 for class-derived slots (the
  // site computes those client-side; only overrides come through), so
  // fall back to the standard table from caster level.
  const SLOT_TABLE = [
    [], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1],
    [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1],
    [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
    [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
  ];
  const FULL_CASTERS = ['Bard', 'Cleric', 'Druid', 'Sorcerer', 'Wizard'];
  const HALF_CASTERS = ['Paladin', 'Ranger', 'Artificer'];
  const THIRD_SUBCLASSES = ['Eldritch Knight', 'Arcane Trickster'];

  function casterLevel(classes) {
    let lvl = 0;
    classes.forEach((c) => {
      if (FULL_CASTERS.indexOf(c.name) !== -1) lvl += c.level;
      else if (HALF_CASTERS.indexOf(c.name) !== -1) lvl += c.name === 'Artificer' ? Math.ceil(c.level / 2) : Math.floor(c.level / 2);
      else if (c.subclass && THIRD_SUBCLASSES.indexOf(c.subclass) !== -1) lvl += Math.floor(c.level / 3);
    });
    return Math.min(20, lvl);
  }

  function computeSlots(list, classes) {
    const given = (list || []).filter((s) => s.available > 0);
    if (given.length) return given.map((s) => ({ level: s.level, max: s.available, used: s.used || 0 }));
    const row = SLOT_TABLE[casterLevel(classes || [])] || [];
    const used = {};
    (list || []).forEach((s) => (used[s.level] = s.used || 0));
    return row.map((max, i) => ({ level: i + 1, max, used: used[i + 1] || 0 }));
  }

  function computePact(list, classes) {
    const given = (list || []).filter((s) => s.available > 0);
    if (given.length) return given.map((s) => ({ level: s.level, max: s.available, used: s.used || 0 }));
    const w = (classes || []).find((c) => c.name === 'Warlock');
    if (!w) return [];
    const L = w.level;
    const count = L >= 17 ? 4 : L >= 11 ? 3 : L >= 2 ? 2 : 1;
    const level = Math.min(5, Math.ceil(L / 2));
    const used = (list || []).reduce((a, s) => a + (s.used || 0), 0);
    return [{ level, max: count, used }];
  }

  // ── Spells ───────────────────────────────────────────────────────────
  function computeSpells(char, abilities, pb, classes) {
    const classAbility = (classes.find((c) => c.spellcastingAbility) || {}).spellcastingAbility || null;
    const bySource = char.spells || {};
    const fromSources = Object.keys(bySource).reduce((acc, k) => acc.concat(bySource[k] || []), []);
    const fromClasses = (char.classSpells || []).reduce((acc, cs) => acc.concat(cs.spells || []), []);
    const seen = new Set();
    const out = [];
    fromSources.concat(fromClasses).forEach((s) => {
      const def = s.definition || {};
      if (!def.name || seen.has(def.name)) return;
      seen.add(def.name);
      const ability = STAT_BY_ID[s.spellCastingAbilityId] || classAbility;
      const mod = ability ? abilityMod(abilities[ability]) : 0;
      const dmg = (def.modifiers || []).find((m) => m.type === 'damage' && m.die && m.die.diceString);
      const heal = def.healingDice && def.healingDice.length ? def.healingDice[0] : null;
      const lu = limitedUseOf(s.limitedUse, pb);
      out.push({
        key: 'spl:' + (s.id || def.id),
        name: def.name,
        level: def.level,
        school: def.school,
        prepared: !!(s.prepared || s.alwaysPrepared),
        description: stripHtml(def.description),
        activation: ACTIVATION[(def.activation || {}).activationType] || 'action',
        concentration: !!def.concentration,
        ritual: !!def.ritual,
        castingAbility: ability,
        attack: !!def.requiresAttackRoll,
        attackBonus: def.requiresAttackRoll ? pb + mod : null,
        save: def.requiresSavingThrow && def.saveDcAbilityId ? { ability: STAT_BY_ID[def.saveDcAbilityId], dc: s.overrideSaveDc != null ? s.overrideSaveDc : 8 + pb + mod } : null,
        damage: dmg ? { dice: dmg.die.diceString, type: (dmg.friendlySubtypeName || '').toLowerCase() || null } : null,
        healing: heal && heal.diceString ? heal.diceString : null,
        usesSlot: def.level > 0 && s.usesSpellSlot !== false,
        resourceKey: lu ? 'spl:' + (s.id || def.id) : null,
      });
    });
    out.sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name));
    return out;
  }

  function computeEquipment(char, pb) {
    return (char.inventory || []).map((i) => {
      const lu = limitedUseOf(i.limitedUse, pb);
      return {
        key: 'item:' + i.id,
        name: i.definition ? i.definition.name : 'Item',
        quantity: i.quantity || 1,
        equipped: !!i.equipped,
        type: i.definition ? i.definition.filterType || i.definition.type || null : null,
        description: i.definition ? stripHtml(i.definition.description) : '',
        charges: lu ? { max: lu.max, used: lu.used } : null,
      };
    });
  }

  // ── Companions (creatures[]): familiars, wild shapes, beasts, summons ─
  // Stat-block HTML is split by paragraph into {name, category,
  // description} features so render.js's statBlock() and play mode's
  // parseRollableActions() work on them exactly as on a monster.
  function splitBlock(html, category) {
    const out = [];
    String(html || '')
      .split(/<\/p>/i)
      .map((p) => stripHtml(p))
      .filter(Boolean)
      .forEach((text) => {
        const m = /^([^.]{2,60})\.\s*(.*)$/s.exec(text);
        if (m && /^[A-Z]/.test(m[1])) out.push({ name: m[1].trim(), category, description: m[2].trim() });
        else if (out.length) out[out.length - 1].description += '\n' + text;
        else out.push({ name: category, category, description: text });
      });
    return out;
  }

  function computeCompanions(char) {
    return (char.creatures || []).map((c) => {
      const def = c.definition || {};
      const abilities = {};
      (def.stats || []).forEach((s) => {
        if (STAT_BY_ID[s.statId]) abilities[STAT_BY_ID[s.statId]] = s.value;
      });
      const speed = {};
      (def.movements || []).forEach((m) => {
        if (MOVEMENT_BY_ID[m.movementId]) speed[MOVEMENT_BY_ID[m.movementId]] = m.speed;
      });
      const senses = {};
      (def.senses || []).forEach((s) => {
        if (SENSE_BY_ID[s.senseId]) senses[SENSE_BY_ID[s.senseId]] = s.notes || '';
      });
      const saves = {};
      (def.savingThrows || []).forEach((s) => {
        if (STAT_BY_ID[s.statId]) saves[STAT_BY_ID[s.statId].slice(0, 3)] = s.bonusModifier != null ? s.bonusModifier : 0;
      });
      const skills = {};
      (def.skills || []).forEach((s) => {
        if (SKILL_BY_ID[s.skillId]) skills[SKILL_BY_ID[s.skillId]] = s.value;
      });
      const size = SIZE_BY_ID[def.sizeId] || 'Medium';
      const type = TYPE_BY_ID[def.typeId] || '';
      const features = []
        .concat(splitBlock(def.specialTraitsDescription, 'Trait'))
        .concat(splitBlock(def.actionsDescription, 'Action'))
        .concat(splitBlock(def.bonusActionsDescription, 'Bonus Action'))
        .concat(splitBlock(def.reactionsDescription, 'Reaction'));
      const statblock = {
        Name: c.name || def.name,
        'Printed Type Line': [size, type].filter(Boolean).join(' '),
        Size: size,
        Type: type,
        'Armor Class': def.armorClass,
        'Armor Class Note': def.armorClassDescription || null,
        'Hit Points': def.averageHitPoints,
        'Hit Dice': def.hitPointDice && def.hitPointDice.diceString ? def.hitPointDice.diceString : null,
        Speed: speed,
        Abilities: abilities,
      };
      if (Object.keys(saves).length) statblock['Saving Throws'] = saves;
      if (Object.keys(skills).length) statblock.Skills = skills;
      if (Object.keys(senses).length) statblock.Senses = senses;
      if (def.languageDescription) statblock.Languages = { Printed: def.languageDescription };
      return {
        key: 'cre:' + c.id,
        name: c.name || def.name,
        baseName: def.name,
        groupId: c.groupId,
        group: CREATURE_GROUP[c.groupId] || 'Companion',
        active: !!c.isActive,
        size,
        hpMax: def.averageHitPoints,
        removedHp: c.removedHitPoints || 0,
        ac: def.armorClass,
        abilities,
        speed,
        statblock,
        features,
      };
    });
  }

  // ── Top-level mapper: raw DDB character JSON -> flat snapshot ──────────
  function mapCharacter(raw) {
    const abilities = computeAbilities(raw);
    const classes = computeClasses(raw);
    const totalLevel = classes.reduce((sum, c) => sum + (c.level || 0), 0) || 1;
    const pb = proficiencyBonus(totalLevel);
    const mods = allModifiers(raw);
    const hp = computeHp(raw, abilities, totalLevel);
    const ac = computeAC(raw, abilities);
    const ds = raw.deathSaves || {};

    return {
      ddbId: String(raw.id),
      name: raw.name || 'Unnamed',
      race: raw.race ? raw.race.fullName || raw.race.baseName : null,
      background: raw.background && raw.background.definition ? raw.background.definition.name : null,
      classes,
      totalLevel,
      proficiencyBonus: pb,
      abilities,
      abilityMods: ABILITY_NAMES.reduce((acc, n) => ((acc[n] = abilityMod(abilities[n])), acc), {}),
      ac,
      hpMax: hp.max,
      removedHp: raw.removedHitPoints || 0,
      tempHp: raw.temporaryHitPoints || 0,
      deathSaves: { success: ds.successCount || 0, fail: ds.failCount || 0 },
      inspiration: !!raw.inspiration,
      currencies: raw.currencies || {},
      speed: computeSpeed(raw),
      senses: computeSenses(mods),
      languages: computeLanguages(mods),
      savingThrows: computeSavingThrows(mods, abilities, pb),
      skills: computeSkills(mods, abilities, pb),
      features: computeFeatures(raw),
      actions: computeActions(raw, abilities, pb),
      resources: computeResources(raw, pb),
      spellSlots: computeSlots(raw.spellSlots, classes),
      pactMagic: computePact(raw.pactMagic, classes),
      spells: computeSpells(raw, abilities, pb, classes),
      equipment: computeEquipment(raw, pb),
      companions: computeCompanions(raw),
      importedAt: new Date().toISOString(),
    };
  }

  async function importByLink(link) {
    const id = parseCharacterId(link);
    if (!id) throw new Error('Could not find a D&D Beyond character id in that link.');
    const raw = await fetchCharacterJson(id);
    return mapCharacter(raw);
  }

  return { parseCharacterId, fetchCharacterJson, mapCharacter, importByLink, _internal: { computeAC, computeHp, proficiencyBonus, abilityMod, splitBlock } };
})();
