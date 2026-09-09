// play.js — the player's page: join a session by room code, claim a
// character, play from its sheet. Everything it shows comes over the
// session socket into the same State the GM's page uses; the sheet is
// sheet.js in player mode.
(function () {
  const { el } = window.AxisRender;
  const State = window.AxisState;
  const Bus = window.AxisBus;
  const Session = window.AxisSession;
  const Sheet = window.AxisSheet;

  const main = document.getElementById('play-main');
  const statusEl = document.getElementById('play-status');
  const params = new URLSearchParams(location.search);

  function status(s) {
    statusEl.innerHTML = '';
    if (!s.active) {
      statusEl.appendChild(el('span', { class: 'view-sub' }, ['not in a session']));
      return;
    }
    statusEl.appendChild(el('span', { class: 'chip' + (s.connected ? ' on' : '') }, [s.connected ? 'connected' : s.status]));
    statusEl.appendChild(el('span', { class: 'view-sub' }, [' room ', el('b', {}, [s.info.code])]));
    const leave = el('button', { class: 'btn btn-ghost' }, ['Leave']);
    leave.addEventListener('click', () => {
      Session.leave();
      render();
    });
    statusEl.appendChild(leave);
  }

  function joinScreen() {
    const code = el('input', { type: 'text', class: 'searchbar code-input', placeholder: 'Room code', maxlength: '8', autocapitalize: 'characters' });
    code.value = (params.get('s') || '').toUpperCase();
    const btn = el('button', { class: 'btn' }, ['Join']);
    const msg = el('div', { class: 'view-sub' });
    btn.addEventListener('click', () => {
      const c = code.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(c)) {
        msg.textContent = 'That doesn’t look like a room code.';
        return;
      }
      Session.join(c);
      render();
    });
    return el('div', { class: 'play-card' }, [
      el('h1', {}, ['Join the table']),
      el('p', {}, ['Your GM gave you a room code. Enter it to claim your character.']),
      el('div', { class: 'import-row' }, [code, btn]),
      msg,
      window.AxisConfig.configured ? null : el('div', { class: 'view-sub' }, ['Sessions aren’t configured on this deployment yet.']),
    ]);
  }

  function claimScreen(s) {
    const party = State.state.party || [];
    const cards = party.map((m) => {
      const claimed = s.claims[m.id];
      const btn = el('button', { class: 'btn' + (claimed ? ' btn-ghost' : '') }, [claimed ? `Claimed by ${claimed.name}` : 'Claim']);
      btn.disabled = !!claimed;
      btn.addEventListener('click', () => Session.claim(m.id));
      return el('div', { class: 'card' }, [
        el('h3', {}, [m.snapshot.name]),
        el('div', { class: 'tag' }, [`${m.snapshot.race || '?'} · ${Sheet.classLine(m.snapshot)}`]),
        btn,
      ]);
    });
    return el('div', { class: 'play-card' }, [
      el('h1', {}, ['Who are you?']),
      party.length ? el('div', { class: 'card-grid' }, cards) : el('p', { class: 'view-sub' }, [s.connected ? 'The GM hasn’t added any characters yet.' : 'Connecting…']),
    ]);
  }

  let sheetNode = null;
  function sheetScreen(s) {
    const m = State.member(s.info.memberId);
    if (!m) return el('div', { class: 'play-card' }, [el('p', { class: 'view-sub' }, ['Your character isn’t in the party any more.'])]);
    const tableUrl = 'vtt.html?view=player';
    const bar = el('div', { class: 'chiprow play-bar' }, [
      el('a', { class: 'btn btn-ghost', href: tableUrl, target: 'wyldwolf-axis-player' }, ['Open the table']),
      el('button', { class: 'btn btn-ghost', onclick: () => Session.unclaim(m.id) }, ['Release character']),
    ]);
    sheetNode = Sheet.characterSheet(m, { player: true });
    return el('div', { class: 'play-card wide' }, [bar, sheetNode]);
  }

  function render() {
    const s = Session.current();
    status(s);
    main.innerHTML = '';
    if (!s.active) main.appendChild(joinScreen());
    else if (!s.info.memberId) main.appendChild(claimScreen(s));
    else main.appendChild(sheetScreen(s));
  }

  Session.onChange(render);
  // Changes from elsewhere — the GM's page over the socket, or this
  // player's table window over the bus — redraw the sheet. Its own edits
  // redraw it themselves.
  Bus.on('state:remote', () => render());
  Bus.on('state:changed', (p, meta) => {
    if (meta && meta.remote) render();
  });
  Bus.on('session:error', (p) => {
    const note = el('div', { class: 'view-sub session-error' }, [p.message]);
    main.prepend(note);
    setTimeout(() => note.remove(), 4000);
  });

  render();
  if (params.get('s') && !Session.current().active) {
    Session.join(params.get('s'));
    render();
  }
})();
