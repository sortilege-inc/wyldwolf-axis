// gate.js — a table password. A latch, not security: it keeps the site
// from being wandered into, and nothing more. Loaded first on every
// page; the page's own scripts still run behind it, the overlay just
// hides them until the phrase is entered once (remembered per browser).
//
// The input is type="text" on purpose — a shared table code should not
// collide with password-manager autofill.
(function () {
  const KEY = 'wyldwolf-axis-unlocked';
  const DIGEST = '02775903812bb98dba21f0c98dbcd9369b98ca142e92e12b167ec4abc946ce00';

  let unlocked = false;
  try {
    unlocked = localStorage.getItem(KEY) === DIGEST;
  } catch (e) {
    unlocked = false;
  }
  if (unlocked) return;

  document.documentElement.classList.add('gated');

  async function digest(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function build() {
    const wrap = document.createElement('div');
    wrap.className = 'gate';
    wrap.innerHTML =
      '<form class="gate-card">' +
      '<div class="gate-brand">Wyldwolf Axis<small>The Exorcism of Mikko</small></div>' +
      '<label class="gate-label" for="gate-input">Table password</label>' +
      '<input id="gate-input" class="gate-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false">' +
      '<button class="gate-btn" type="submit">Enter</button>' +
      '<div class="gate-msg" aria-live="polite"></div>' +
      '</form>';
    const form = wrap.querySelector('form');
    const input = wrap.querySelector('input');
    const msg = wrap.querySelector('.gate-msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = await digest(input.value.trim());
      if (d === DIGEST) {
        try {
          localStorage.setItem(KEY, DIGEST);
        } catch (err) {
          /* no storage: unlocked for this page only */
        }
        wrap.remove();
        document.documentElement.classList.remove('gated');
      } else {
        msg.textContent = 'That is not it.';
        input.select();
      }
    });
    document.body.appendChild(wrap);
    input.focus();
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
