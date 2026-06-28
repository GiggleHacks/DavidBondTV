// GigaBrain first-party analytics tracker — vanilla port of the kit's React
// component (components/Analytics.tsx). Assigns a localStorage visitor id + a
// sessionStorage session id and POSTs pageview / heartbeat / exit / cta / click
// events to the sidecar's /api/collect.
//
// The sidecar runs on its own origin (analytics.davidbondtv.com locally
// http://localhost:3001), read from this script tag's data-base attribute.
// Because that's a cross-origin POST, events are sent as a *simple* request
// (Content-Type text/plain, mode:"no-cors") so the browser skips the CORS
// preflight — the collect route ignores Content-Type and just reads the body.
(function () {
  if (typeof window === 'undefined') return;
  // Defense-in-depth: never track admin pages even if injected there.
  if (location.pathname.indexOf('/god') === 0) return;

  var self = document.currentScript;
  var BASE = ((self && self.getAttribute('data-base')) || '').replace(/\/+$/, '');
  if (!BASE) return; // nothing to post to
  var COLLECT = BASE + '/api/collect';

  var VID_KEY = 'adc_vid';
  var SID_KEY = 'adc_sid';
  var SID_TS_KEY = 'adc_sid_ts';
  var SESSION_GAP = 30 * 60 * 1000; // 30 min

  function uuid() {
    try { return crypto.randomUUID(); }
    catch (e) { return 'v-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  }
  function getVisitorId() {
    try {
      var v = localStorage.getItem(VID_KEY);
      if (!v) { v = uuid(); localStorage.setItem(VID_KEY, v); }
      return v;
    } catch (e) { return uuid(); }
  }
  function getSessionId() {
    try {
      var now = Date.now();
      var last = Number(sessionStorage.getItem(SID_TS_KEY) || 0);
      var sid = sessionStorage.getItem(SID_KEY);
      if (!sid || now - last > SESSION_GAP) { sid = uuid(); sessionStorage.setItem(SID_KEY, sid); }
      sessionStorage.setItem(SID_TS_KEY, String(now));
      return sid;
    } catch (e) { return uuid(); }
  }

  var engagement = 0;      // active (visible+focused) ms on current page
  var lastTick = Date.now();
  var maxScroll = 0;
  var visible = document.visibilityState !== 'hidden';

  // accumulate active time
  setInterval(function () {
    var now = Date.now();
    if (visible && document.hasFocus()) engagement += now - lastTick;
    lastTick = now;
  }, 1000);

  // scroll depth
  function onScroll() {
    var h = document.documentElement;
    var denom = h.scrollHeight - h.clientHeight;
    var pct = denom > 0 ? Math.min(100, Math.round((h.scrollTop / denom) * 100)) : 0;
    if (pct > maxScroll) maxScroll = pct;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  function send(type, extra, beacon) {
    try {
      var payload = {
        t: type,
        u: location.href,
        p: location.pathname,
        ti: document.title,
        r: document.referrer || '',
        vid: getVisitorId(),
        sid: getSessionId(),
        eng: engagement,
        scroll: maxScroll
      };
      if (extra) { for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k]; }
      var data = JSON.stringify(payload);
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(COLLECT, new Blob([data], { type: 'text/plain' }));
      } else {
        fetch(COLLECT, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: data,
          keepalive: true,
          mode: 'no-cors'
        }).catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }

  function pageview() {
    engagement = 0;
    maxScroll = 0;
    lastTick = Date.now();
    send('pageview');
  }

  // Fire the initial pageview, and again on SPA-style navigation. davidbondtv is
  // multi-page (a fresh load per page covers most navigation), but we also patch
  // history so any client-side route change is captured.
  pageview();
  var _ps = history.pushState;
  history.pushState = function () { var r = _ps.apply(this, arguments); pageview(); return r; };
  var _rs = history.replaceState;
  history.replaceState = function () { var r = _rs.apply(this, arguments); return r; };
  window.addEventListener('popstate', pageview);

  // heartbeat while visible
  setInterval(function () { if (visible) send('heartbeat'); }, 15000);

  // exit (engagement flush) on tab hide / page unload — beacon for reliability
  document.addEventListener('visibilitychange', function () {
    visible = document.visibilityState === 'visible';
    if (!visible) send('exit', null, true);
    else lastTick = Date.now();
  });
  window.addEventListener('pagehide', function () { send('exit', null, true); });

  // clicks: tel:/#book/data-cta = conversion; mailto/other = activity-log click
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a,button') : null;
    if (!a) return;
    var href = (a.getAttribute && a.getAttribute('href')) || '';
    var isTel = href.indexOf('tel:') === 0;
    var isMail = href.indexOf('mailto:') === 0;
    var isBook = href.indexOf('#book') !== -1 || (a.getAttribute && a.getAttribute('data-cta') !== null);
    var text = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (isTel || isBook) {
      send('cta', { cta: isTel ? 'Call phone' : (text || 'Book') });
    } else {
      var label = isMail ? 'Email link' : (text || href.slice(0, 80));
      if (label) send('click', { cta: label });
    }
  }, true);
})();
