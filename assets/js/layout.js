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
    return node && typeof node === 'object';
  }

  function validate(tree) {
    const errors = [];
    function walk(node, depth, path) {
      if (!isGroup(node)) {
        if (!Panels.PANELS[node]) errors.push(`${path}: unknown panel "${node}"`);
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
  let mounts = []; // { id, ctx, tile }
  let rootEl = null;
  let tree = null;

  function mounted() {
    return mounts.map((m) => m.id);
  }

  function teardown() {
    mounts.forEach((m) => m.ctx.teardown());
    mounts = [];
  }

  function template(node) {
    const n = node.children.length;
    const w = node.weights && node.weights.length === n ? node.weights : node.children.map(() => 1);
    // child, gutter, child, gutter, child
    return w.map((x) => `minmax(0, ${x}fr)`).join(' 6px ');
  }

  function buildGroup(node, path) {
    const g = el('div', { class: 'tile-group dir-' + node.dir });
    g.style[node.dir === 'row' ? 'gridTemplateColumns' : 'gridTemplateRows'] = template(node);
    node.children.forEach((child, i) => {
      if (i > 0) g.appendChild(buildGutter(node, i - 1, g));
      g.appendChild(isGroup(child) ? buildGroup(child, path.concat(i)) : buildTile(child, node, i));
    });
    return g;
  }

  function buildTile(id, parent, index) {
    const body = el('div', { class: 'tile-body' });
    const picker = el('select', { class: 'tile-picker', title: 'Change this tile' });
    Panels.list().forEach((p) => {
      const o = el('option', { value: p.id }, [p.label]);
      if (p.id === id) o.selected = true;
      picker.appendChild(o);
    });
    picker.addEventListener('change', () => {
      parent.children[index] = picker.value;
      State.setLayout(tree);
      render(rootEl);
    });
    const tile = el('div', { class: 'tile', 'data-panel': id }, [
      el('div', { class: 'tile-head' }, [el('span', {}, [Panels.PANELS[id] ? Panels.PANELS[id].label : id]), picker]),
      body,
    ]);
    const ctx = Panels.makeCtx();
    mounts.push({ id, ctx, tile });
    Panels.mount(body, id, ctx);
    return tile;
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
    root.appendChild(buildGroup(tree, []));
  }

  // Bring a panel to the GM's attention: flash it if it's on screen,
  // otherwise open it in a drawer without disturbing the layout.
  function open(id) {
    const m = mounts.find((x) => x.id === id);
    if (m) {
      m.tile.classList.remove('flash');
      void m.tile.offsetWidth; // restart the animation
      m.tile.classList.add('flash');
      m.tile.scrollIntoView({ block: 'nearest' });
      return;
    }
    const body = el('div', { class: 'drawer-panel' });
    const ctx = Panels.makeCtx();
    Panels.mount(body, id, ctx);
    drawer(body, () => ctx.teardown());
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
            panelSelect(c, (v) => { node.children[i] = v; }),
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

  return { PRESETS, DEFAULT_PRESET, validate, render, open, applyPreset, editor, mounted, teardown, currentTree };
})();
