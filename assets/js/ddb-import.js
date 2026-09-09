// ddb-import.js — D&D Beyond character import: link parsing, proxy fetch,
// and mapping D&D Beyond's raw character-service JSON into a flat snapshot
// shape the party UI (and AxisRender.statBlock-style helpers) can render.
//
// D&D Beyond has no supported public API. The community-documented (and,
// as of this build, live-verified-working) endpoint is:
//
//   GET https://character-service.dndbeyond.com/character/v5/character/<id>?includeCustomItems=true
//
// verified 2026-09-08 against a real public character (id 48690485, found
// referenced in a community write-up) — returned HTTP 200 with a full
// character JSON when called WITH `Origin`/`Referer: https://www.dndbeyond.com`
// headers (calling without them, or with a bogus id, gets HTTP 403/404).
// It is undocumented/unsupported and can change or break at any time — see
// worker/README.md for the live proxy that actually calls it server-side
// (the browser can't set Origin/Referer itself, and the response has no
// CORS headers, hence the Worker).
window.AxisDdbImport = (function () {
  // ── Deployed proxy URL — fill this in after `wrangler deploy` from worker/.
  // See worker/README.md. Left unset, importByLink() throws a clear error
  // rather than silently failing against a placeholder host.
  const DDB_PROXY_URL = 'REPLACE_ME'; // e.g. 'https://wyldwolf-axis-ddb-proxy.<your-subdomain>.workers.dev'

  // ── Link / id parsing ────────────────────────────────────────────────
  // Accepted forms:
  //   https://www.dndbeyond.com/characters/48690485
  //   https://www.dndbeyond.com/characters/48690485/some-character-slug
  //   dndbeyond.com/characters/48690485 (no scheme)
  //   a bare numeric id: 48690485
  function parseCharacterId(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (/^\d+$/.test(s)) return s;
    const m = s.match(/dndbeyond\.com\/characters\/(\d+)/i);
    return m ? m[1] : null;
  }

  // ── Fetch (via the Worker proxy — the browser cannot call D&D Beyond
  // directly, see header comment above) ───────────────────────────────
  async function fetchCharacterJson(characterId) {
    if (!DDB_PROXY_URL || DDB_PROXY_URL === 'REPLACE_ME') {
      throw new Error(
        'D&D Beyond proxy URL not configured. Deploy worker/ (see worker/README.md) and set DDB_PROXY_URL in assets/js/ddb-import.js.'
      );
    }
    const url = `${DDB_PROXY_URL.replace(/\/$/, '')}/?id=${encodeURIComponent(characterId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Proxy returned HTTP ${res.status} for character ${characterId}`);
    }
    const body = await res.json();
    if (!body || body.success === false || !body.data) {
      throw new Error(body && body.message ? body.message : 'D&D Beyond returned no character data (private, deleted, or bad id?)');
    }
    return body.data;
  }

  // ── Derived-stat helpers (best-effort — see README's "mapper edge
  // cases" note; D&D Beyond's real client-side calculation engine is far
  // more elaborate than this, e.g. conditional/situational modifiers,
  // per-context proficiency overrides, and homebrew content are not
  // reproduced here) ────────────────────────────────────────────────────
  const ABILITY_NAMES = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
  const ABILITY_SLUGS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

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

  function allModifiers(char) {
    const groups = char.modifiers || {};
    return Object.keys(groups).reduce((acc, k) => acc.concat(groups[k] || []), []);
  }

  function allActions(char) {
    const groups = char.actions || {};
    return Object.keys(groups).reduce((acc, k) => acc.concat(groups[k] || []), []);
  }

  function allFeats(char) {
    return char.feats || [];
  }

  // proficiency level for a subType among a character's modifiers:
  // 0 = none, 1 = proficient (or half, floored down — rare enough here to
  // simplify), 2 = expertise
  function proficiencyLevel(mods, subType) {
    let level = 0;
    mods.forEach((m) => {
      if (m.subType !== subType) return;
      if (m.type === 'expertise') level = Math.max(level, 2);
      else if (m.type === 'proficiency') level = Math.max(level, 1);
    });
    return level;
  }

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
    if (ws.walk) out.walk = ws.walk;
    if (ws.fly) out.fly = ws.fly;
    if (ws.swim) out.swim = ws.swim;
    if (ws.climb) out.climb = ws.climb;
    if (ws.burrow) out.burrow = ws.burrow;
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
    const mods = allModifiers(char);
    let bonus = 0;
    mods.forEach((m) => {
      if (m.type === 'bonus' && m.subType === 'armor-class') bonus += m.value || m.fixedValue || 0;
    });
    return { value: base + bonus, note };
  }

  function computeHp(char, abilities, totalLevel) {
    const conMod = abilityMod(abilities.Constitution);
    const base = char.baseHitPoints || 0;
    const bonus = char.bonusHitPoints || 0;
    const override = char.overrideHitPoints;
    const max = override != null ? override : base + conMod * totalLevel + bonus;
    return { max };
  }

  function computeClasses(char) {
    return (char.classes || []).map((c) => ({
      name: c.definition ? c.definition.name : 'Class',
      level: c.level,
      subclass: c.subclassDefinition ? c.subclassDefinition.name : null,
    }));
  }

  function computeSavingThrows(mods, abilities, pb) {
    const out = {};
    ABILITY_SLUGS.forEach((s, i) => {
      const name = ABILITY_NAMES[i];
      const level = proficiencyLevel(mods, `${s}-saving-throws`);
      const mod = abilityMod(abilities[name]) + (level ? pb * (level === 2 ? 2 : 1) : 0);
      out[name] = { proficient: level > 0, modifier: mod };
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
    allFeats(char).forEach((f) => {
      const def = f.definition || {};
      if (def.name) out.push({ name: def.name, category: 'Feat', description: stripHtml(def.description) });
    });
    return out;
  }

  function computeActions(char) {
    const acts = allActions(char).map((a) => ({
      name: a.name,
      description: stripHtml(a.description || a.snippet || ''),
    }));
    // Equipped weapons, rendered as simple attack lines alongside named actions.
    const weapons = (char.inventory || [])
      .filter((i) => i.equipped && i.definition && (i.definition.filterType === 'Weapon' || i.definition.attackType))
      .map((i) => ({ name: i.definition.name, description: (i.definition.damage && i.definition.damage.diceString ? `Damage: ${i.definition.damage.diceString} ${i.definition.damageType || ''}`.trim() : '') }));
    return acts.concat(weapons);
  }

  function computeSpells(char) {
    const bySource = char.spells || {};
    const fromSources = Object.keys(bySource).reduce((acc, k) => acc.concat(bySource[k] || []), []);
    const fromClasses = (char.classSpells || []).reduce((acc, cs) => acc.concat(cs.spells || []), []);
    const all = fromSources.concat(fromClasses);
    const seen = new Set();
    const out = [];
    all.forEach((s) => {
      const def = s.definition || {};
      if (!def.name || seen.has(def.name)) return;
      seen.add(def.name);
      out.push({ name: def.name, level: def.level, school: def.school, prepared: !!s.prepared, description: stripHtml(def.description) });
    });
    out.sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name));
    return out;
  }

  function computeEquipment(char) {
    return (char.inventory || []).map((i) => ({
      name: i.definition ? i.definition.name : 'Item',
      quantity: i.quantity || 1,
      equipped: !!i.equipped,
      description: i.definition ? stripHtml(i.definition.description) : '',
    }));
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
      speed: computeSpeed(raw),
      senses: computeSenses(mods),
      languages: computeLanguages(mods),
      savingThrows: computeSavingThrows(mods, abilities, pb),
      skills: computeSkills(mods, abilities, pb),
      features: computeFeatures(raw),
      actions: computeActions(raw),
      spells: computeSpells(raw),
      equipment: computeEquipment(raw),
      importedAt: new Date().toISOString(),
    };
  }

  async function importByLink(link) {
    const id = parseCharacterId(link);
    if (!id) throw new Error('Could not find a D&D Beyond character id in that link.');
    const raw = await fetchCharacterJson(id);
    return mapCharacter(raw);
  }

  return { parseCharacterId, fetchCharacterJson, mapCharacter, importByLink, _internal: { computeAC, computeHp, proficiencyBonus, abilityMod } };
})();
