// party.js — Party panel: import from a D&D Beyond share link, the
// roster, open a sheet (sheet.js), re-sync, remove, and party-file
// export/import.
window.AxisParty = (function () {
  const { el, drawer } = window.AxisRender;
  const State = window.AxisState;
  const Ddb = window.AxisDdbImport;
  const Sheet = window.AxisSheet;

  // A character imported from a PDF re-syncs from a new PDF; one from a
  // share link re-fetches through the Worker.
  async function resync(member) {
    if (member.snapshot.importedFrom === 'pdf') {
      pickPdf(async (file) => {
        try {
          const snapshot = await window.AxisDdbPdf.fromFile(file);
          State.resyncPartyMember(member.id, snapshot);
          rerender();
        } catch (e) {
          alert('Re-sync failed: ' + e.message);
        }
      });
      return;
    }
    if (!confirm(`Re-sync ${member.snapshot.name} from D&D Beyond? This overwrites the imported snapshot (HP, conditions, notes and resources you've tracked here are kept).`)) return;
    try {
      const snapshot = await Ddb.importByLink(member.snapshot.ddbId);
      State.resyncPartyMember(member.id, snapshot);
      rerender();
    } catch (e) {
      alert('Re-sync failed: ' + e.message);
    }
  }

  function pickPdf(onFile) {
    const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'file-input-hidden' });
    input.hidden = true;
    input.addEventListener('change', () => {
      const f = input.files[0];
      input.remove();
      if (f) onFile(f);
    });
    document.body.appendChild(input);
    input.click();
  }

  function removeMember(member) {
    if (!confirm(`Remove ${member.snapshot.name} from the party?`)) return;
    State.removePartyMember(member.id);
    document.querySelectorAll('.drawer-overlay').forEach((o) => o.remove());
    rerender();
  }

  function openSheet(member) {
    drawer(Sheet.characterSheet(member, { onResync: resync, onRemove: removeMember }), rerender);
  }

  let lastContainer = null;
  function rerender() {
    if (lastContainer) render(lastContainer);
    if (window.AxisApp) window.AxisApp.refreshNav();
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function render(container) {
    lastContainer = container;
    container.innerHTML = '';

    const header = el('div', { class: 'view-header' }, [
      el('h1', {}, ['Party']),
      el('div', { class: 'view-sub' }, [`${State.state.party.length} character${State.state.party.length === 1 ? '' : 's'}`]),
    ]);

    const linkInput = el('input', { type: 'text', class: 'searchbar', placeholder: 'Paste a D&D Beyond character share link (dndbeyond.com/characters/<id>)…' });
    const addStatus = el('div', { class: 'view-sub import-status' });
    const addBtn = el('button', { class: 'btn' }, ['Import']);
    addBtn.addEventListener('click', async () => {
      const val = linkInput.value.trim();
      if (!val) return;
      addStatus.textContent = 'Importing…';
      addBtn.disabled = true;
      try {
        const snapshot = await Ddb.importByLink(val);
        State.addPartyMember(snapshot);
        linkInput.value = '';
        addStatus.textContent = `Imported ${snapshot.name}.`;
        rerender();
      } catch (e) {
        addStatus.textContent = 'Import failed: ' + e.message;
      } finally {
        addBtn.disabled = false;
      }
    });
    const pdfBtn = el('button', { class: 'btn btn-ghost', title: 'D&D Beyond → Export → PDF' }, ['Import PDF']);
    pdfBtn.addEventListener('click', () => {
      pickPdf(async (file) => {
        addStatus.textContent = `Reading ${file.name}…`;
        try {
          const snapshot = await window.AxisDdbPdf.fromFile(file);
          State.addPartyMember(snapshot);
          addStatus.textContent = `Imported ${snapshot.name} from PDF.`;
          rerender();
        } catch (e) {
          addStatus.textContent = 'PDF import failed: ' + e.message;
        }
      });
    });
    const addRow = el('div', { class: 'import-row' }, [linkInput, addBtn, pdfBtn]);

    const exportBtn = el('button', { class: 'btn btn-ghost' }, ['Export party file']);
    exportBtn.addEventListener('click', () => downloadJson(State.exportPartyFile(), 'wyldwolf-axis-party.json'));
    const fileInput = el('input', { type: 'file', accept: 'application/json', class: 'file-input-hidden' });
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          State.loadPartyFile(JSON.parse(reader.result));
          rerender();
        } catch (e) {
          alert('Could not load that party file: ' + e.message);
        }
      };
      reader.readAsText(file);
      fileInput.value = '';
    });
    const importBtn = el('button', { class: 'btn btn-ghost' }, ['Import party file']);
    importBtn.addEventListener('click', () => fileInput.click());
    const fileRow = el('div', { class: 'chiprow' }, [exportBtn, importBtn, fileInput]);

    const grid = el('div', { class: 'card-grid party-grid' });
    if (!State.state.party.length) {
      grid.appendChild(el('div', { class: 'view-sub' }, ['No characters yet — paste a D&D Beyond share link above.']));
    }
    State.state.party.forEach((member) => {
      const s = member.snapshot;
      const hpFrac = s.hpMax ? member.gm.hpCurrent / s.hpMax : 1;
      const temp = member.gm.tempHp ? ` (+${member.gm.tempHp} temp)` : '';
      const card = el('div', { class: 'card party-card', onclick: () => openSheet(member) }, [
        el('h3', {}, [s.name, member.gm.conditions && member.gm.conditions.length ? el('span', { class: 'badge mikko' }, [member.gm.conditions.join(', ')]) : null]),
        el('div', { class: 'tag' }, [`${s.race || '?'} · ${Sheet.classLine(s)}`]),
        el('div', { class: 'excerpt hp-excerpt' + (hpFrac <= 0.25 ? ' hp-crit' : '') }, [`HP ${member.gm.hpCurrent} / ${s.hpMax}${temp} · AC ${s.ac.value}`]),
      ]);
      grid.appendChild(card);
    });

    container.appendChild(header);
    container.appendChild(addRow);
    container.appendChild(addStatus);
    container.appendChild(fileRow);
    container.appendChild(grid);
  }

  return { render, openSheet, pickPdf };
})();
