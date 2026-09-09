// app.js — shell and boot.
//
// Two modes, picked by viewport width:
//   tiles   (≥ 900px)  the main area is a resizable tile layout
//                      (layout.js); the sidebar lists panels and opens any
//                      that isn't on screen in a drawer
//   single  (< 900px)  one panel at a time, sidebar as tabs — the original
//                      behaviour, kept for phones and narrow panes
// Both mount panels through the same registry (panels.js), so a panel
// never knows which mode it's in.
(function () {
  const { el } = window.AxisRender;
  const State = window.AxisState;
  const Panels = window.AxisPanels;
  const Layout = window.AxisLayout;

  const TILE_MIN_WIDTH = 900;
  const main = document.getElementById('main-view');
  const navList = document.getElementById('nav-list');
  const layoutControls = document.getElementById('layout-controls');

  let mode = null; // 'tiles' | 'single'
  let current = 'dashboard'; // single mode's active panel
  let singleCtx = null;

  function wantTiles() {
    return window.innerWidth >= TILE_MIN_WIDTH;
  }

  function buildNav() {
    navList.innerHTML = '';
    const mounted = mode === 'tiles' ? Layout.mounted() : [current];
    Panels.list().forEach((p) => {
      const btn = el('button', { class: 'navbtn' + (mounted.indexOf(p.id) !== -1 ? ' active' : ''), onclick: () => open(p.id) }, [
        p.label,
        p.count ? el('span', { class: 'count' }, [String(p.count())]) : null,
      ]);
      navList.appendChild(el('li', {}, [btn]));
    });
  }

  function buildLayoutControls() {
    layoutControls.innerHTML = '';
    if (mode !== 'tiles') return;
    const preset = el('select', { class: 'tile-picker', title: 'Layout preset' });
    preset.appendChild(el('option', { value: '' }, ['Layout preset…']));
    Object.keys(Layout.PRESETS).forEach((k) => preset.appendChild(el('option', { value: k }, [Layout.PRESETS[k].name])));
    preset.addEventListener('change', () => {
      if (!preset.value) return;
      Layout.applyPreset(preset.value);
      preset.value = '';
      buildNav();
    });
    const edit = el('button', { class: 'btn btn-ghost' }, ['Edit layout']);
    edit.addEventListener('click', () => Layout.editor());
    layoutControls.appendChild(preset);
    layoutControls.appendChild(edit);
  }

  function open(id) {
    if (mode === 'tiles') {
      Layout.open(id);
      return;
    }
    current = id;
    renderSingle();
    window.scrollTo(0, 0);
  }

  function renderSingle() {
    if (singleCtx) singleCtx.teardown();
    singleCtx = Panels.makeCtx(open);
    main.classList.remove('tiles-mode');
    main.innerHTML = '';
    if (current === 'tracker' || current === 'scene') {
      // one stacked view in single mode, not two tabs
      const d = window.AXIS;
      window.AxisTracker.render(main, Panels.adventureId, d.adventures[Panels.adventureId], d.adversaries, d.npcs, singleCtx);
    } else {
      Panels.mount(main, current, singleCtx);
    }
    buildNav();
  }

  function applyMode() {
    const next = wantTiles() ? 'tiles' : 'single';
    if (next === mode) return;
    mode = next;
    if (singleCtx) {
      singleCtx.teardown();
      singleCtx = null;
    }
    Layout.teardown();
    if (mode === 'tiles') {
      Layout.render(main);
      buildNav();
    } else {
      renderSingle();
    }
    buildLayoutControls();
  }

  // The table (VTT) and the player view are separate windows on the same
  // state; named targets so repeated clicks focus rather than multiply.
  const windowControls = document.getElementById('window-controls');
  const vttBtn = el('button', { class: 'btn' }, ['Open table (VTT)']);
  vttBtn.addEventListener('click', () => window.open('vtt.html', 'wyldwolf-axis-vtt'));
  const playerBtn = el('button', { class: 'btn btn-ghost' }, ['Open player view']);
  playerBtn.addEventListener('click', () => window.open('vtt.html?view=player', 'wyldwolf-axis-player'));
  windowControls.appendChild(vttBtn);
  windowControls.appendChild(playerBtn);

  window.addEventListener('resize', applyMode);
  // Devtools viewport emulation changes innerWidth without a resize event;
  // the media-query change fires either way.
  const mq = window.matchMedia(`(min-width: ${TILE_MIN_WIDTH}px)`);
  if (mq.addEventListener) mq.addEventListener('change', applyMode);

  // Layout changes (tile picker, editor, preset) re-render through
  // Layout.render; the sidebar's active marks follow.
  window.AxisBus.on('state:changed', () => buildNav());

  window.AxisApp = { open, refreshNav: buildNav, mode: () => mode };

  applyMode();
})();
