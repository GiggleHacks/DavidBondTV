// Payment-gated access to the private Telegram group. The group link is NEVER
// exposed publicly: an eligible, logged-in user mints a one-time signed token on
// the website, opens it as a `t.me/<bot>?start=<token>` deep link, and the bot —
// after re-verifying eligibility — DMs them a single-use, self-expiring invite.
// Each member's Telegram user id is captured so a background sweep can remove
// them when their access lapses.
//
// Two trust boundaries:
//   1. The bot webhook is session-less; it's authenticated by a `?token=` secret
//      compared in constant time. Always replies 200 so Telegram stops retrying.
//   2. The link token is HMAC-signed (lib/auth-token.js) and short-lived. It also
//      carries the user's securityStamp, so resetting an account invalidates any
//      outstanding token.
//
// Pure-ish: all Telegram I/O is delegated to the injected `gate`
// (createTelegramGroupGate in lib/telegram-bot.js), and all persistence to the
// injected `store`, which keeps this module trivially unit-testable.
import crypto from 'node:crypto';
import { sendJson, readRawBody } from './http-util.js';
import { createRateLimiter } from './rate-limit.js';
import { createToken, verifyToken } from './auth-token.js';
import { hasActiveMembership } from './membership.js';

/** Constant-time string compare that never throws. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Eligible for the private group? The single source of truth, used by both the
 * mint endpoint and the revocation sweep. "Everyone who paid anything": an active
 * recurring member OR anyone who owns at least one one-time product. One-time
 * products are append-only, so a buyer never lapses — only subscription-only
 * members do, which is exactly when the sweep removes someone.
 */
export function isTelegramEligible(user) {
  if (!user) return false;
  if (hasActiveMembership(user)) return true;
  return Array.isArray(user.products) && user.products.length > 0;
}

