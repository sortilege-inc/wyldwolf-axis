// render.js — generic DOM helpers + a generic stat-block renderer. Nothing
// here knows the word "Mikko": a second adventure module reuses all of it.
window.AxisRender = (function () {
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'html') e.innerHTML = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function markdownish(text) {
    // Source text uses \n\n paragraph breaks and *italics*/**bold** markers
    // (printed monster action lines). Render those, escape everything else.
    if (!text) return '';
    const paras = String(text).split(/\n\s*\n/);
    return paras
      .map((p) => {
        let h = esc(p).replace(/\n/g, '<br>');
        h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        h = h.replace(/\*([^*]+)\*/g, '<i>$1</i>');
        return `<p>${h}</p>`;
      })
      .join('');
  }

  function abilityMod(score) {
    const n = parseInt(score, 10);
    if (isNaN(n)) return null;
    return Math.floor((n - 10) / 2);
  }

  function fmtMod(n) {
    if (n == null) return '—';
    return n >= 0 ? `+${n}` : `${n}`;
  }

  // Generic renderer for any of rules/spells/items/subclasses/artifacts: a
  // name header + a flat "Label: value" list from the entity's properties.
  function propList(properties, skipKeys) {
    skip = skipKeys || [];
    const rows = [];
    for (const key in properties) {
      if (skip.indexOf(key) !== -1) continue;
      const v = properties[key];
      if (v == null || v === '') continue;
      rows.push(renderPropRow(key, v));
    }
    return el('div', { class: 'proplist' }, rows);
  }
  var skip = [];

  function renderPropRow(key, v) {
    let valNode;
    if (Array.isArray(v)) {
      valNode = el('span', {}, [v.join(', ')]);
    } else if (typeof v === 'object') {
      const sub = [];
      for (const k2 in v) sub.push(`${k2}: ${v[k2]}`);
      valNode = el('span', {}, [sub.join(' · ')]);
    } else {
      valNode = el('span', { html: markdownish(String(v)) });
    }
    return el('div', { class: 'stat-row' }, [el('b', {}, [key + ': ']), valNode]);
  }

  // Full 5e-style stat block for an adversary/NPC statblock (a flat
  // "properties" dict shaped like the DEF's typed PROPERTIES, plus a
  // features list of {name, category, description}).
  function statBlock(name, props, features) {
    const abilities = props['Abilities'] || {};
    const abilityOrder = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
    const abilRow = el(
      'div',
      { class: 'abilities-row' },
      abilityOrder.map((a) => {
        const score = abilities[a];
        const mod = score != null ? fmtMod(abilityMod(score)) : '—';
        return el('div', { class: 'ability-box' }, [
          el('div', { class: 'lbl' }, [a.slice(0, 3).toUpperCase()]),
          el('div', { class: 'val' }, [score != null ? `${score} (${mod})` : '—']),
        ]);
      })
    );

    const hp = props['Hit Points'];
    const hpNode = hp != null ? el('span', { class: parseInt(hp, 10) <= 10 ? 'hp-crit' : '' }, [String(hp) + (props['Hit Dice'] ? ` (${props['Hit Dice']})` : '')]) : null;

    const topRows = [];
    if (props['Armor Class'] != null) topRows.push(['Armor Class', `${props['Armor Class']}${props['Armor Class Note'] ? ' (' + props['Armor Class Note'] + ')' : ''}`]);
    if (hpNode) topRows.push(['Hit Points', null]);
    if (props['Speed']) topRows.push(['Speed', Object.entries(props['Speed']).map(([k, v]) => `${k} ${v} ft.`).join(', ')]);
    if (props['Challenge Rating']) {
      const cr = props['Challenge Rating'];
      topRows.push(['Challenge', `${cr.Printed || ''}${props['Experience Points'] ? ` (${props['Experience Points']} XP)` : ''}`]);
    }
    if (props['Saving Throws']) topRows.push(['Saving Throws', Object.entries(props['Saving Throws']).map(([k, v]) => `${k} ${fmtMod(parseInt(v, 10))}`).join(', ')]);
    if (props['Skills']) topRows.push(['Skills', Object.entries(props['Skills']).map(([k, v]) => `${k} ${fmtMod(parseInt(v, 10))}`).join(', ')]);
    if (props['Damage Immunities']) topRows.push(['Damage Immunities', (props['Damage Immunities'] || []).join(', ')]);
    if (props['Condition Immunities']) topRows.push(['Condition Immunities', (props['Condition Immunities'] || []).join(', ')]);
    if (props['Senses']) topRows.push(['Senses', Object.entries(props['Senses']).map(([k, v]) => `${k} ${v}`).join(', ')]);
    if (props['Languages']) topRows.push(['Languages', props['Languages'].Printed || props['Languages'].Note || '']);

    const rowNodes = topRows.map(([label, valText]) => {
      if (label === 'Hit Points') {
        return el('div', { class: 'stat-row' }, [el('b', {}, ['Hit Points: ']), hpNode]);
      }
      return el('div', { class: 'stat-row' }, [el('b', {}, [label + ': ']), valText || '—']);
    });

    const featNodes = (features || []).map((f) =>
      el('div', { class: 'feature' }, [
        el('span', { class: 'fname' }, [f.name]),
        f.category ? el('span', { class: 'fcat' }, [f.category]) : null,
        el('div', { html: markdownish(f.description || '') }),
      ])
    );

    return el('div', { class: 'statblock' }, [
      el('h2', {}, [name]),
      props['Printed Type Line'] ? el('div', { class: 'typeline' }, [props['Printed Type Line']]) : null,
      el('hr'),
      abilRow,
      el('hr'),
      ...rowNodes,
      featNodes.length ? el('hr') : null,
      ...featNodes,
    ]);
  }

  function drawer(contentNode) {
    const overlay = el('div', { class: 'drawer-overlay' }, [
      el('div', { class: 'drawer' }, [
        el('button', { class: 'drawer-close', onclick: () => overlay.remove() }, ['✕']),
        contentNode,
      ]),
    ]);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  return { el, esc, markdownish, propList, statBlock, drawer, abilityMod, fmtMod };
})();
