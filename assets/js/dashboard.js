// dashboard.js — GM landing page: adventure overview + quick nav tiles.
window.AxisDashboard = (function () {
  const { el } = window.AxisRender;
  const State = window.AxisState;

  function render(container, data, navigate) {
    container.innerHTML = '';
    const meta = data.meta;
    container.appendChild(
      el('div', { class: 'view-header' }, [el('h1', {}, [meta.title]), el('div', { class: 'view-sub' }, [meta.setting])])
    );

    const mikko = data.adventures.mikko;
    const prog = State.adventureProgress('mikko', mikko.scenes.length);
    container.appendChild(el('div', { class: 'progress-bar' }, [el('div', { style: `width:${mikko.scenes.length ? (100 * prog.done) / mikko.scenes.length : 0}%` })]));
    container.appendChild(el('div', { class: 'view-sub' }, [`Adventure progress: ${prog.done} / ${prog.total} scenes`]));

    const tiles = [
      ['adventure', 'Adventure Tracker', prog.total],
      ['npcs', 'NPCs', meta.counts.npcs],
      ['adversaries', 'Adversaries', meta.counts.adversaries],
      ['spells', 'Spells', meta.counts.spells],
      ['items', 'Items', meta.counts.items],
      ['subclasses', 'Subclasses', meta.counts.subclasses],
      ['artifacts', 'Artifacts', meta.counts.artifacts],
      ['rules', 'Rules Glossary', meta.counts.rules],
      ['lore', 'Lore', meta.counts.locations],
    ];
    container.appendChild(
      el(
        'div',
        { class: 'dash-grid' },
        tiles.map(([id, label, num]) =>
          el('div', { class: 'dash-tile', onclick: () => navigate(id) }, [el('div', { class: 'num' }, [String(num)]), el('div', { class: 'lbl' }, [label])])
        )
      )
    );

    if (mikko.themes && mikko.themes.length) {
      container.appendChild(el('h2', {}, ['Themes']));
      container.appendChild(el('ul', { class: 'themes-list' }, mikko.themes.map((t) => el('li', {}, [t]))));
    }
  }

  return { render };
})();
