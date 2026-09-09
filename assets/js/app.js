// app.js — tabs/nav and boot. Generic: nav entries point at bucket names;
// adding a second adventure module means adding a data.adventures key and
// one more nav row, not touching this router.
(function () {
  const { el } = window.AxisRender;
  const data = window.AXIS;

  const NAV = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'party', label: 'Party', count: () => window.AxisState.state.party.length },
    { id: 'adventure', label: 'Adventure Tracker' },
    { id: 'npcs', label: 'NPCs', count: () => data.npcs.length },
    { id: 'adversaries', label: 'Adversaries', count: () => data.adversaries.length },
    { id: 'spells', label: 'Spells', count: () => data.spells.length },
    { id: 'items', label: 'Items', count: () => data.items.length },
    { id: 'subclasses', label: 'Subclasses', count: () => data.subclasses.length },
    { id: 'artifacts', label: 'Artifacts', count: () => data.artifacts.length },
    { id: 'rules', label: 'Rules Glossary', count: () => data.rules.length },
    { id: 'lore', label: 'Lore', count: () => data.lore.length },
  ];

  let current = 'dashboard';
  const main = document.getElementById('main-view');
  const navList = document.getElementById('nav-list');

  function buildNav() {
    navList.innerHTML = '';
    NAV.forEach((n) => {
      const btn = el('button', { class: 'navbtn' + (n.id === current ? ' active' : ''), onclick: () => go(n.id) }, [
        n.label,
        n.count ? el('span', { class: 'count' }, [String(n.count())]) : null,
      ]);
      navList.appendChild(el('li', {}, [btn]));
    });
  }

  function go(id) {
    current = id;
    buildNav();
    renderView();
    window.scrollTo(0, 0);
  }

  function renderView() {
    switch (current) {
      case 'dashboard':
        window.AxisDashboard.render(main, data, go);
        break;
      case 'party':
        window.AxisParty.render(main);
        break;
      case 'adventure':
        window.AxisTracker.render(main, 'mikko', data.adventures.mikko, data.adversaries, data.npcs);
        break;
      case 'npcs':
        window.AxisNpcs.render(main, data.npcs);
        break;
      case 'lore':
        window.AxisLore.render(main, data.lore);
        break;
      default:
        window.AxisCatalog.render(main, current, data[current]);
    }
  }

  // Exposed so views that mutate counted state outside the router (party
  // add/remove) can refresh the sidebar's counts without a full nav change.
  window.AxisApp = { refreshNav: buildNav };

  buildNav();
  renderView();
})();
