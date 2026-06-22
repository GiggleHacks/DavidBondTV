// Tenor (Google) GIF search — a thin, zero-dep proxy so the API key stays on the
// server and a safe content filter is always applied. Disabled (enabled:false)
// when TENOR_API_KEY is unset, like the other optional integrations. Never throws.
const API = 'https://tenor.googleapis.com/v2';

/**
 * Validate that a URL is a Tenor-hosted GIF, so we only ever embed images from a
 * trusted origin (defense-in-depth: checked on store AND on render). Accepts
 * https URLs on tenor.com / *.tenor.com whose path ends in .gif.
 */
export function isTenorGifUrl(url) {
  if (typeof url !== 'string' || url.length > 512) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'tenor.com' && !host.endsWith('.tenor.com')) return false;
  return u.pathname.toLowerCase().endsWith('.gif');
}

export function createTenor({ apiKey, fetchImpl = globalThis.fetch, clientKey = 'davidbondtv' } = {}) {
  const enabled = Boolean(apiKey);

  // Slim each Tenor result down to just the urls the picker needs.
  function shape(json) {
    const results = (json && Array.isArray(json.results)) ? json.results : [];
    return results.map((r) => {
      const f = r.media_formats || {};
      const full = f.gif || f.mediumgif || {};
      const tiny = f.tinygif || f.nanogif || full;
      return {
        id: r.id || null,
        url: full.url || null,
        preview: tiny.url || full.url || null,
        desc: r.content_description || '',
      };
    }).filter((g) => g.url && isTenorGifUrl(g.url));
  }

  async function call(endpoint, params) {
    if (!enabled) return [];
    const qs = new URLSearchParams({
      key: apiKey,
      client_key: clientKey,
      contentfilter: 'high', // family-safe picker results (NSFW excluded)
      media_filter: 'gif,tinygif',
      limit: String(params.limit || 24),
      ...params.extra,
    });
    try {
      const res = await fetchImpl(`${API}/${endpoint}?${qs.toString()}`);
      if (!res.ok) return [];
      return shape(await res.json());
    } catch {
      return [];
    }
  }

  return {
    enabled,
    search(q, limit = 24) {
      const term = String(q || '').trim().slice(0, 100);
      if (!term) return Promise.resolve([]);
      return call('search', { limit, extra: { q: term } });
    },
    trending(limit = 24) {
      return call('featured', { limit });
    },
  };
}
