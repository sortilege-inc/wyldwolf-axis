// lore.js — setting/adventure narrative, verbatim from the .lore files.
window.AxisLore = (function () {
  const { el } = window.AxisRender;

  function render(container, loreFiles) {
    container.innerHTML = '';
    container.appendChild(el('div', { class: 'view-header' }, [el('h1', {}, ['Lore']), el('div', { class: 'view-sub' }, [`${loreFiles.length} source documents`])]));

    const search = el('input', { class: 'searchbar', type: 'search', placeholder: 'Search lore…' });
    const body = el('div', {});

    function draw() {
      const q = search.value.trim().toLowerCase();
      body.innerHTML = '';
      loreFiles.forEach((file) => {
        const sections = file.sections.filter((s) => !q || s.title.toLowerCase().indexOf(q) !== -1 || s.paragraphs.join(' ').toLowerCase().indexOf(q) !== -1);
        if (!sections.length) return;
        body.appendChild(el('h2', { style: 'margin-top:1.4rem' }, [file.source.replace(/\.lore$/, '')]));
        sections.forEach((s) => {
          const tag = s.level === 1 ? 'h2' : s.level === 2 ? 'h3' : 'h4';
          body.appendChild(
            el('div', { class: 'lore-section' }, [
              el(tag, {}, [s.title]),
              ...s.paragraphs.map((p) => el('p', {}, [p])),
            ])
          );
        });
      });
      if (!body.children.length) body.appendChild(el('div', { class: 'view-sub' }, ['No matches.']));
    }

    search.addEventListener('input', draw);
    container.appendChild(search);
    container.appendChild(body);
    draw();
  }

  return { render };
})();
