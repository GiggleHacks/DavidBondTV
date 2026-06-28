function uuid() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function stored(storage, key) {
  try {
    let id = storage.getItem(key);
    if (!id) { id = uuid(); storage.setItem(key, id); }
    return id;
  } catch {
    return uuid();
  }
}

export function analyticsIdentity() {
  const visitorId = stored(localStorage, 'dbtv_visitor_id');
  const deviceId = stored(localStorage, 'dbtv_device_id');
  const sessionId = stored(sessionStorage, 'dbtv_session_id');
  return { visitorId, deviceId, sessionId };
}

export function analyticsContext(extra = {}) {
  const ids = analyticsIdentity();
  return {
    ...ids,
    did: ids.deviceId,
    sid: ids.sessionId,
    path: location.pathname + location.search,
    referrer: document.referrer || '',
    viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
    ...extra,
  };
}

export function trackEvent(eventType, extra = {}) {
  const payload = JSON.stringify(analyticsContext({ eventType, ...extra }));
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/analytics/event', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/analytics/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
    }
  } catch {
    // best effort
  }
}
