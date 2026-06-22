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

const templates = {
  new_subscription(d) {
    return `🎉 <b>New member!</b> ${escapeHtml(d.username)} — ${escapeHtml(d.interval || '?')}`;
  },
  renewal(d) {
    return `💰 <b>Renewal</b> ${escapeHtml(d.username)} — ${fmtAmount(d.amount, d.currency)}`;
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

  return { notify, configured, _test: { sendMessage, formatMessage, escapeHtml } };
}
