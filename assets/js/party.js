// party.js — Party section: add/import a character from a D&D Beyond
// share link, render a full player-character sheet from the imported
// snapshot, GM-editable current HP/conditions/notes, remove, re-sync, and
// party-file export/import. Mirrors catalog.js/tracker.js's pattern of
// generic render(container, ...) functions driven by state.js.
window.AxisParty = (function () {
  const { el, esc, markdownish, fmtMod, drawer } = window.AxisRender;
  const State = window.AxisState;
  const Ddb = window.AxisDdbImport;

  const ABILITY_ORDER = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];

  function classLine(snapshot) {
    return (snapshot.classes || [])
      .map((c) => `${c.name}${c.subclass ? ' (' + c.subclass + ')' : ''} ${c.level}`)
      .join(' / ');
  }

  // ── Character sheet (drawer content), built from a party member's
  // snapshot + the GM's in-app edits on top of it. ─────────────────────
  function characterSheet(member) {
    const s = member.snapshot;
    const gm = member.gm;

    const abilRow = el(
      'div',
      { class: 'abilities-row' },
      ABILITY_ORDER.map((a) =>
        el('div', { class: 'ability-box' }, [
          el('div', { class: 'lbl' }, [a.slice(0, 3).toUpperCase()]),
          el('div', { class: 'val' }, [`${s.abilities[a]} (${fmtMod(s.abilityMods[a])})`]),
        ])
      )
    );

    const hpInput = el('input', { type: 'number', class: 'hp-current-input', value: String(gm.hpCurrent) });
    hpInput.addEventListener('change', () => {
      const v = parseInt(hpInput.value, 10);
      State.setPartyHp(member.id, isNaN(v) ? 0 : v);
    });

    const hpRow = el('div', { class: 'stat-row hp-row' }, [
      el('b', {}, ['Hit Points: ']),
      hpInput,
      el('span', {}, [` / ${s.hpMax}`]),
    ]);

    const topRows = [
      ['Armor Class', `${s.ac.value} (${s.ac.note})`],
      ['Proficiency Bonus', fmtMod(s.proficiencyBonus)],
      ['Speed', Object.entries(s.speed || {}).map(([k, v]) => `${k} ${v} ft.`).join(', ') || '—'],
    ];
    if (s.senses && Object.keys(s.senses).length) topRows.push(['Senses', Object.entries(s.senses).map(([k, v]) => `${k} ${v} ft.`).join(', ')]);
    if (s.languages && s.languages.length) topRows.push(['Languages', s.languages.join(', ')]);

    const savesRow = el('div', { class: 'stat-row' }, [
      el('b', {}, ['Saving Throws: ']),
      el('span', {}, [
        ABILITY_ORDER.filter((a) => s.savingThrows[a] && s.savingThrows[a].proficient)
          .map((a) => `${a.slice(0, 3)} ${fmtMod(s.savingThrows[a].modifier)}`)
          .join(', ') || '—',
      ]),
    ]);

    const skillsWithProf = Object.entries(s.skills || {}).filter(([, v]) => v.proficient);
    const skillsRow = el('div', { class: 'stat-row' }, [
      el('b', {}, ['Skills: ']),
      el('span', {}, [
        skillsWithProf.map(([name, v]) => `${name}${v.expertise ? '*' : ''} ${fmtMod(v.modifier)}`).join(', ') || '—',
      ]),
    ]);

    const conditionsInput = el('input', { type: 'text', class: 'conditions-input', placeholder: 'e.g. poisoned, prone', value: (gm.conditions || []).join(', ') });
    conditionsInput.addEventListener('change', () => {
      const list = conditionsInput.value.split(',').map((c) => c.trim()).filter(Boolean);
      State.setPartyConditions(member.id, list);
    });

    const notesArea = el('textarea', { class: 'notes', placeholder: 'GM notes on this character…' });
    notesArea.value = gm.notes || '';
    notesArea.addEventListener('change', () => State.setPartyNotes(member.id, notesArea.value));

    const featNodes = (s.features || []).map((f) =>
      el('div', { class: 'feature' }, [
        el('span', { class: 'fname' }, [f.name]),
        f.category ? el('span', { class: 'fcat' }, [f.category]) : null,
        f.description ? el('div', { html: markdownish(f.description) }) : null,
      ])
    );

    const actionNodes = (s.actions || []).map((a) =>
      el('div', { class: 'feature' }, [
        el('span', { class: 'fname' }, [a.name]),
        a.description ? el('div', { html: markdownish(a.description) }) : null,
      ])
    );

    const spellNodes = (s.spells || []).length
      ? el('div', {}, [
          el('h3', {}, ['Spells']),
          ...(s.spells || []).map((sp) =>
            el('div', { class: 'feature' }, [
              el('span', { class: 'fname' }, [sp.name]),
              el('span', { class: 'fcat' }, [sp.level === 0 ? 'Cantrip' : `Level ${sp.level}`, sp.school ? ` · ${sp.school}` : '', sp.prepared ? ' · prepared' : '']),
            ])
          ),
        ])
      : null;

    const equipNodes = (s.equipment || []).length
      ? el('div', {}, [
          el('h3', {}, ['Equipment']),
          el(
            'div',
            { class: 'equip-list' },
            (s.equipment || []).map((it) => el('div', { class: 'stat-row' }, [el('b', {}, [it.name]), it.equipped ? el('span', { class: 'badge' }, ['equipped']) : null, it.quantity > 1 ? el('span', {}, [` ×${it.quantity}`]) : null]))
          ),
        ])
      : null;

    return el('div', { class: 'statblock character-sheet' }, [
      el('h2', {}, [s.name]),
      el('div', { class: 'typeline' }, [`${s.race || 'Unknown race'} · ${classLine(s) || 'no class'}${s.background ? ' · ' + s.background : ''}`]),
      el('hr'),
      abilRow,
      el('hr'),
      hpRow,
      ...topRows.map(([label, val]) => el('div', { class: 'stat-row' }, [el('b', {}, [label + ': ']), val || '—'])),
      savesRow,
      skillsRow,
      el('div', { class: 'stat-row' }, [el('b', {}, ['Conditions: ']), conditionsInput]),
      el('hr'),
      featNodes.length ? el('h3', {}, ['Features & Traits']) : null,
      ...featNodes,
      actionNodes.length ? el('h3', {}, ['Actions']) : null,
      ...actionNodes,
      spellNodes,
      equipNodes,
      el('h3', {}, ['GM Notes']),
      notesArea,
      el('div', { class: 'sheet-actions' }, [
        el('button', { class: 'btn', onclick: () => resync(member) }, ['Re-sync from D&D Beyond']),
        el('button', { class: 'btn btn-danger', onclick: () => removeMember(member) }, ['Remove from party']),
      ]),
    ]);
  }

  async function resync(member) {
    if (!confirm(`Re-sync ${member.snapshot.name} from D&D Beyond? This overwrites the imported snapshot (HP/conditions/notes you've entered here are kept).`)) return;
    try {
      const snapshot = await Ddb.importByLink(member.snapshot.ddbId);
      State.resyncPartyMember(member.id, snapshot);
      rerender();
    } catch (e) {
      alert('Re-sync failed: ' + e.message);
    }
  }

  function removeMember(member) {
    if (!confirm(`Remove ${member.snapshot.name} from the party?`)) return;
    State.removePartyMember(member.id);
    document.querySelectorAll('.drawer-overlay').forEach((o) => o.remove());
    rerender();
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

    // ── Add-by-link form ────────────────────────────────────────────
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
    const addRow = el('div', { class: 'import-row' }, [linkInput, addBtn]);

    // ── Party-file export/import ────────────────────────────────────
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
          const parsed = JSON.parse(reader.result);
          State.loadPartyFile(parsed);
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

    // ── Roster ───────────────────────────────────────────────────────
    const grid = el('div', { class: 'card-grid party-grid' });
    if (!State.state.party.length) {
      grid.appendChild(el('div', { class: 'view-sub' }, ['No characters yet — paste a D&D Beyond share link above.']));
    }
    State.state.party.forEach((member) => {
      const s = member.snapshot;
      const hpFrac = s.hpMax ? member.gm.hpCurrent / s.hpMax : 1;
      const card = el(
        'div',
        { class: 'card party-card', onclick: () => drawer(characterSheet(member)) },
        [
          el('h3', {}, [s.name, member.gm.conditions && member.gm.conditions.length ? el('span', { class: 'badge mikko' }, [member.gm.conditions.join(', ')]) : null]),
          el('div', { class: 'tag' }, [`${s.race || '?'} · ${classLine(s)}`]),
          el('div', { class: 'excerpt hp-excerpt' + (hpFrac <= 0.25 ? ' hp-crit' : '') }, [`HP ${member.gm.hpCurrent} / ${s.hpMax} · AC ${s.ac.value}`]),
        ]
      );
      grid.appendChild(card);
    });

    container.appendChild(header);
    container.appendChild(addRow);
    container.appendChild(addStatus);
    container.appendChild(fileRow);
    container.appendChild(grid);
  }

  return { render };
})();
