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

// Plain USD (dollars, not cents) — used for the fiat value of a crypto sale.
function fmtUsd(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '';
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
  // Crypto membership sale. Distinct from new_subscription (which is Stripe-shaped:
  // USD cents + processor-fee math). A direct-to-wallet crypto payment has no
  // processor fee, and its amount is a COIN value (e.g. "0.0834 ETH"), so it gets
  // its own template carrying the coin amount + the locked USD value.
  crypto_membership(d) {
    const usd = fmtUsd(d.usd);
    return [
      `🪙🎉 <b>NEW CRYPTO SALE!</b> 🎉🪙`,
      ``,
      `👤 ${escapeHtml(d.username)}`,
      `📧 ${escapeHtml(d.email || '—')}`,
      `🪪 ${escapeHtml(String(d.interval || '—'))} membership`,
      `💰 Paid: <b>${escapeHtml(String(d.coinAmount))} ${escapeHtml(String(d.coin))}</b>${usd ? ` (≈ ${usd})` : ''}`,
      `✅ Sent straight to your wallet (no processor cut)`,
    ].join('\n');
  },
  crypto_course(d) {
    const usd = fmtUsd(d.usd);
    return `🪙🛒 <b>Crypto course sale!</b> ${escapeHtml(d.username)} bought `
      + `${escapeHtml(d.product || 'a course')}: `
      + `<b>${escapeHtml(String(d.coinAmount))} ${escapeHtml(String(d.coin))}</b>${usd ? ` (≈ ${usd})` : ''}`;
  },
  crypto_underpaid(d) {
    return `⚠️ <b>Underpaid crypto order</b>\n`
      + `🧾 Order: ${escapeHtml(String(d.orderId))}\n`
      + `🪙 Expected: <b>${escapeHtml(String(d.amount))} ${escapeHtml(String(d.coin))}</b> (${escapeHtml(String(d.kind || 'order'))})\n`
      + `The deposit was short of the quoted amount — check the wallet and handle/refund manually.`;
  },
  // WHOP card sale (the rail that replaced suspended Stripe). Amount is USD cents,
  // like new_subscription, but WHOP — not Stripe — takes the processor cut, so no
  // Stripe-fee math here; WHOP's payout already nets its fee. The charged line is
  // only shown when the amount is known (it rides the payment event, not the
  // membership one), so the alert never reads "Charged: —".
  whop_membership(d) {
    const lines = [
      `💳🎉 <b>NEW MEMBER via WHOP!</b> 🎉💳`,
      ``,
      `👤 ${escapeHtml(d.username)}`,
      `📧 ${escapeHtml(d.email || '—')}`,
      `🪪 ${escapeHtml(String(d.interval || 'month'))} membership`,
    ];
    if (typeof d.amount === 'number') lines.push(`💳 Charged: <b>${fmtAmount(d.amount, d.currency)}</b>`);
    lines.push(`✅ Access unlocked automatically`);
    return lines.join('\n');
  },
  // A payment that moved money but did NOT unlock access — the one class of
  // failure that must never be silent. Fires for: a WHOP grant we can't map to an
  // account, a degraded checkout that lost its metadata, a crypto order stuck
  // after the watcher gave up, and an underpaid crypto order. Every case needs the
  // same human action, so one template serves them all.
  payment_needs_attention(d) {
    const lines = [
      `⚠️💰 <b>PAYMENT NEEDS ATTENTION</b> 💰⚠️`,
      ``,
      `❗ ${escapeHtml(String(d.reason || 'unknown'))}`,
    ];
    if (d.username || d.email) lines.push(`👤 ${escapeHtml(d.username || '—')} · ${escapeHtml(d.email || '—')}`);
    if (d.product) lines.push(`📦 ${escapeHtml(String(d.product))}`);
    if (d.reference) lines.push(`🔖 <code>${escapeHtml(String(d.reference))}</code>`);
    if (typeof d.amount === 'number') lines.push(`💳 ${fmtAmount(d.amount, d.currency)}`);
    else if (d.amount) lines.push(`💳 ${escapeHtml(String(d.amount))}${d.currency ? ` ${escapeHtml(String(d.currency))}` : ''}`);
    if (d.detail) lines.push(`ℹ️ ${escapeHtml(String(d.detail))}`);
    lines.push(``, `🛠 Grant access manually in the Users admin.`);
    return lines.join('\n');
  },
  // Every new on-site comment (member or anonymous), pinged to the owner with
  // who/where/what + a clickable link to the page it landed on. Shadow-filtered
  // and geo-blocked comments still notify, flagged as hidden, so the owner sees
  // what was caught.
  comment(d) {
    const lines = [
      `💬 <b>New ${d.parentId ? 'reply' : 'comment'}</b>`,
      `👤 ${escapeHtml(d.username || 'Anonymous')}${d.tag ? ` <i>(${escapeHtml(d.tag)})</i>` : ''}`,
      `🌍 ${escapeHtml(d.country || 'Unknown')}${d.cc ? ` (${escapeHtml(d.cc)})` : ''} · <code>${escapeHtml(d.ip || '—')}</code>`,
      `📝 ${escapeHtml(String(d.text || '').slice(0, 600))}`,
    ];
    if (d.hidden) lines.push(`🚫 <b>Hidden from public</b> — ${escapeHtml(d.hiddenReason || 'filtered')}`);
    if (d.url) lines.push(`🔗 <a href="${escapeHtml(d.url)}">View page</a>`);
    return lines.join('\n');
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
