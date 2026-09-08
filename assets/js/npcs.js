// npcs.js — named characters. Each character in the source is 1-3 DEFs (a
// profile box, sometimes a second "after" profile box, and a stat block if
// the book prints one) that this view groups back into one card per person.
window.AxisNpcs = (function () {
  const { el, markdownish, statBlock, drawer } = window.AxisRender;

  function groupByCharacter(npcs) {
    // primary rows are the ones NOT linked_to another row; secondary
    // profile boxes (linked_to set) attach to their primary by hash.
    const primaries = npcs.filter((n) => !n.linked_to);
    const secondaries = npcs.filter((n) => n.linked_to);
    return primaries.map((p) => ({
      primary: p,
      also: secondaries.filter((s) => s.linked_to === p.hash),
    }));
  }

  function render(container, npcs) {
    container.innerHTML = '';
    container.appendChild(
      el('div', { class: 'view-header' }, [el('h1', {}, ['NPCs']), el('div', { class: 'view-sub' }, [`${npcs.length} entries`])])
    );

    const search = el('input', { class: 'searchbar', type: 'search', placeholder: 'Search NPCs…' });
    const grid = el('div', { class: 'card-grid' });
    const groups = groupByCharacter(npcs);

    function draw() {
      const q = search.value.trim().toLowerCase();
      grid.innerHTML = '';
      groups
        .filter((g) => !q || g.primary.name.toLowerCase().indexOf(q) !== -1)
        .forEach((g) => {
          const p = g.primary;
          const desc = (p.profile && p.profile.description) || '';
          grid.appendChild(
            el('div', { class: 'card', onclick: () => openDetail(g) }, [
              el('h3', {}, [p.name, p.statblock ? el('span', { class: 'badge' }, ['statblock']) : null]),
              p.profile && p.profile.epithet ? el('div', { class: 'tag' }, [p.profile.epithet]) : null,
              el('div', { class: 'excerpt' }, [desc.slice(0, 140)]),
            ])
          );
        });
    }
    search.addEventListener('input', draw);
    container.appendChild(search);
    container.appendChild(grid);
    draw();
  }

  function openDetail(group) {
    const nodes = [];
    const all = [group.primary, ...group.also];
    all.forEach((n, idx) => {
      if (n.profile) {
        nodes.push(
          el('div', { class: 'statblock' }, [
            el('h2', {}, [n.name]),
            n.profile.epithet ? el('div', { class: 'typeline' }, [n.profile.epithet]) : null,
            n.profile.traits && n.profile.traits.length ? el('div', { class: 'stat-row' }, [el('b', {}, ['Traits: ']), n.profile.traits.join(', ')]) : null,
            el('div', { html: markdownish(n.profile.description) }),
          ])
        );
      }
      if (n.statblock) {
        nodes.push(statBlock(n.name, n.statblock, n.features));
      }
    });
    drawer(el('div', {}, nodes.map((n, i) => (i > 0 ? el('div', { style: 'margin-top:1rem' }, [n]) : n))));
  }

  return { render, groupByCharacter };
})();
