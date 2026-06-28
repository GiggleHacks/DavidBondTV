// Page-visit beacon. Fires once per page load, sends path + referrer +
// persistent device ID to /api/visit. No PII sent from the client — the
// server attaches IP and country. Bots are filtered server-side via the same
// ctx.isBot / isBotUa() path used for watch events.
(function () {
  if (typeof window === 'undefined') return;
  // Never track admin pages even if the script somehow loads there.
  if (location.pathname.startsWith('/god')) return;

  function uuid() {
    try { return crypto.randomUUID(); } catch (e) { return String(Date.now()) + '-' + String(Math.random()).slice(2); }
  }
  function stored(storage, key) {
    try {
      var id = storage.getItem(key);
      if (!id) { id = uuid(); storage.setItem(key, id); }
      return id;
    } catch (e) { return ''; }
  }

  var did;
  var visitorId;
  var sessionId;
  try {
    did = stored(localStorage, 'dbtv_device_id');
    visitorId = stored(localStorage, 'dbtv_visitor_id') || did;
    sessionId = stored(sessionStorage, 'dbtv_session_id');
  } catch (e) { did = ''; visitorId = ''; sessionId = ''; }

  function send() {
    try {
      var payload = JSON.stringify({ path: location.pathname, ref: document.referrer || '', did: did || '', visitorId: visitorId || did || '', sessionId: sessionId || '' });
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
