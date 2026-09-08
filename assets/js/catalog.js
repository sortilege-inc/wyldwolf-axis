// catalog.js — one generic list+search+detail view, reused for every
// bucket (rules/spells/items/adversaries/subclasses/artifacts). Bucket
// identity is a config object, not a hardcoded function per bucket.
window.AxisCatalog = (function () {
  const { el, markdownish, propList, statBlock, drawer } = window.AxisRender;

  const CONFIGS = {
    rules: { title: 'Rules Glossary', isStatblock: false, excerptKey: 'Description' },
    spells: { title: 'Spells', isStatblock: false, excerptKey: 'Description' },
    items: { title: 'Items & Equipment', isStatblock: false, excerptKey: 'Description' },
    subclasses: { title: 'Subclasses', isStatblock: false, excerptKey: 'Description' },
    artifacts: { title: 'Artifacts', isStatblock: false, excerptKey: 'Description' },
    adversaries: { title: 'Adversaries', isStatblock: true },
  };

  function excerpt(row, cfg) {
    const key = cfg.excerptKey;
    const v = key && row.properties[key];
    if (typeof v === 'string') return v.slice(0, 140);
    return row.extends || '';
  }

  function render(container, bucketName, rows) {
    const cfg = CONFIGS[bucketName];
    container.innerHTML = '';

    const header = el('div', { class: 'view-header' }, [
      el('h1', {}, [cfg.title]),
      el('div', { class: 'view-sub' }, [`${rows.length} entries`]),
    ]);

    const search = el('input', { class: 'searchbar', type: 'search', placeholder: `Search ${cfg.title.toLowerCase()}…` });
    const filterRow = el('div', { class: 'chiprow' });
    const grid = el('div', { class: 'card-grid' });

    // Build a source-tag filter (e.g. only Mikko-original content) when the
    // bucket has any third-party rows.
    const hasThirdParty = rows.some((r) => r.thirdParty);
    let activeFilter = 'all';
    if (hasThirdParty) {
      ['all', 'srd', 'axis', 'mikko'].forEach((f) => {
        const chip = el('button', { class: 'chip' + (f === activeFilter ? ' active' : ''), onclick: () => setFilter(f) }, [
          f === 'all' ? 'All' : f === 'srd' ? 'SRD base' : f === 'axis' ? 'Axis setting' : 'Mikko-original',
        ]);
        chip.dataset.f = f;
        filterRow.appendChild(chip);
      });
    }

    function setFilter(f) {
      activeFilter = f;
      filterRow.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.f === f));
      draw();
    }

    function matches(row, q) {
      if (activeFilter === 'srd' && row.thirdParty) return false;
      if (activeFilter === 'axis' && (!row.thirdParty || row.mikko)) return false;
      if (activeFilter === 'mikko' && !row.mikko) return false;
      if (!q) return true;
      const hay = (row.name + ' ' + JSON.stringify(row.properties)).toLowerCase();
      return hay.indexOf(q) !== -1;
    }

    function draw() {
      const q = search.value.trim().toLowerCase();
      grid.innerHTML = '';
      const filtered = rows.filter((r) => matches(r, q));
      if (!filtered.length) {
        grid.appendChild(el('div', { class: 'view-sub' }, ['No matches.']));
        return;
      }
      filtered.forEach((row) => {
        const card = el(
          'div',
          { class: 'card', onclick: () => openDetail(row, cfg) },
          [
            el('h3', {}, [row.name, row.mikko ? el('span', { class: 'badge mikko' }, ['Mikko']) : row.thirdParty ? el('span', { class: 'badge' }, ['Axis']) : null]),
            row.extends ? el('div', { class: 'tag' }, [row.extends]) : null,
            el('div', { class: 'excerpt' }, [excerpt(row, cfg)]),
          ]
        );
        grid.appendChild(card);
      });
    }

    search.addEventListener('input', draw);
    container.appendChild(header);
    container.appendChild(search);
    if (hasThirdParty) container.appendChild(filterRow);
    container.appendChild(grid);
    draw();
  }

  function openDetail(row, cfg) {
    let body;
    if (cfg.isStatblock) {
      body = statBlock(row.name, row.properties, row.features);
    } else {
      body = el('div', {}, [
        el('h2', {}, [row.name]),
        row.extends ? el('div', { class: 'view-sub' }, [row.extends]) : null,
        propList(row.properties, ['Name']),
      ]);
    }
    drawer(body);
  }

  return { render, openDetail, CONFIGS };
})();
