// Lightweight 18+ age confirmation. Asked at most ONCE per browser (remembered in
// localStorage) and NEVER to a signed-in account — account holders already
// confirmed they're 18+ when they signed up, so the David Bond admin (and every
// member) skips it. Soft gate, appropriate for mature-but-not-explicit material.
(function ageGate() {
  const KEY = 'dbtv_age_ok';
  // Already confirmed on this browser → never ask again.
  try { if (localStorage.getItem(KEY) === '1') return; } catch { /* storage blocked */ }

  // Otherwise decide based on login state: a signed-in user (incl. davidbond)
  // is never gated; only confirmed-anonymous first-time visitors see it.
  (async function decide() {
    try {
      const me = (await (await fetch('/api/auth/me')).json()).user;
      if (me) { try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } return; }
    } catch { /* network issue → fall through and show the gate */ }
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }());

  function mount() {
    if (document.querySelector('.age-gate')) return;
    const ov = document.createElement('div');
    ov.className = 'age-gate';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Age verification');
    ov.innerHTML = `
      <div class="age-gate-card">
        <h2>Are you 18 or older?</h2>
        <p>This site contains mature content intended for adults. Please confirm your age to continue.</p>
        <button type="button" class="acc-btn gold-cta age-gate-enter">I'm 18 or older — Enter</button>
        <a class="age-gate-leave" href="https://duckduckgo.com">I'm under 18 — Leave</a>
        <p class="age-gate-fine">By entering you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
      </div>`;
    document.body.appendChild(ov);
    document.documentElement.style.overflow = 'hidden';
    ov.querySelector('.age-gate-enter').addEventListener('click', () => {
      try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
      ov.remove();
      document.documentElement.style.overflow = '';
    });
  }
}());