export function createTelegramAccess({
  store, currentUser, gate, paymentsStore = null,
  tokenSecret, botUsername = '', webhookToken = '',
  linkTokenTtlMs = 15 * 60_000,
  maxKicksPerSweep = 20,
}) {
  // Configured only with a working gate + the bits needed to build/redeem deep
  // links and authenticate the webhook. Until then the routes ship dark (503) and
  // the sweep never runs — the rest of the app is unaffected.
  const configured = !!(gate && gate.configured && botUsername && webhookToken && tokenSecret);
  const limiter = createRateLimiter(60_000, 3); // 3 mint attempts/min per user

  /** Mint a one-time deep link for an (already eligibility-checked) user. */
  function mintLinkToken(user, now = Date.now()) {
    const token = createToken(tokenSecret, {
      purpose: 'tg-link', uid: user.id, stamp: user.securityStamp,
      jti: crypto.randomBytes(8).toString('hex'),
    }, linkTokenTtlMs, now);
    return { token, deepLink: `https://t.me/${botUsername}?start=${token}` };
  }

  /**
   * Redeem a `/start <token>` from the bot. Re-verifies the token, the account's
   * securityStamp, and live eligibility (which may have lapsed since minting), then
   * mints a single-use invite and binds the Telegram user id to the account.
   * Returns { status, invite? } where status ∈ ok|expired|not_eligible|already_linked|error.
   */
  async function redeemLinkToken(token, from, now = Date.now()) {
    const payload = verifyToken(tokenSecret, token, now);
    if (!payload || payload.purpose !== 'tg-link') return { status: 'expired' };
    const fromId = from && from.id;
    if (!fromId) return { status: 'error' };

    const user = store.getById(payload.uid);
    if (!user || user.securityStamp !== payload.stamp) return { status: 'expired' };

    const tg = user.telegram || {};
    // Refuse to bind a second, different Telegram account to one paid user — but
    // allow re-issuing to the SAME account (they lost the message / want back in),
    // and allow re-linking after a kick (state isn't 'joined').
    if (tg.linkState === 'joined' && tg.userId && String(tg.userId) !== String(fromId)) {
      return { status: 'already_linked' };
    }
    if (!isTelegramEligible(user)) return { status: 'not_eligible' };

    const invite = await gate.createSingleUseInvite(now);
    if (!invite) return { status: 'error' };

    await store.updateUser(user.id, {
      telegram: {
        userId: fromId,
        username: from.username || null,
        joinedAt: now,
        invitedAt: now,
        linkState: 'joined',
      },
    });
    if (paymentsStore) {
      try { await paymentsStore.addTxn(user.id, { kind: 'telegram.linked', ts: now, chatId: fromId }); } catch { /* non-fatal */ }
    }
    return { status: 'ok', invite };
  }

  // User-facing copy keyed by redeem outcome.
  const STATUS_MESSAGE = {
    expired: '⌛ That link has expired or isn’t valid. Open your account page and tap “Get my invite link” for a fresh one.',
    not_eligible: 'We couldn’t find an active purchase on your account. If you think this is a mistake, contact support.',
    already_linked: 'Your account is already linked to a different Telegram user. Contact support if you need to change it.',
    error: 'Something went wrong creating your invite. Please try again in a minute.',
  };

  /** Process a single Telegram update (we only care about `/start <token>`). */
  async function handleUpdate(update, now = Date.now()) {
    const msg = update && update.message;
    const from = msg && msg.from;
    if (!from || !from.id) return;
    // Only ever react in a private (DM) chat. The bot is a group admin so it can
    // issue invites — which also means Telegram delivers it EVERY group message.
    // Without this guard it would DM the canned reply on each one (spam).
    const chatType = msg.chat && msg.chat.type;
    if (chatType && chatType !== 'private') return;
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';

    if (!text.startsWith('/start')) {
      await gate.sendDirectMessage(from.id, 'Hi! To get into the private group, tap “Get my invite link” on your account page.');
      return;
    }
    const token = text.split(/\s+/)[1] || '';
    if (!token) {
      await gate.sendDirectMessage(from.id, 'Use the “Get my invite link” button on your account page to receive a personal invite.');
      return;
    }
    const result = await redeemLinkToken(token, from, now);
    const message = result.status === 'ok'
      ? `✅ Here’s your single-use invite — it’s just for you and expires shortly:\n${result.invite}`
      : (STATUS_MESSAGE[result.status] || STATUS_MESSAGE.error);
    await gate.sendDirectMessage(from.id, message);
  }

  /**
   * Remove one member if they're no longer eligible. Idempotent: guarded by
   * linkState so an already-kicked user is never re-kicked. On a failed removal,
   * leaves state as 'joined' so the next sweep retries.
   */
  async function kickIfIneligible(user, now = Date.now()) {
    const tg = user && user.telegram;
    if (!tg || !tg.userId || tg.linkState !== 'joined') return false;
    if (isTelegramEligible(user)) return false;
    const r = await gate.kickMember(tg.userId);
    if (!r || !r.ok) return false;
    await store.updateUser(user.id, { telegram: { ...tg, linkState: 'kicked' } });
    if (paymentsStore) {
      try { await paymentsStore.addTxn(user.id, { kind: 'telegram.kicked', ts: now, chatId: tg.userId }); } catch { /* non-fatal */ }
    }
    return true;
  }

  /**
   * Background tick: kick any joined member whose access has lapsed. Capped per
   * tick so a mass-lapse event can't burst the Bot API; the next tick continues.
   */
  async function sweep(now = Date.now()) {
    let kicks = 0;
    for (const user of store.listAll()) {
      const tg = user.telegram;
      if (!tg || !tg.userId || tg.linkState !== 'joined') continue;
      if (isTelegramEligible(user)) continue;
      await kickIfIneligible(user, now);
      kicks += 1;
      if (kicks >= maxKicksPerSweep) break;
    }
  }

  // --- route handlers --------------------------------------------------------

  /** POST /api/telegram/link — authenticated; mint a deep link for the caller. */
  async function link(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!configured) return sendJson(res, 503, { error: 'The Telegram group isn’t available yet.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
    if (!isTelegramEligible(user)) return sendJson(res, 403, { error: 'not_eligible' });
    const { deepLink } = mintLinkToken(user);
    const tg = user.telegram || {};
    return sendJson(res, 200, { deepLink, alreadyLinked: tg.linkState === 'joined' });
  }

  /** GET /api/telegram/status — authenticated; lets the account page render. */
  function status(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    const tg = user.telegram || {};
    return sendJson(res, 200, {
      enabled: configured,
      eligible: isTelegramEligible(user),
      linkState: tg.linkState || 'none',
      botUsername: botUsername || '',
    });
  }

  /**
   * POST /api/telegram/webhook?token=… — the bot's update sink. Session-less,
   * authenticated by the URL secret. Always 200 so Telegram stops retrying.
   */
  async function webhook(req, res, url) {
    const token = url.searchParams.get('token') || '';
    if (!webhookToken || !safeEqual(token, webhookToken)) {
      res.writeHead(401); return res.end('Unauthorized');
    }
    const raw = await readRawBody(req, 65_536);
    let update = null;
    try { update = JSON.parse(raw.toString('utf8')); } catch { update = null; }
    try { await handleUpdate(update); } catch { /* swallow — never leak to the bot channel */ }
    return sendJson(res, 200, { ok: true });
  }

  /** Route dispatch. Returns true if handled. */
  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/telegram/status') { status(req, res); return true; }
    if (req.method !== 'POST') return false;
    if (url.pathname === '/api/telegram/webhook') { await webhook(req, res, url); return true; }
    if (url.pathname === '/api/telegram/link') { await link(req, res); return true; }
    return false;
  }

  return {
    handle, sweep, configured, isTelegramEligible,
    mintLinkToken, redeemLinkToken, kickIfIneligible,
    _test: { handleUpdate, link, status, webhook, safeEqual },
  };
}
