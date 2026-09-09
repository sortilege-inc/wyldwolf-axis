// vtt.js — the table: a map with a grid, tokens, effects and fog, in its
// own window. Tokens are the scene's combat instances (state.combat); the
// VTT never keeps its own HP or conditions — it reads the instance and
// writes back through the same State functions the encounter panel uses,
// and the bus carries every change to the other windows.
//
// Two views of the same page:
//   vtt.html               GM view: toolbar, drag, right-click menu,
//                          fog at half opacity, hidden tokens dimmed
//   vtt.html?view=player   player view: no controls, fog opaque, hidden
//                          and fogged tokens not drawn, no HP numbers on
//                          non-party tokens
// ?scene=<hash> pins a scene; without it the window follows the GM's
// current scene.
//
// Units: map state is in grid cells (floats allowed); the SVG user space
// is image pixels; grid.size is the cell in pixels, grid.ox/oy the offset
// of the first line — the calibration the GM dials in for a map that
// wasn't drawn on a known grid.
(function () {
  const { el, resolveEntity, toInt } = window.AxisRender;
  const State = window.AxisState;
  const Bus = window.AxisBus;
  const data = window.AXIS;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const params = new URLSearchParams(location.search);
  const PLAYER = params.get('view') === 'player';
  const adventureId = Object.keys(data.adventures)[0];
  const adventure = data.adventures[adventureId];
  const pages = window.AxisTracker.buildPages(adventure);
  const CONDITIONS = window.AxisPlayMode.CONDITION_NAMES || [];

  // Maps that ship with the tool, by scene name (hashes change when the
  // corpus text does; names don't).
  const DEFAULT_MAPS = {
    'The Ramshackle Infirmary': { image: 'assets/maps/haunted-infirmary.webp', w: 2560, h: 1440, grid: { size: 64, ox: 0, oy: 0 } },
  };
  const SIZE_CELLS = { Tiny: 1, Small: 1, Medium: 1, Large: 2, Huge: 3, Gargantuan: 4 };
  const COLORS = { party: '#3ecfc9', companion: '#8fd9d4', npc: '#c9a86a', adversary: '#d84a52' };

  if (PLAYER) document.body.classList.add('player');

  // In a player's browser the play page holds the session; this window
  // only needs to know which character is theirs to allow own-token drags.
  function myMemberId() {
    try {
      const s = JSON.parse(localStorage.getItem('wyldwolf-axis-session') || 'null');
      return s && s.role === 'player' ? s.memberId : null;
    } catch (e) {
      return null;
    }
  }

  function canDrag(t) {
    if (!PLAYER) return true;
    const me = myMemberId();
    if (!me) return false;
    const inst = instances().find((i) => i.instanceId === t.instanceId);
    return !!inst && window.AxisOps.ownsInstance(State.state, me, inst);
  }

  const svg = document.getElementById('map');
  const stage = document.getElementById('vtt-stage');
  const toolbar = document.getElementById('vtt-toolbar');
  const hint = document.getElementById('vtt-hint');

  // ── scene / map state ──────────────────────────────────────────────
  let follow = !params.get('scene');
  let sceneHash = params.get('scene') || gmScene();
  let map = null;
  let tool = 'select'; // select | ping | circle | cone | line | square | reveal
  let selectedId = null; // instanceId
  let selectedEffect = null;
  let view = { x: 0, y: 0, w: 2560, h: 1440 };

  function gmScene() {
    const idx = State.trackerPage(adventureId);
    return pages[idx] ? pages[idx].scene.hash : pages[0] && pages[0].scene.hash;
  }

  function scene() {
    return adventure.scenes.find((s) => s.hash === sceneHash) || null;
  }

  function blankMap() {
    return { image: null, w: 2560, h: 1440, grid: { size: 64, ox: 0, oy: 0, show: true, snap: true }, tokens: [], effects: [], fog: { enabled: false, revealed: [] } };
  }

  function loadMap() {
    let m = State.mapState(sceneHash);
    if (!m) {
      m = blankMap();
      const s = scene();
      const d = s && DEFAULT_MAPS[s.name];
      if (d) {
        m.image = d.image;
        m.w = d.w;
        m.h = d.h;
        Object.assign(m.grid, d.grid);
      }
      if (!PLAYER) State.setMapState(sceneHash, m);
    }
    m.tokens = m.tokens || [];
    m.effects = m.effects || [];
    m.fog = m.fog || { enabled: false, revealed: [] };
    map = m;
  }

  function persist() {
    if (!PLAYER) State.setMapState(sceneHash, map);
  }

  function instances() {
    const c = State.combatState(adventureId, sceneHash);
    return c ? c.instances || [] : [];
  }

  function sizeFor(inst) {
    if (inst.sourceKind === 'party') return 1;
    if (inst.sourceKind === 'companion') {
      const c = State.companionFor(inst.defRef);
      return (c && SIZE_CELLS[c.companion.size]) || 1;
    }
    const found = resolveEntity(inst.defRef, data.adversaries, data.npcs);
    const s = found && found.properties && found.properties.Size;
    return SIZE_CELLS[s] || 1;
  }

  // Every combat instance gets a token; tokens whose instance is gone go
  // too. New tokens stage along the top-left so the GM can drag them out.
  function syncTokens() {
    if (PLAYER) return;
    const insts = instances();
    const ids = new Set(insts.map((i) => i.instanceId));
    const before = map.tokens.length;
    map.tokens = map.tokens.filter((t) => ids.has(t.instanceId));
    let changed = map.tokens.length !== before;
    insts.forEach((inst, i) => {
      if (map.tokens.some((t) => t.instanceId === inst.instanceId)) return;
      map.tokens.push({ instanceId: inst.instanceId, x: 1 + (i % 12) * 1.2, y: 1 + Math.floor(i / 12) * 1.2, size: sizeFor(inst), hidden: false });
      changed = true;
    });
    if (changed) persist();
  }

  // ── geometry ───────────────────────────────────────────────────────
  const cell = () => map.grid.size;
  const toPx = (cx, cy) => ({ x: map.grid.ox + cx * cell(), y: map.grid.oy + cy * cell() });
  const toCell = (px, py) => ({ x: (px - map.grid.ox) / cell(), y: (py - map.grid.oy) / cell() });

  function svgPoint(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function fit() {
    view = { x: 0, y: 0, w: map.w, h: map.h };
    applyView();
  }

  function zoomAt(clientX, clientY, factor) {
    const p = svgPoint(clientX, clientY);
    view.w *= factor;
    view.h *= factor;
    view.x = p.x - (p.x - view.x) * factor;
    view.y = p.y - (p.y - view.y) * factor;
    applyView();
  }

  function isRevealed(t) {
    if (!map.fog.enabled) return true;
    const cx = t.x + t.size / 2;
    const cy = t.y + t.size / 2;
    return map.fog.revealed.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
  }

  // ── SVG helpers ────────────────────────────────────────────────────
  function s(tag, attrs, children) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs || {}) {
      if (k === 'class') n.setAttribute('class', attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => c && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }

  const layers = {};
  function buildLayers() {
    svg.innerHTML = '';
    const defs = s('defs');
    const pattern = s('pattern', { id: 'gridpat', patternUnits: 'userSpaceOnUse' });
    pattern.appendChild(s('path', { class: 'grid-line', fill: 'none' }));
    const mask = s('mask', { id: 'fogmask' });
    mask.appendChild(s('rect', { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: 'white' }));
    layers.fogHoles = s('g');
    mask.appendChild(layers.fogHoles);
    defs.appendChild(pattern);
    defs.appendChild(mask);
    svg.appendChild(defs);
    layers.pattern = pattern;
    layers.image = s('image', { x: 0, y: 0 });
    layers.grid = s('rect', { x: 0, y: 0, fill: 'url(#gridpat)', class: 'grid-fill' });
    layers.effects = s('g', { class: 'effects' });
    layers.fog = s('rect', { x: 0, y: 0, class: 'fog', mask: 'url(#fogmask)' });
    layers.tokens = s('g', { class: 'tokens' });
    layers.pings = s('g', { class: 'pings' });
    layers.preview = s('g', { class: 'preview' });
    ['image', 'grid', 'effects', 'fog', 'tokens', 'preview', 'pings'].forEach((k) => svg.appendChild(layers[k]));
  }

  function renderBase() {
    if (map.image) layers.image.setAttribute('href', map.image);
    else layers.image.removeAttribute('href');
    layers.image.setAttribute('width', map.w);
    layers.image.setAttribute('height', map.h);
    ['grid', 'fog'].forEach((k) => {
      layers[k].setAttribute('width', map.w);
      layers[k].setAttribute('height', map.h);
    });
    const c = cell();
    layers.pattern.setAttribute('width', c);
    layers.pattern.setAttribute('height', c);
    layers.pattern.setAttribute('x', map.grid.ox);
    layers.pattern.setAttribute('y', map.grid.oy);
    layers.pattern.firstChild.setAttribute('d', `M ${c} 0 L 0 0 0 ${c}`);
    layers.grid.style.display = map.grid.show === false ? 'none' : '';
    layers.fog.style.display = map.fog.enabled ? '' : 'none';
    layers.fogHoles.innerHTML = '';
    map.fog.revealed.forEach((r) => {
      const p = toPx(r.x, r.y);
      layers.fogHoles.appendChild(s('rect', { x: p.x, y: p.y, width: r.w * c, height: r.h * c, fill: 'black' }));
    });
  }

  function initials(name) {
    const parts = String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/);
    const core = parts.filter((p) => !/^\d+$/.test(p));
    const num = parts.find((p) => /^\d+$/.test(p));
    let ini = core.slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    return num ? ini + num : ini;
  }

  function renderTokens() {
    layers.tokens.innerHTML = '';
    const insts = instances();
    const c = cell();
    map.tokens.forEach((t) => {
      const inst = insts.find((i) => i.instanceId === t.instanceId);
      if (!inst) return;
      if (PLAYER && (t.hidden || !isRevealed(t))) return;
      const d = t.size * c;
      const p = toPx(t.x, t.y);
      const cx = p.x + d / 2;
      const cy = p.y + d / 2;
      const r = d / 2 - Math.max(2, c * 0.06);
      const color = COLORS[inst.sourceKind] || COLORS.adversary;
      const hpCur = toInt(inst.hpCurrent);
      const hpMax = toInt(inst.hpMax);
      const frac = hpMax ? Math.max(0, Math.min(1, (hpCur || 0) / hpMax)) : null;
      const dead = hpMax != null && hpCur != null && hpCur <= 0;
      const bloodied = !dead && frac != null && frac <= 0.5;
      const showHp = !PLAYER || inst.sourceKind === 'party';

      const g = s('g', {
        class: 'token' + (t.instanceId === selectedId ? ' selected' : '') + (dead ? ' dead' : '') + (bloodied ? ' bloodied' : '') + (t.hidden ? ' hidden-token' : ''),
        'data-id': t.instanceId,
        transform: `translate(${cx},${cy})`,
      });
      g.appendChild(s('circle', { class: 'ring-outline', r: r + 3, fill: 'none', stroke: color, 'stroke-width': Math.max(2, c * 0.05) }));
      g.appendChild(s('circle', { class: 'body', r, fill: bloodied ? '#3a1216' : '#12161b', stroke: color, 'stroke-width': 1.5 }));
      if (frac != null && showHp) {
        const circ = 2 * Math.PI * (r + 3);
        g.appendChild(s('circle', { class: 'hp-ring', r: r + 3, fill: 'none', stroke: frac <= 0.5 ? '#d84a52' : color, 'stroke-width': Math.max(3, c * 0.08), 'stroke-dasharray': `${circ * frac} ${circ}`, transform: 'rotate(-90)', 'stroke-linecap': 'butt' }));
      }
      g.appendChild(s('text', { class: 'ini', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': r * 0.9 }, [initials(inst.displayName)]));
      if (dead) g.appendChild(s('text', { class: 'dead-mark', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': r * 1.6 }, ['✕']));
      (inst.conditions || []).slice(0, 6).forEach((cond, i) => {
        const a = -Math.PI / 2 + (i - 2.5) * 0.42;
        g.appendChild(s('circle', { class: 'pip', cx: Math.cos(a) * (r + 3), cy: Math.sin(a) * (r + 3), r: Math.max(3, c * 0.09) }, [s('title', {}, [cond.name + (cond.duration != null ? ` (${cond.duration}r)` : '')])]));
      });
      const label = showHp && hpMax != null ? `${inst.displayName} ${hpCur}/${hpMax}` : inst.displayName;
      g.appendChild(s('text', { class: 'label', 'text-anchor': 'middle', y: r + Math.max(12, c * 0.3), 'font-size': Math.max(11, c * 0.24) }, [label]));
      layers.tokens.appendChild(g);
    });
  }

  function effectShape(e, cls) {
    const c = cell();
    if (e.kind === 'circle') {
      const p = toPx(e.x, e.y);
      return s('circle', { class: cls, cx: p.x, cy: p.y, r: e.r * c });
    }
    if (e.kind === 'square') {
      const p = toPx(e.x, e.y);
      return s('rect', { class: cls, x: p.x, y: p.y, width: e.w * c, height: e.h * c });
    }
    if (e.kind === 'line') {
      const a = toPx(e.x1, e.y1);
      const b = toPx(e.x2, e.y2);
      return s('line', { class: cls + ' line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': (e.w || 1) * c * 0.6 });
    }
    if (e.kind === 'cone') {
      // 5e cone: width at the far end equals its length → half-angle ≈ 26.6°
      const o = toPx(e.x, e.y);
      const len = e.len * c;
      const half = Math.atan(0.5);
      const a1 = e.angle - half;
      const a2 = e.angle + half;
      const p1 = { x: o.x + Math.cos(a1) * len, y: o.y + Math.sin(a1) * len };
      const p2 = { x: o.x + Math.cos(a2) * len, y: o.y + Math.sin(a2) * len };
      return s('path', { class: cls, d: `M ${o.x} ${o.y} L ${p1.x} ${p1.y} A ${len} ${len} 0 0 1 ${p2.x} ${p2.y} Z` });
    }
    return null;
  }

  function renderEffects() {
    layers.effects.innerHTML = '';
    map.effects.forEach((e) => {
      const node = effectShape(e, 'effect' + (e.id === selectedEffect ? ' selected' : ''));
      if (!node) return;
      node.dataset.id = e.id;
      if (e.label) node.appendChild(s('title', {}, [e.label]));
      layers.effects.appendChild(node);
    });
  }

  function renderAll() {
    renderBase();
    renderEffects();
    renderTokens();
    syncHint();
  }

  function refresh() {
    loadMap();
    syncTokens();
    renderAll();
  }

  function switchScene(hash, refit) {
    sceneHash = hash;
    selectedId = null;
    selectedEffect = null;
    loadMap();
    syncTokens();
    renderAll();
    if (refit) fit();
    document.title = 'Wyldwolf Axis — ' + (scene() ? scene().name : 'Table');
    buildToolbar();
  }

  // ── pings ──────────────────────────────────────────────────────────
  function showPing(cx, cy) {
    const p = toPx(cx, cy);
    const c = cell();
    const ring = s('circle', { cx: p.x, cy: p.y, r: c * 0.2, class: 'ping' });
    const anim = s('animate', { attributeName: 'r', from: c * 0.2, to: c * 2.2, dur: '1.2s', repeatCount: 1, fill: 'freeze' });
    const fade = s('animate', { attributeName: 'opacity', from: 1, to: 0, dur: '1.2s', repeatCount: 1, fill: 'freeze' });
    ring.appendChild(anim);
    ring.appendChild(fade);
    layers.pings.appendChild(ring);
    setTimeout(() => ring.remove(), 1300);
  }

  // ── interaction ────────────────────────────────────────────────────
  let drag = null; // { kind: 'pan'|'token'|'tool', ... }

  function tokenAt(target) {
    const g = target.closest && target.closest('.token');
    return g ? map.tokens.find((t) => t.instanceId === g.dataset.id) : null;
  }

  function snap(v, size) {
    if (!map.grid.snap) return v;
    // odd-sized tokens sit on cells, even ones can sit on lines; keep it
    // simple: snap the top-left to a cell
    return Math.round(v);
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    closeMenu();
    const p = svgPoint(e.clientX, e.clientY);
    const t = tokenAt(e.target);
    if (t && tool === 'select' && canDrag(t)) {
      const c = cell();
      selectedId = t.instanceId;
      selectedEffect = null;
      drag = { kind: 'token', token: t, offX: p.x - toPx(t.x, t.y).x, offY: p.y - toPx(t.x, t.y).y, moved: false };
      svg.setPointerCapture(e.pointerId);
      renderTokens();
      return;
    }
    if (t && !PLAYER) {
      selectedId = t.instanceId;
      renderTokens();
    }
    if (!PLAYER && tool !== 'select') {
      drag = { kind: 'tool', start: toCell(p.x, p.y), cur: toCell(p.x, p.y) };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    const fx = e.target.closest && e.target.closest('.effect');
    if (fx && !PLAYER) {
      selectedEffect = fx.dataset.id;
      selectedId = null;
      renderEffects();
      renderTokens();
    }
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      const scale = view.w / svg.clientWidth;
      view.x = drag.vx - (e.clientX - drag.sx) * scale;
      view.y = drag.vy - (e.clientY - drag.sy) * scale;
      applyView();
      return;
    }
    const p = svgPoint(e.clientX, e.clientY);
    if (drag.kind === 'token') {
      const cpos = toCell(p.x - drag.offX, p.y - drag.offY);
      drag.token.x = cpos.x;
      drag.token.y = cpos.y;
      drag.moved = true;
      const g = layers.tokens.querySelector(`[data-id="${drag.token.instanceId}"]`);
      if (g) {
        const d = drag.token.size * cell();
        const px = toPx(drag.token.x, drag.token.y);
        g.setAttribute('transform', `translate(${px.x + d / 2},${px.y + d / 2})`);
      }
      return;
    }
    if (drag.kind === 'tool') {
      drag.cur = toCell(p.x, p.y);
      layers.preview.innerHTML = '';
      const e2 = toolEffect(drag);
      if (e2) {
        const node = effectShape(e2, 'effect preview');
        if (node) layers.preview.appendChild(node);
      }
    }
  });

  svg.addEventListener('pointerup', (e) => {
    if (!drag) return;
    svg.classList.remove('panning');
    if (drag.kind === 'token') {
      if (drag.moved) {
        drag.token.x = snap(drag.token.x, drag.token.size);
        drag.token.y = snap(drag.token.y, drag.token.size);
        // a position op, not the whole map: it's what a player may send
        State.setTokenPosition(sceneHash, drag.token.instanceId, drag.token.x, drag.token.y);
      } else {
        Bus.emit('select', { kind: 'instance', adventureId, sceneHash, instanceId: drag.token.instanceId });
      }
      renderTokens();
    } else if (drag.kind === 'tool') {
      layers.preview.innerHTML = '';
      const moved = Math.hypot(drag.cur.x - drag.start.x, drag.cur.y - drag.start.y) > 0.15;
      if (tool === 'ping') {
        Bus.emit('ping', { sceneHash, x: drag.start.x, y: drag.start.y });
      } else if (tool === 'reveal') {
        if (moved) {
          map.fog.revealed.push(normRect(drag.start, drag.cur));
          persist();
          renderBase();
        }
      } else if (moved) {
        const fx = toolEffect(drag);
        if (fx) {
          fx.id = State.genEffectId();
          map.effects.push(fx);
          persist();
          renderEffects();
        }
      }
    }
    drag = null;
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  function normRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  function toolEffect(d) {
    const a = d.start;
    const b = d.cur;
    if (tool === 'circle') return { kind: 'circle', x: a.x, y: a.y, r: Math.hypot(b.x - a.x, b.y - a.y) };
    if (tool === 'square') return Object.assign({ kind: 'square' }, normRect(a, b));
    if (tool === 'line') return { kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: 1 };
    if (tool === 'cone') return { kind: 'cone', x: a.x, y: a.y, len: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
    return null;
  }

  window.addEventListener('keydown', (e) => {
    if (PLAYER) return;
    if (e.key === 'Escape') {
      tool = 'select';
      closeMenu();
      selectedEffect = null;
      renderEffects();
      buildToolbar();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEffect && !(e.target instanceof HTMLInputElement)) {
      map.effects = map.effects.filter((x) => x.id !== selectedEffect);
      selectedEffect = null;
      persist();
      renderEffects();
    }
  });

  // ── right-click menu (GM) ──────────────────────────────────────────
  let menu = null;
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }

  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (PLAYER) return;
    closeMenu();
    const t = tokenAt(e.target);
    const fx = e.target.closest && e.target.closest('.effect');
    if (fx) {
      map.effects = map.effects.filter((x) => x.id !== fx.dataset.id);
      persist();
      renderEffects();
      return;
    }
    if (!t) return;
    const inst = instances().find((i) => i.instanceId === t.instanceId);
    if (!inst) return;
    selectedId = t.instanceId;
    renderTokens();
    menu = buildMenu(t, inst);
    const rect = stage.getBoundingClientRect();
    menu.style.left = Math.min(e.clientX - rect.left, rect.width - 260) + 'px';
    menu.style.top = Math.min(e.clientY - rect.top, rect.height - 320) + 'px';
    stage.appendChild(menu);
  });

  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target)) closeMenu();
  });

  function buildMenu(t, inst) {
    const hpCur = toInt(inst.hpCurrent);
    const hpMax = toInt(inst.hpMax);
    const amount = el('input', { type: 'number', class: 'hp-current-input hp-amount', value: '1', min: '1' });
    const dmg = el('button', { class: 'btn btn-danger' }, ['Damage']);
    const heal = el('button', { class: 'btn' }, ['Heal']);
    function applyHp(delta) {
      const next = Math.max(0, (toInt(inst.hpCurrent) || 0) + delta);
      State.setInstanceHp(adventureId, sceneHash, t.instanceId, next);
      closeMenu();
    }
    dmg.addEventListener('click', () => applyHp(-(parseInt(amount.value, 10) || 0)));
    heal.addEventListener('click', () => applyHp(parseInt(amount.value, 10) || 0));

    const condSel = el('select', { class: 'hp-current-input' });
    condSel.appendChild(el('option', { value: '' }, ['+ condition…']));
    CONDITIONS.forEach((n) => condSel.appendChild(el('option', { value: n }, [n])));
    const rounds = el('input', { type: 'number', class: 'hp-current-input hp-amount', placeholder: 'rounds' });
    const applyCond = el('button', { class: 'btn btn-ghost' }, ['Apply']);
    applyCond.addEventListener('click', () => {
      if (!condSel.value) return;
      State.addInstanceCondition(adventureId, sceneHash, t.instanceId, condSel.value, rounds.value);
      closeMenu();
    });
    const existing = (inst.conditions || []).map((c) =>
      el('span', { class: 'chip condition-chip' }, [
        c.name + (c.duration != null ? ` (${c.duration}r)` : ''),
        el('button', { class: 'condition-remove', onclick: () => { State.removeInstanceCondition(adventureId, sceneHash, t.instanceId, c.id); closeMenu(); } }, ['✕']),
      ])
    );

    const hide = el('button', { class: 'btn btn-ghost' }, [t.hidden ? 'Reveal to players' : 'Hide from players']);
    hide.addEventListener('click', () => {
      t.hidden = !t.hidden;
      persist();
      renderTokens();
      closeMenu();
    });
    const sizeSel = el('select', { class: 'hp-current-input' });
    [1, 2, 3, 4].forEach((n) => {
      const o = el('option', { value: String(n) }, [n === 1 ? 'Medium (1)' : n === 2 ? 'Large (2)' : n === 3 ? 'Huge (3)' : 'Gargantuan (4)']);
      if (n === t.size) o.selected = true;
      sizeSel.appendChild(o);
    });
    sizeSel.addEventListener('change', () => {
      t.size = parseInt(sizeSel.value, 10);
      persist();
      renderTokens();
    });
    const remove = el('button', { class: 'btn btn-danger' }, ['Remove from encounter']);
    remove.addEventListener('click', () => {
      if (!confirm(`Remove ${inst.displayName} from the encounter?`)) return;
      State.removeCombatInstance(adventureId, sceneHash, t.instanceId);
      closeMenu();
    });

    return el('div', { class: 'vtt-menu' }, [
      el('h4', {}, [inst.displayName]),
      el('div', { class: 'view-sub' }, [hpMax != null ? `HP ${hpCur} / ${hpMax}` : 'no HP tracked']),
      el('div', { class: 'row' }, [amount, dmg, heal]),
      el('div', { class: 'row' }, existing),
      el('div', { class: 'row' }, [condSel, rounds, applyCond]),
      el('div', { class: 'row' }, [hide, sizeSel]),
      el('div', { class: 'row' }, [remove]),
    ]);
  }

  // ── toolbar (GM) ───────────────────────────────────────────────────
  function toolButton(id, label, title) {
    const b = el('button', { class: 'btn btn-ghost' + (tool === id ? ' active' : ''), title: title || '' }, [label]);
    b.addEventListener('click', () => {
      tool = tool === id ? 'select' : id;
      selectedEffect = null;
      svg.classList.toggle('tool-active', tool !== 'select');
      buildToolbar();
      renderEffects();
    });
    return b;
  }

  function numField(label, get, set, step) {
    const inp = el('input', { type: 'number', class: 'hp-current-input', step: step || 1 });
    inp.value = String(get());
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) set(v);
      persist();
      renderAll();
    });
    return el('label', {}, [label, inp]);
  }

  function check(label, get, set) {
    const inp = el('input', { type: 'checkbox' });
    inp.checked = !!get();
    inp.addEventListener('change', () => {
      set(inp.checked);
      persist();
      renderAll();
    });
    return el('label', {}, [inp, label]);
  }

  function buildToolbar() {
    toolbar.innerHTML = '';
    if (PLAYER) {
      const fitBtn = el('button', { class: 'btn btn-ghost' }, ['Fit']);
      fitBtn.addEventListener('click', fit);
      toolbar.appendChild(el('div', { class: 'group' }, [el('b', {}, [scene() ? scene().name : 'Table']), fitBtn]));
      return;
    }
    // scene
    const sceneSel = el('select', { class: 'tile-picker' });
    pages.forEach((p, i) => {
      const o = el('option', { value: p.scene.hash }, [`${i + 1}. ${p.scene.name}`]);
      if (p.scene.hash === sceneHash) o.selected = true;
      sceneSel.appendChild(o);
    });
    sceneSel.addEventListener('change', () => {
      follow = false;
      followBox.checked = false;
      switchScene(sceneSel.value, true);
    });
    const followBox = el('input', { type: 'checkbox' });
    followBox.checked = follow;
    followBox.addEventListener('change', () => {
      follow = followBox.checked;
      if (follow) switchScene(gmScene(), true);
    });
    toolbar.appendChild(el('div', { class: 'group' }, [sceneSel, el('label', {}, [followBox, 'follow GM'])]));

    // map image
    const img = el('input', { type: 'text', class: 'searchbar vtt-url', placeholder: 'map image URL (assets/maps/…)' });
    img.value = map.image || '';
    const setImg = el('button', { class: 'btn btn-ghost' }, ['Set map']);
    setImg.addEventListener('click', () => {
      const url = img.value.trim();
      if (!url) {
        map.image = null;
        persist();
        renderAll();
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        map.image = url;
        map.w = probe.naturalWidth;
        map.h = probe.naturalHeight;
        persist();
        renderAll();
        fit();
      };
      probe.onerror = () => alert('Could not load that image.');
      probe.src = url;
    });
    toolbar.appendChild(el('div', { class: 'group' }, [img, setImg]));

    // grid
    toolbar.appendChild(el('div', { class: 'group' }, [
      el('span', { class: 'view-sub' }, ['Grid']),
      check('show', () => map.grid.show !== false, (v) => { map.grid.show = v; }),
      check('snap', () => map.grid.snap !== false, (v) => { map.grid.snap = v; }),
      numField('cell px', () => map.grid.size, (v) => { map.grid.size = Math.max(8, v); }),
      numField('x', () => map.grid.ox, (v) => { map.grid.ox = v; }),
      numField('y', () => map.grid.oy, (v) => { map.grid.oy = v; }),
    ]));

    // tools
    toolbar.appendChild(el('div', { class: 'group' }, [
      toolButton('ping', 'Ping', 'Click the map to ping it in every window'),
      toolButton('circle', 'Circle', 'Drag from centre'),
      toolButton('cone', 'Cone', 'Drag from origin toward the target'),
      toolButton('line', 'Line', 'Drag start to end'),
      toolButton('square', 'Square', 'Drag corner to corner'),
    ]));

    // fog
    const resetFog = el('button', { class: 'btn btn-ghost' }, ['Reset']);
    resetFog.addEventListener('click', () => {
      map.fog.revealed = [];
      persist();
      renderBase();
    });
    toolbar.appendChild(el('div', { class: 'group' }, [
      el('span', { class: 'view-sub' }, ['Fog']),
      check('on', () => map.fog.enabled, (v) => { map.fog.enabled = v; }),
      toolButton('reveal', 'Reveal', 'Drag a rectangle to reveal'),
      resetFog,
    ]));

    // view
    const fitBtn = el('button', { class: 'btn btn-ghost' }, ['Fit']);
    fitBtn.addEventListener('click', fit);
    const playerBtn = el('button', { class: 'btn' }, ['Open player view']);
    playerBtn.addEventListener('click', () => {
      const q = '?view=player' + (follow ? '' : '&scene=' + encodeURIComponent(sceneHash));
      window.open(location.pathname + q, 'wyldwolf-axis-player');
    });
    toolbar.appendChild(el('div', { class: 'group last' }, [fitBtn, playerBtn]));
  }

  function syncHint() {
    const n = instances().length;
    if (PLAYER) {
      hint.textContent = myMemberId() ? 'Drag your own tokens · wheel zooms · drag the map to pan' : '';
      return;
    }
    hint.textContent = n
      ? `${n} token${n === 1 ? '' : 's'} · drag to move · right-click for damage, conditions, hide · wheel zooms · Esc clears the tool`
      : 'No encounter running for this scene — hit Run Encounter in the GM window and tokens appear here.';
  }

  // ── bus ────────────────────────────────────────────────────────────
  Bus.on('state:changed', () => refresh());
  Bus.on('scene:changed', (p, meta) => {
    if (meta && meta.remote && follow && p && p.adventureId === adventureId && p.sceneHash !== sceneHash) switchScene(p.sceneHash, true);
  });
  Bus.on('select', (sel, meta) => {
    if (!(meta && meta.remote)) return;
    selectedId = sel && sel.kind === 'instance' && sel.sceneHash === sceneHash ? sel.instanceId : null;
    renderTokens();
  });
  Bus.on('ping', (p, meta) => {
    if (p && p.sceneHash === sceneHash) showPing(p.x, p.y);
  });

  // ── boot ───────────────────────────────────────────────────────────
  buildLayers();
  switchScene(sceneHash, true);
  window.addEventListener('resize', applyView);

  window.AxisVtt = { refresh, fit, map: () => map, scene: () => sceneHash, tool: () => tool };
})();
