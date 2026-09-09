// layout.js — the tile layout of the main page.
//
// A layout is a tree: a group { dir: 'row'|'col', children, weights? } whose
// children are panel ids (strings) or one more level of group. The owner's
// rules, enforced by validate():
//   - at most 3 children at the root
//   - a group may nest once: a group inside the root, never a group inside
//     that
//   - a nested group holds at most 3 panels
// Tiles resize by dragging the gutter between siblings; weights are `fr`
// values persisted with the tree.
window.AxisLayout = (function () {
  const { el, drawer } = window.AxisRender;
  const State = window.AxisState;
  const Panels = window.AxisPanels;

  const MAX_CHILDREN = 3;

  const PRESETS = {
    table: { name: 'GM table', tree: { dir: 'row', children: ['tracker', 'scene', { dir: 'col', children: ['inspector', 'rules'] }], weights: [2, 5, 3] } },
    combat: { name: 'Combat', tree: { dir: 'row', children: ['scene', { dir: 'col', children: ['inspector', 'party'] }], weights: [2, 1] } },
    reading: { name: 'Reading', tree: { dir: 'row', children: ['tracker', 'scene'] } },
    single: { name: 'Single panel', tree: { dir: 'row', children: ['dashboard'] } },
  };
  const DEFAULT_PRESET = 'table';

  function isGroup(node) {
    return !!(node && typeof node === 'object' && Array.isArray(node.children));
  }

  // A leaf is a panel id, or a tab set { panels: [ids], active: i } — the
  // sidebar adds panels to a tile as tabs rather than floating them.
  function leafPanels(leaf) {
    return typeof leaf === 'string' ? [leaf] : leaf.panels || [];
  }
  function leafActive(leaf) {
    if (typeof leaf === 'string') return leaf;
    const i = Math.min(leaf.active || 0, leaf.panels.length - 1);
    return leaf.panels[i];
  }

  function validate(tree) {
    const errors = [];
    function walk(node, depth, path) {
      if (!isGroup(node)) {
        const panels = leafPanels(node);
        if (!panels.length) errors.push(`${path}: empty tile`);
        panels.forEach((id) => {
          if (!Panels.PANELS[id]) errors.push(`${path}: unknown panel "${id}"`);
        });
        return;
      }
      if (node.dir !== 'row' && node.dir !== 'col') errors.push(`${path}: dir must be row or col`);
      if (!Array.isArray(node.children) || !node.children.length) errors.push(`${path}: a group needs at least one child`);
      else {
        if (node.children.length > MAX_CHILDREN) errors.push(`${path}: at most ${MAX_CHILDREN} children`);
        node.children.forEach((c, i) => {
          if (isGroup(c) && depth >= 1) errors.push(`${path}.${i}: groups nest only one level`);
          walk(c, depth + 1, `${path}.${i}`);
        });
      }
      if (node.weights && node.weights.length !== (node.children || []).length) errors.push(`${path}: weights must match children`);
    }
    if (!isGroup(tree)) errors.push('root must be a row or column');
    else walk(tree, 0, 'root');
    return errors;
  }

  function clone(tree) {
    return JSON.parse(JSON.stringify(tree));
  }

  function currentTree() {
    const saved = State.layout();
    if (saved && !validate(saved).length) return saved;
    return clone(PRESETS[DEFAULT_PRESET].tree);
  }

  // ── rendering ──────────────────────────────────────────────────────
  let mounts = []; // { id, ctx, tile, parent, index }
  let rootEl = null;
  let tree = null;
  let focused = null; // { parent, index } — the tile the GM last clicked in

  function mounted() {
    return mounts.map((m) => m.id);
  }

  // every panel held as a tab anywhere, active or not
  function present() {
    const out = [];
    (function walk(node) {
      if (isGroup(node)) node.children.forEach(walk);
      else leafPanels(node).forEach((id) => out.push(id));
    })(tree || currentTree());
    return out;
  }

  function teardown() {
    mounts.forEach((m) => m.ctx.teardown());
    mounts = [];
  }

  const RAIL = '28px';

  // A collapsed root column (or row) takes a slim rail instead of its
  // share; `collapsed[i]` lives on the root node and persists with it.
  function isCollapsed(node, i) {
    return !!(node === tree && node.collapsed && node.collapsed[i]);
  }

  function template(node) {
    const n = node.children.length;
    const w = node.weights && node.weights.length === n ? node.weights : node.children.map(() => 1);
    // child, gutter, child, gutter, child
    return w.map((x, i) => (isCollapsed(node, i) ? RAIL : `minmax(0, ${x}fr)`)).join(' 6px ');
  }

  function setCollapsed(i, on) {
    if (!tree.collapsed) tree.collapsed = tree.children.map(() => false);
    // never collapse the last open one
    if (on && tree.children.every((c, j) => j === i || tree.collapsed[j])) return;
    tree.collapsed[i] = on;
    State.setLayout(tree);
    render(rootEl);
  }

  function labelOf(node) {
    if (isGroup(node)) return node.children.map(labelOf).join(' · ');
    const id = leafActive(node);
    return Panels.PANELS[id] ? Panels.PANELS[id].label : id;
  }

  function buildRail(child, i) {
    const rail = el('div', { class: 'tile-rail', title: 'Open ' + labelOf(child) }, [
      el('button', { class: 'tile-collapse', type: 'button', 'aria-label': 'Open column' }, [tree.dir === 'row' ? '▸' : '▾']),
      el('span', { class: 'tile-rail-label' }, [labelOf(child)]),
    ]);
    rail.addEventListener('click', () => setCollapsed(i, false));
    return rail;
  }

  function buildGroup(node, path, rootIndex) {
    const g = el('div', { class: 'tile-group dir-' + node.dir });
    g.style[node.dir === 'row' ? 'gridTemplateColumns' : 'gridTemplateRows'] = template(node);
    node.children.forEach((child, i) => {
      if (i > 0) g.appendChild(buildGutter(node, i - 1, g));
      const ri = node === tree ? i : rootIndex;
      if (isCollapsed(node, i)) g.appendChild(buildRail(child, i));
      else g.appendChild(isGroup(child) ? buildGroup(child, path.concat(i), ri) : buildTile(child, node, i, ri));
    });
    return g;
  }

  function buildTile(leaf, parent, index, rootIndex) {
    const panels = leafPanels(leaf);
    const id = leafActive(leaf);
    const body = el('div', { class: 'tile-body' });
    const picker = el('select', { class: 'tile-picker', title: 'Change this tab' });
    Panels.list().forEach((p) => {
      const o = el('option', { value: p.id }, [p.label]);
      if (p.id === id) o.selected = true;
      picker.appendChild(o);
    });
    picker.addEventListener('change', () => {
      if (typeof parent.children[index] === 'string') parent.children[index] = picker.value;
      else parent.children[index].panels[parent.children[index].active || 0] = picker.value;
      State.setLayout(tree);
      render(rootEl);
    });
    // collapses the whole root column/row this tile belongs to
    const collapse = el('button', { class: 'tile-collapse', type: 'button', title: 'Collapse this column' }, [tree.dir === 'row' ? '◂' : '▴']);
    collapse.hidden = rootIndex == null || tree.children.length < 2;
    collapse.addEventListener('click', () => setCollapsed(rootIndex, true));

    // tabs when the tile holds more than one panel
    let title;
    if (panels.length > 1) {
      title = el('div', { class: 'tile-tabs' }, panels.map((pid, i) => {
        const close = el('button', { class: 'tile-tab-x', type: 'button', title: 'Close' }, ['✕']);
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTab(parent, index, i);
        });
        const t = el('button', { class: 'tile-tab' + (pid === id ? ' on' : ''), type: 'button' }, [Panels.PANELS[pid] ? Panels.PANELS[pid].label : pid, close]);
        t.addEventListener('click', () => {
          parent.children[index].active = i;
          State.setLayout(tree);
          render(rootEl);
        });
        return t;
      }));
    } else {
      title = el('span', {}, [Panels.PANELS[id] ? Panels.PANELS[id].label : id]);
    }
    const isFocused = focused && focused.parent === parent && focused.index === index;
    const tile = el('div', { class: 'tile' + (isFocused ? ' focused' : ''), 'data-panel': id }, [
      el('div', { class: 'tile-head' }, [title, picker, collapse]),
      body,
    ]);
    tile.addEventListener('pointerdown', () => setFocus(parent, index, tile), true);
    const ctx = Panels.makeCtx();
    mounts.push({ id, ctx, tile, parent, index });
    Panels.mount(body, id, ctx);
    return tile;
  }

  function setFocus(parent, index, tile) {
    if (focused && focused.parent === parent && focused.index === index) return;
    focused = { parent, index };
    if (rootEl) rootEl.querySelectorAll('.tile.focused').forEach((t) => t.classList.remove('focused'));
    if (tile) tile.classList.add('focused');
  }

  function closeTab(parent, index, i) {
    const leaf = parent.children[index];
    if (typeof leaf === 'string' || leaf.panels.length < 2) return;
    leaf.panels.splice(i, 1);
    if ((leaf.active || 0) >= leaf.panels.length) leaf.active = leaf.panels.length - 1;
    else if ((leaf.active || 0) > i) leaf.active -= 1;
    if (leaf.panels.length === 1) parent.children[index] = leaf.panels[0];
    State.setLayout(tree);
    render(rootEl);
  }

  // The tile an opened panel lands in: the one last clicked, else the
  // widest root leaf (the scene column in the default layout).
  function targetTile() {
    if (focused && focused.parent.children[focused.index] != null) return focused;
    let best = null;
    const w = tree.weights || tree.children.map(() => 1);
    tree.children.forEach((c, i) => {
      if (isCollapsed(tree, i)) return;
      if (!isGroup(c) && (!best || w[i] > best.w)) best = { parent: tree, index: i, w: w[i] };
    });
    if (best) return best;
    // no root leaf: first leaf of the first open group
    for (let i = 0; i < tree.children.length; i++) {
      const c = tree.children[i];
      if (isGroup(c) && !isCollapsed(tree, i)) return { parent: c, index: 0 };
    }
    return { parent: tree, index: 0 };
  }

  // Drag a gutter to trade space between the two siblings it separates.
  function buildGutter(node, leftIndex, groupEl) {
    const gutter = el('div', { class: 'tile-gutter' });
    gutter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const horizontal = node.dir === 'row';
      const kids = Array.from(groupEl.children).filter((c) => !c.classList.contains('tile-gutter'));
      const a = kids[leftIndex].getBoundingClientRect();
      const b = kids[leftIndex + 1].getBoundingClientRect();
      const start = horizontal ? a.left : a.top;
      const end = horizontal ? b.right : b.bottom;
      const weights = node.weights && node.weights.length === node.children.length ? node.weights.slice() : node.children.map(() => 1);
      const pair = weights[leftIndex] + weights[leftIndex + 1];
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add('dragging');
      function move(ev) {
        const pos = horizontal ? ev.clientX : ev.clientY;
        const f = Math.min(0.9, Math.max(0.1, (pos - start) / (end - start)));
        weights[leftIndex] = +(pair * f).toFixed(3);
        weights[leftIndex + 1] = +(pair * (1 - f)).toFixed(3);
        node.weights = weights;
        groupEl.style[horizontal ? 'gridTemplateColumns' : 'gridTemplateRows'] = template(node);
      }
      function up() {
        gutter.removeEventListener('pointermove', move);
        gutter.removeEventListener('pointerup', up);
        gutter.classList.remove('dragging');
        State.setLayout(tree);
      }
      gutter.addEventListener('pointermove', move);
      gutter.addEventListener('pointerup', up);
    });
    return gutter;
  }

  function render(root) {
    teardown();
    rootEl = root;
    tree = currentTree();
    root.innerHTML = '';
    root.classList.add('tiles-mode');
    root.appendChild(buildGroup(tree, [], null));
  }

  function flash(tile) {
    tile.classList.remove('flash');
    void tile.offsetWidth; // restart the animation
    tile.classList.add('flash');
    tile.scrollIntoView({ block: 'nearest' });
  }

  // Bring a panel to the GM's attention: flash it if it's showing,
  // switch to it if it's a tab somewhere, otherwise add it as a tab to
  // the focused tile.
  function open(id) {
    const m = mounts.find((x) => x.id === id);
    if (m) {
      flash(m.tile);
      return;
    }
    let hit = null;
    (function walk(node) {
      if (hit) return;
      if (isGroup(node)) {
        node.children.forEach((c, i) => {
          if (!hit && !isGroup(c) && leafPanels(c).indexOf(id) !== -1) hit = { parent: node, index: i };
          else if (!hit && isGroup(c)) walk(c);
        });
      }
    })(tree);
    if (!hit) {
      hit = targetTile();
      const leaf = hit.parent.children[hit.index];
      hit.parent.children[hit.index] = typeof leaf === 'string' ? { panels: [leaf, id], active: 1 } : { panels: leaf.panels.concat([id]), active: leaf.panels.length };
    } else {
      const leaf = hit.parent.children[hit.index];
      leaf.active = leaf.panels.indexOf(id);
    }
    focused = { parent: hit.parent, index: hit.index };
    State.setLayout(tree);
    render(rootEl);
    const now = mounts.find((x) => x.id === id);
    if (now) flash(now.tile);
  }

  function applyPreset(key) {
    if (!PRESETS[key]) return;
    State.setLayout(clone(PRESETS[key].tree));
    if (rootEl) render(rootEl);
  }

  // ── editor ─────────────────────────────────────────────────────────
  function editor() {
    const draft = clone(tree || currentTree());
    const errorsEl = el('div', { class: 'view-sub layout-errors' });
    const body = el('div', { class: 'layout-editor' });

    function panelSelect(value, onChange) {
      const s = el('select', { class: 'tile-picker' });
      Panels.list().forEach((p) => {
        const o = el('option', { value: p.id }, [p.label]);
        if (p.id === value) o.selected = true;
        s.appendChild(o);
      });
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }

    function dirToggle(node) {
      const b = el('button', { class: 'btn btn-ghost' }, [node.dir === 'row' ? 'Columns (row)' : 'Rows (column)']);
      b.addEventListener('click', () => {
        node.dir = node.dir === 'row' ? 'col' : 'row';
        draw();
      });
      return b;
    }

    function removeBtn(node, i) {
      const b = el('button', { class: 'btn btn-ghost' }, ['✕']);
      b.disabled = node.children.length <= 1;
      b.addEventListener('click', () => {
        node.children.splice(i, 1);
        if (node.weights) node.weights.splice(i, 1);
        draw();
      });
      return b;
    }

    function addBtn(node, allowGroup) {
      const wrap = el('span', { class: 'chiprow' });
      const addPanel = el('button', { class: 'btn btn-ghost' }, ['+ panel']);
      addPanel.disabled = node.children.length >= MAX_CHILDREN;
      addPanel.addEventListener('click', () => {
        node.children.push('inspector');
        if (node.weights) node.weights.push(1);
        draw();
      });
      wrap.appendChild(addPanel);
      if (allowGroup) {
        const addGroup = el('button', { class: 'btn btn-ghost' }, ['+ group']);
        addGroup.disabled = node.children.length >= MAX_CHILDREN;
        addGroup.addEventListener('click', () => {
          node.children.push({ dir: node.dir === 'row' ? 'col' : 'row', children: ['inspector'] });
          if (node.weights) node.weights.push(1);
          draw();
        });
        wrap.appendChild(addGroup);
      }
      return wrap;
    }

    function drawGroup(node, depth) {
      const box = el('div', { class: 'le-group' });
      box.appendChild(el('div', { class: 'le-row' }, [el('b', {}, [depth === 0 ? 'Layout' : 'Group']), dirToggle(node)]));
      node.children.forEach((c, i) => {
        if (isGroup(c)) {
          const inner = drawGroup(c, depth + 1);
          inner.insertBefore(el('div', { class: 'le-row' }, [removeBtn(node, i)]), inner.firstChild);
          box.appendChild(inner);
        } else {
          const row = el('div', { class: 'le-row' }, [
            panelSelect(leafActive(c), (v) => { node.children[i] = v; }),
            leafPanels(c).length > 1 ? el('span', { class: 'view-sub' }, [`+ ${leafPanels(c).length - 1} tab${leafPanels(c).length > 2 ? 's' : ''}`]) : null,
            removeBtn(node, i),
          ]);
          box.appendChild(row);
        }
      });
      box.appendChild(addBtn(node, depth === 0));
      return box;
    }

    function draw() {
      body.innerHTML = '';
      body.appendChild(el('h2', {}, ['Edit layout']));
      const presetRow = el('div', { class: 'le-row' }, [el('span', { class: 'view-sub' }, ['Start from a preset:'])]);
      Object.keys(PRESETS).forEach((k) => {
        const b = el('button', { class: 'btn btn-ghost' }, [PRESETS[k].name]);
        b.addEventListener('click', () => {
          Object.assign(draft, clone(PRESETS[k].tree));
          delete draft.weights;
          draw();
        });
        presetRow.appendChild(b);
      });
      body.appendChild(presetRow);
      body.appendChild(drawGroup(draft, 0));
      body.appendChild(errorsEl);
      const apply = el('button', { class: 'btn' }, ['Apply']);
      apply.addEventListener('click', () => {
        const errs = validate(draft);
        if (errs.length) {
          errorsEl.textContent = errs.join(' · ');
          return;
        }
        State.setLayout(draft);
        overlay.remove();
        if (rootEl) render(rootEl);
      });
      body.appendChild(el('div', { class: 'chiprow' }, [apply]));
    }

    draw();
    const overlay = drawer(body);
  }

  return { PRESETS, DEFAULT_PRESET, validate, render, open, applyPreset, editor, mounted, present, teardown, currentTree, setCollapsed };
})();
