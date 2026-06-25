const API = 'https://api.telegram.org/bot';

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtAmount(cents, currency) {
  if (typeof cents !== 'number') return '—';
  const sym = (currency || 'usd').toUpperCase() === 'USD' ? '$' : `${(currency || '').toUpperCase()} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}

function fmtTime(ts) {
  try { return new Date(ts).toUTCString(); } catch { return String(ts); }
}

// Rough net after Stripe's standard US card fee (2.9% + 30¢). The owner asked for
// "the exact amount deposited"; without an extra balance-transaction API call this
// is the closest local estimate. Returns whole cents.
function estimateStripeNet(cents) {
  if (typeof cents !== 'number' || cents <= 0) return { fee: 0, net: typeof cents === 'number' ? cents : 0 };
  const fee = Math.round(cents * 0.029) + 30;
  return { fee, net: Math.max(0, cents - fee) };
}

const templates = {
  new_subscription(d) {
    const yearly = d.interval === 'year';
    const plan = yearly ? 'Yearly' : d.interval === 'month' ? 'Monthly' : (d.interval || '—');
    // "Charged today" is the real first-invoice amount when we have it (intro/coupon
    // applied), otherwise the recurring price. Recurring is the ongoing bill.
    const recurring = typeof d.recurringAmount === 'number' ? d.recurringAmount
      : (typeof d.amount === 'number' ? d.amount : null);
    const charged = typeof d.chargedToday === 'number' ? d.chargedToday : recurring;
    const { fee, net } = estimateStripeNet(charged);
    const lines = [
      `💸🎉 <b>NEW SALE!</b> 🎉💸`,
      ``,
      `👤 ${escapeHtml(d.username)}`,
      `📧 ${escapeHtml(d.email || '—')}`,
      `🪪 ${escapeHtml(plan)} membership`,
      `💳 Charged today: <b>${fmtAmount(charged, d.currency)}</b>`,
      `🔁 Ongoing: ${fmtAmount(recurring, d.currency)}/${yearly ? 'yr' : 'mo'}`,
    ];
    if (d.couponCode) {
      lines.push(`🏷️ Coupon: ${escapeHtml(d.couponCode)}${typeof d.couponPercentOff === 'number' ? ` (−${d.couponPercentOff}%)` : ''}`);
    }
    lines.push(`🏦 Est. Stripe fee: −${fmtAmount(fee, d.currency)}`);
    lines.push(`✅ Est. net deposited: <b>${fmtAmount(net, d.currency)}</b>`);
    return lines.join('\n');
  },
  renewal(d) {
    const { fee, net } = estimateStripeNet(typeof d.amount === 'number' ? d.amount : 0);
    return `💰 <b>Renewal</b> — ${escapeHtml(d.username)}\n`
      + `💳 Charged: ${fmtAmount(d.amount, d.currency)}\n`
      + `✅ Est. net: ${fmtAmount(net, d.currency)} (fee −${fmtAmount(fee, d.currency)})`;
  },
  course_purchase(d) {
    return `🛒 <b>Course sale!</b> ${escapeHtml(d.username)} bought ${escapeHtml(d.product || 'a course')} — ${fmtAmount(d.amount, d.currency)}`;
  },
};

export function createTelegramNotifier({ botToken, chatId } = {}) {
  const configured = !!(botToken && chatId);

  function formatMessage(eventType, data) {
    const fn = templates[eventType];
    return fn ? fn(data) : `📢 <b>${escapeHtml(eventType)}</b>\n${JSON.stringify(data)}`;
  }

  async function sendMessage(text) {
    const res = await fetch(`${API}${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error(`[telegram] sendMessage failed: ${res.status}`);
  }

  function notify(eventType, data) {
    if (!configured) return;
    try {
      const text = formatMessage(eventType, data);
      sendMessage(text).catch((err) => console.error('[telegram]', err.message || err));
    } catch (err) {
      console.error('[telegram]', err.message || err);
    }
  }

  // Send an already-formatted HTML message (e.g. a deploy summary). No-op when the
  // notifier isn't configured. Never throws.
  function send(text) {
    if (!configured || !text) return Promise.resolve();
    return sendMessage(text).catch((err) => console.error('[telegram]', err.message || err));
  }

  return { notify, send, configured, _test: { sendMessage, formatMessage, escapeHtml, estimateStripeNet } };
}

// --- Private-group access gate ---------------------------------------------
// A thin Bot-API client for the access feature (see lib/telegram-access.js).
// Distinct from the notifier above: the notifier only *sends alerts* to one
// channel; the gate *manages group membership* — minting single-use invites and
// removing members. Kept in this file so there's a single Telegram client.
//
// fetchImpl is injectable for tests; defaults to the global fetch. `groupChatId`
// is the PRIVATE group's chat id (e.g. -100…), not the alerts channel.
export function createTelegramGroupGate({ botToken, groupChatId, fetchImpl, inviteTtlMs = 10 * 60_000 } = {}) {
  const configured = !!(botToken && groupChatId);
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);

  /**
   * Generic Bot-API call. Returns { ok, result } on success, { ok:false, … } on
   * any HTTP/JSON/API error. Never throws — callers degrade gracefully.
   */
  async function apiCall(method, params) {
    if (!doFetch || !botToken) return { ok: false, error: 'not_configured' };
    try {
      const res = await doFetch(`${API}${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok !== true) {
        return { ok: false, status: res.status, result: json };
      }
      return { ok: true, result: json.result };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  /** DM a user directly (their Telegram user id == the private-chat id). */
  function sendDirectMessage(userId, text) {
    return apiCall('sendMessage', { chat_id: userId, text, parse_mode: 'HTML' });
  }

  /**
   * Mint a single-use, self-expiring invite link to the private group. Even if it
   * leaks it can admit at most one person, briefly. Returns the link or null.
   */
  async function createSingleUseInvite(now = Date.now()) {
    const r = await apiCall('createChatInviteLink', {
      chat_id: groupChatId,
      member_limit: 1,
      expire_date: Math.floor((now + inviteTtlMs) / 1000),
    });
    return r.ok && r.result ? r.result.invite_link : null;
  }

  /**
   * Remove a member from the group. Ban-then-unban (rather than a bare ban) so the
   * removal isn't permanent — a user who pays again can be re-invited. Returns
   * { ok } reflecting whether the removal call succeeded.
   */
  async function kickMember(userId) {
    const ban = await apiCall('banChatMember', { chat_id: groupChatId, user_id: userId });
    await apiCall('unbanChatMember', { chat_id: groupChatId, user_id: userId, only_if_banned: true });
    return { ok: ban.ok };
  }

  return { apiCall, sendDirectMessage, createSingleUseInvite, kickMember, configured };
}
