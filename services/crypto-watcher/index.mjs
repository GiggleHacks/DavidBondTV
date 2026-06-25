// Watches David's static receiving addresses for the exact amounts the main app
// registers, then fires a signed callback. The ONLY component with chain access.
import http from 'node:http';
import { makeLtcAdapter, makeEthAdapter } from './lib/adapters.mjs';
import { matchReceived } from './lib/matcher.mjs';
import { sendCallback } from './lib/callback.mjs';

const PORT = Number(process.env.PORT || 8745);
const TOKEN = process.env.CRYPTO_WATCHER_TOKEN;
const CALLBACK_SECRET = process.env.CRYPTO_WEBHOOK_SECRET;
const POLL_MS = Number(process.env.POLL_MS || 20_000);

if (!TOKEN || !CALLBACK_SECRET) {
  console.error('[watcher] FATAL: CRYPTO_WATCHER_TOKEN and CRYPTO_WEBHOOK_SECRET must both be set');
  process.exit(1);
}

const adapters = {};
if (process.env.LTC_RPC_URL) adapters.LTC = makeLtcAdapter({ rpcUrl: process.env.LTC_RPC_URL, rpcUser: process.env.LTC_RPC_USER, rpcPass: process.env.LTC_RPC_PASS });
if (process.env.ETH_RPC_URL) adapters.ETH = makeEthAdapter({ rpcUrl: process.env.ETH_RPC_URL });

const COIN_DISPLAY_DECIMALS = { ETH: 6, LTC: 8, XMR: 12 };

function toBaseUnits(decimalStr, decimals) {
  const [w, f = ''] = String(decimalStr).split('.');
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals));
}

// In-memory watch list (orders are short-lived; main app is the source of truth).
const watches = new Map(); // orderId → { coin, address, expectedAmount, expectedBaseUnits, baselineBaseUnits, confirmations, expiresAt, callbackUrl }
let polling = false;

async function coinGeckoRate(coin) {
  const id = { ETH: 'ethereum', LTC: 'litecoin', XMR: 'monero' }[coin];
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
  const j = await r.json();
  return j && j[id] ? j[id].usd : null;
}

function authed(req) {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function readJson(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    if (!authed(req)) { res.writeHead(401); return res.end('unauthorized'); }

    if (req.method === 'GET' && url.pathname === '/quote') {
      const coinParam = url.searchParams.get('coin');
      const coin = coinParam ? coinParam.toUpperCase() : '';
      const usd = Number(url.searchParams.get('usd'));
      if (!COIN_DISPLAY_DECIMALS[coin] || !(usd > 0)) { res.writeHead(400); return res.end('bad quote params'); }
      const rate = await coinGeckoRate(coin);
      if (!(rate > 0)) { res.writeHead(502); return res.end('rate unavailable'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ coin, usd, rate, amount: (usd / rate).toFixed(COIN_DISPLAY_DECIMALS[coin]), ts: Date.now() }));
    }

    if (req.method === 'POST' && url.pathname === '/watch') {
      const w = await readJson(req);
      const adapter = adapters[w.coin];
      if (!adapter) { res.writeHead(400); return res.end('coin not supported'); }
      // Baseline = funds already at the address now; we only credit NEW arrivals.
      const baseline = await adapter.getReceived(w.address, w.confirmations);
      watches.set(w.orderId, {
        coin: w.coin, address: w.address, expectedAmount: w.expectedAmount,
        expectedBaseUnits: toBaseUnits(w.expectedAmount, adapter.decimals),
        baselineBaseUnits: baseline, confirmations: w.confirmations,
        expiresAt: w.expiresAt, callbackUrl: w.callbackUrl,
      });
      console.log(`[watcher] watching ${w.orderId} ${w.coin} ${w.expectedAmount}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(`[watcher] ${e.message}`); res.writeHead(500); res.end('error'); }
});

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const now = Date.now();
    for (const [orderId, w] of [...watches]) {
      if (now > w.expiresAt) { watches.delete(orderId); continue; }
      try {
        const received = await adapters[w.coin].getReceived(w.address, w.confirmations);
        const r = matchReceived(w, received);
        if (r.matched) {
          const ok = await sendCallback(w.callbackUrl, { orderId, coin: w.coin, txid: null, amount: w.expectedAmount, confirmations: w.confirmations }, CALLBACK_SECRET);
          if (ok) { watches.delete(orderId); console.log(`[watcher] paid ${orderId}`); }
        } else if (r.status === 'underpaid' && !w.alerted) {
          // A short deposit arrived. Alert the main app ONCE; keep watching in case
          // the buyer tops up to the full amount (which would then confirm).
          console.warn(`[watcher] UNDERPAID ${orderId} ${w.coin} expected ${w.expectedAmount}`);
          const ok = await sendCallback(w.callbackUrl, { orderId, coin: w.coin, outcome: 'underpaid', amount: w.expectedAmount, confirmations: w.confirmations }, CALLBACK_SECRET);
          if (ok) w.alerted = true;
        }
      } catch (e) { console.error(`[watcher] poll ${orderId}: ${e.message}`); }
    }
  } finally {
    polling = false;
  }
}

setInterval(pollOnce, POLL_MS);
server.listen(PORT, () => console.log(`[watcher] listening on ${PORT}, coins: ${Object.keys(adapters).join(', ')}`));
