// Page-visit beacon. Fires once per page load, sends path + referrer +
// persistent device ID to /api/visit. No PII sent from the client — the
// server attaches IP and country. Bots are filtered server-side via the same
// ctx.isBot / isBotUa() path used for watch events.
(function () {
  if (typeof window === 'undefined') return;
  // Never track admin pages even if the script somehow loads there.
  if (location.pathname.startsWith('/god')) return;

  var did;
  try {
    var key = 'dbtv_device_id';
    did = localStorage.getItem(key);
    if (!did) {
      did = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
      localStorage.setItem(key, did);
    }
  } catch (e) { did = ''; }

  function send() {
    try {
      var payload = JSON.stringify({ path: location.pathname, ref: document.referrer || '', did: did || '' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/visit', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/visit', { method: 'POST', body: payload, keepalive: true }).catch(function () {});
      }
    } catch (e) { /* best effort */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', send);
  } else {
    send();
  }
})();
