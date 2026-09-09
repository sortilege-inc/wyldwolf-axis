// targeting.js — pick targets from the running encounter, resolve the
// attack or save against them, and hand the result to the roll log as a
// structured event so the GM can apply damage and conditions with a
// click. Used by the Inspector and the sheet (GM page and player page).
//
// roll events now carry: { who, text, adventureId, sceneHash,
//   targets: [{ instanceId, name, hit, damage, halved }] }
// Older listeners that only read `text` keep working.
window.AxisTargeting = (function () {
  const { el, drawer, resolveEntity, toInt, fmtMod } = window.AxisRender;
  const State = window.AxisState;
  const Bus = window.AxisBus;
  const data = window.AXIS;
  const ABIL = { STR: 'Strength', DEX: 'Dexterity', CON: 'Constitution', INT: 'Intelligence', WIS: 'Wisdom', CHA: 'Charisma' };

  function rollDie(n) {
    return 1 + Math.floor(Math.random() * n);
  }

  // The encounter targets come from: the GM's current scene's combat.
  function encounter() {
    if (!data || !window.AxisTracker) return null;
    const adventureId = Object.keys(data.adventures)[0];
    const pages = window.AxisTracker.buildPages(data.adventures[adventureId]);
    // any running encounter on the current page, else the first running one
    const cur = pages[State.trackerPage(adventureId)];
    const candidates = cur ? [cur].concat(pages.filter((p) => p !== cur)) : pages;
    for (const p of candidates) {
      const c = State.combatState(adventureId, p.scene.hash);
      if (c && (c.instances || []).length) return { adventureId, sceneHash: p.scene.hash, scene: p.scene, combat: c };
    }
    return null;
  }

  function resolved(inst) {
    if (inst.sourceKind === 'party') {
      const m = State.member(inst.defRef);
      return m ? { ac: m.snapshot.ac ? m.snapshot.ac.value : null, saves: m.snapshot.savingThrows || {}, mods: m.snapshot.abilityMods || {} } : { ac: null, saves: {}, mods: {} };
    }
    let props = null;
    if (inst.sourceKind === 'companion') {
      const c = State.companionFor(inst.defRef);
      props = c ? c.companion.statblock : null;
    } else {
      const f = resolveEntity(inst.defRef, data.adversaries, data.npcs);
      props = f ? f.properties : null;
    }
    if (!props) return { ac: null, saves: {}, mods: {} };
    const mods = {};
    Object.keys(props.Abilities || {}).forEach((a) => (mods[a] = Math.floor((toInt(props.Abilities[a]) - 10) / 2)));
    const saves = {};
    Object.keys(props['Saving Throws'] || {}).forEach((k) => {
      const full = ABIL[k.slice(0, 3).toUpperCase()] || k;
      saves[full] = { modifier: toInt(props['Saving Throws'][k]) };
    });
    return { ac: toInt(props['Armor Class']), saves, mods };
  }

  function saveMod(inst, ability) {
    const r = resolved(inst);
    if (r.saves[ability] && r.saves[ability].modifier != null) return r.saves[ability].modifier;
    return r.mods[ability] != null ? r.mods[ability] : 0;
  }

  // ── the picker ─────────────────────────────────────────────────────
  // resolves to { enc, targets } (targets may be empty for "no target"),
  // or null when cancelled / no encounter is running
  function pick(opts) {
    opts = opts || {};
    const enc = encounter();
    return new Promise((resolve) => {
      if (!enc) {
        resolve(null);
        return;
      }
      const instances = enc.combat.instances.filter((i) => i.instanceId !== opts.excludeInstanceId);
      const chosen = new Set();
      const rows = instances.map((inst) => {
        const cb = el('input', { type: 'checkbox' });
        cb.addEventListener('change', () => (cb.checked ? chosen.add(inst.instanceId) : chosen.delete(inst.instanceId)));
        const r = resolved(inst);
        const hp = toInt(inst.hpCurrent);
        const max = toInt(inst.hpMax);
        const row = el('label', { class: 'tg-row kind-' + (inst.sourceKind || 'adversary') }, [
          cb,
          el('span', { class: 'tg-name' }, [inst.displayName]),
          el('span', { class: 'tg-meta' }, [[r.ac != null ? 'AC ' + r.ac : null, max != null ? `${hp}/${max}` : null].filter(Boolean).join(' · ')]),
          ...(inst.conditions || []).map((c) => el('span', { class: 'chip condition-chip' }, [c.name])),
        ]);
        if (!opts.multi) {
          cb.type = 'radio';
          cb.name = 'tg';
          cb.addEventListener('change', () => {
            chosen.clear();
            chosen.add(inst.instanceId);
          });
        }
        return row;
      });
      let done = false;
      const finish = (targets) => {
        if (done) return;
        done = true;
        overlay.remove();
        resolve(targets ? { enc, targets } : null);
      };
      const go = el('button', { class: 'btn' }, [opts.verb || 'Roll']);
      go.addEventListener('click', () => finish(instances.filter((i) => chosen.has(i.instanceId))));
      const none = el('button', { class: 'btn btn-ghost' }, ['No target']);
      none.addEventListener('click', () => finish([]));
      const cancel = el('button', { class: 'btn btn-ghost' }, ['Cancel']);
      cancel.addEventListener('click', () => finish(null));
      const body = el('div', { class: 'targeting' }, [
        el('h2', {}, [opts.title || 'Target']),
        el('div', { class: 'view-sub' }, [`${enc.scene.name} · ${opts.multi ? 'choose any' : 'choose one'}`]),
        el('div', { class: 'tg-list' }, rows),
        el('div', { class: 'chiprow' }, [go, none, cancel]),
      ]);
      const overlay = drawer(body, () => finish(null));
    });
  }

  // ── resolution ─────────────────────────────────────────────────────
  function rollDamage(damage) {
    if (!damage || !damage.dice) return null;
    const d = window.AxisPlayMode.rollDiceExpr(damage.dice);
    return d.total != null ? { total: d.total, detail: `${damage.dice} ${d.detail} = ${d.total}${damage.type ? ' ' + damage.type : ''}` } : null;
  }

  function emit(who, text, enc, targets) {
    Bus.emit('roll', { who, text, adventureId: enc ? enc.adventureId : null, sceneHash: enc ? enc.sceneHash : null, targets: targets || [] });
  }

  // attack: one d20 per target against its AC; damage rolled per hit
  async function attack(who, name, bonus, damage, opts) {
    const picked = await pick(Object.assign({ title: `${name} — target`, multi: false }, opts || {}));
    if (picked === null && encounter()) return; // cancelled
    const enc = picked ? picked.enc : null;
    const targets = picked ? picked.targets : [];
    if (!targets.length) {
      const r = rollDie(20);
      const dmg = rollDamage(damage);
      emit(who, `${who} — ${name}: attack d20 [${r}]${fmtMod(bonus)} = ${r + bonus}${r === 20 ? ' CRIT' : ''}${dmg ? ' · ' + dmg.detail : ''}`, enc, []);
      return;
    }
    const out = [];
    const parts = [];
    targets.forEach((t) => {
      const r = rollDie(20);
      const total = r + bonus;
      const ac = resolved(t).ac;
      const hit = r === 20 || (r !== 1 && (ac == null || total >= ac));
      const dmg = hit ? rollDamage(damage) : null;
      parts.push(`vs ${t.displayName}${ac != null ? ' (AC ' + ac + ')' : ''}: d20 [${r}]${fmtMod(bonus)} = ${total} ${hit ? (r === 20 ? 'CRIT' : 'hit') : 'miss'}${dmg ? ' · ' + dmg.detail : ''}`);
      out.push({ instanceId: t.instanceId, name: t.displayName, hit, damage: dmg ? dmg.total : 0 });
    });
    emit(who, `${who} — ${name}: ${parts.join(' | ')}`, enc, out);
  }

  // save: each target rolls its save against the DC; damage halves on a success
  async function save(who, name, ability, dc, damage, opts) {
    const picked = await pick(Object.assign({ title: `${name} — targets (${ability.slice(0, 3)} save DC ${dc})`, multi: true }, opts || {}));
    if (picked === null && encounter()) return;
    const enc = picked ? picked.enc : null;
    const targets = picked ? picked.targets : [];
    const dmg = rollDamage(damage);
    if (!targets.length) {
      emit(who, `${who} — ${name}: ${ability.slice(0, 3)} save DC ${dc}${dmg ? ' · ' + dmg.detail : ''}`, enc, []);
      return;
    }
    const out = [];
    const parts = [];
    targets.forEach((t) => {
      const mod = saveMod(t, ability);
      const r = rollDie(20);
      const total = r + mod;
      const ok = total >= dc;
      const amount = dmg ? (ok ? Math.floor(dmg.total / 2) : dmg.total) : 0;
      parts.push(`${t.displayName}: ${ability.slice(0, 3)} d20 [${r}]${fmtMod(mod)} = ${total} ${ok ? 'saves' : 'fails'}${dmg ? ' → ' + amount : ''}`);
      out.push({ instanceId: t.instanceId, name: t.displayName, hit: !ok, saved: ok, damage: amount, halved: ok && !!dmg });
    });
    emit(who, `${who} — ${name} (DC ${dc}${dmg ? ', ' + dmg.detail : ''}): ${parts.join(' | ')}`, enc, out);
  }

  // anything else with a target: log who it was used on
  async function use(who, name, opts) {
    const picked = await pick(Object.assign({ title: `${name} — target`, multi: true, verb: 'Use' }, opts || {}));
    if (picked === null && encounter()) return;
    const enc = picked ? picked.enc : null;
    const targets = picked ? picked.targets : [];
    emit(who, `${who} — ${name}${targets.length ? ' on ' + targets.map((t) => t.displayName).join(', ') : ''}`, enc, targets.map((t) => ({ instanceId: t.instanceId, name: t.displayName, hit: true, damage: 0 })));
  }

  function applyDamage(adventureId, sceneHash, instanceId, amount) {
    const c = State.combatState(adventureId, sceneHash);
    const inst = c && (c.instances || []).find((i) => i.instanceId === instanceId);
    if (!inst) return false;
    State.setInstanceHp(adventureId, sceneHash, instanceId, Math.max(0, (toInt(inst.hpCurrent) || 0) - amount));
    return true;
  }

  return { pick, attack, save, use, applyDamage, encounter, resolved };
})();
