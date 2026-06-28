// Watches David's static receiving addresses for the exact amounts the main app
// registers, then fires a signed callback. The ONLY component with chain access.
import http from 'node:http';
import { makeLtcAdapter, makeLtcEsploraAdapter, makeEthAdapter, findIncomingTx } from './lib/adapters.mjs';
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
// LTC: a litecoind node if LTC_RPC_URL is set, otherwise the public Esplora explorer
// (default — no node, no download). Disable entirely with LTC_DISABLED=1.
if (!process.env.LTC_DISABLED) {
  adapters.LTC = process.env.LTC_RPC_URL
    ? makeLtcAdapter({ rpcUrl: process.env.LTC_RPC_URL, rpcUser: process.env.LTC_RPC_USER, rpcPass: process.env.LTC_RPC_PASS })
    : makeLtcEsploraAdapter({ baseUrl: process.env.LTC_API_URL || 'https://litecoinspace.org/api' });
}
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
      let watch;
      if (w.coin === 'ETH') {
        const sinceBlock = await adapter.getLatestBlock();
        watch = {
          coin: 'ETH', address: w.address, expectedAmount: w.expectedAmount,
          expectedWei: toBaseUnits(w.expectedAmount, adapter.decimals),
          requiredConfs: w.confirmations || 1, sinceBlock, lastScanned: sinceBlock,
          hitBlock: null, hitTxid: null, detectedSent: false, alerted: false,
          expiresAt: w.expiresAt, callbackUrl: w.callbackUrl,
        };
      } else {
        const baseline = await adapter.getReceived(w.address, w.confirmations);
        watch = {
          coin: w.coin, address: w.address, expectedAmount: w.expectedAmount,
          expectedBaseUnits: toBaseUnits(w.expectedAmount, adapter.decimals),
          baselineBaseUnits: baseline, confirmations: w.confirmations,
          expiresAt: w.expiresAt, callbackUrl: w.callbackUrl,
        };
      }
      watches.set(w.orderId, watch);
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
    // Fetch the ETH chain tip once per tick if we have any ETH watches.
    let ethLatest = null;
    const hasEth = [...watches.values()].some((w) => w.coin === 'ETH');
    if (hasEth && adapters.ETH) { try { ethLatest = await adapters.ETH.getLatestBlock(); } catch (e) { console.error(`[watcher] eth tip: ${e.message}`); } }

    for (const [orderId, w] of [...watches]) {
      if (now > w.expiresAt) { watches.delete(orderId); continue; }
      try {
        if (w.coin === 'ETH') {
          if (ethLatest === null) continue;
          // 1) Find the incoming tx (scan only new blocks since last tick).
          if (w.hitBlock === null) {
            for (let n = w.lastScanned + 1; n <= ethLatest; n += 1) {
              const blk = await adapters.ETH.getBlock(n, true);
              const hit = findIncomingTx(blk, w.address, w.expectedWei);
              if (hit && hit.enough) { w.hitBlock = n; w.hitTxid = hit.txid; break; }
              if (hit && !hit.enough && !w.alerted) {
                const ok = await sendCallback(w.callbackUrl, { orderId, coin: 'ETH', outcome: 'underpaid', amount: w.expectedAmount }, CALLBACK_SECRET);
                if (ok) w.alerted = true;
              }
            }
            w.lastScanned = ethLatest;
            // 2) Best-effort mempool detection for instant "detected" feedback.
            if (w.hitBlock === null && !w.detectedSent) {
              try {
                const pend = await adapters.ETH.getBlock('pending', true);
                const ph = findIncomingTx(pend, w.address, w.expectedWei);
                if (ph && ph.enough) {
                  const ok = await sendCallback(w.callbackUrl, { orderId, coin: 'ETH', outcome: 'detected', txid: ph.txid, amount: w.expectedAmount, confirmations: 0 }, CALLBACK_SECRET);
                  if (ok) w.detectedSent = true;
                }
              } catch { /* node may not expose pending txs; detection falls to 1st block */ }
            }
          }
          // 3) Confirm flow once the tx is mined.
          if (w.hitBlock !== null) {
            const confs = ethLatest - w.hitBlock + 1;
            if (!w.detectedSent) {
              const ok = await sendCallback(w.callbackUrl, { orderId, coin: 'ETH', outcome: 'detected', txid: w.hitTxid, amount: w.expectedAmount, confirmations: confs }, CALLBACK_SECRET);
              if (ok) w.detectedSent = true;
            }
            if (confs >= w.requiredConfs) {
              const ok = await sendCallback(w.callbackUrl, { orderId, coin: 'ETH', txid: w.hitTxid, amount: w.expectedAmount, confirmations: confs }, CALLBACK_SECRET);
              if (ok) { watches.delete(orderId); console.log(`[watcher] paid ${orderId} (eth, ${confs} conf)`); }
            }
          }
        } else {
          // Non-ETH (e.g. LTC via Esplora): balance-received + matcher.
          const received = await adapters[w.coin].getReceived(w.address, w.confirmations);
          const r = matchReceived(w, received);
          if (r.matched) {
            const ok = await sendCallback(w.callbackUrl, { orderId, coin: w.coin, txid: null, amount: w.expectedAmount, confirmations: w.confirmations }, CALLBACK_SECRET);
            if (ok) { watches.delete(orderId); console.log(`[watcher] paid ${orderId}`); }
          } else if (r.status === 'underpaid' && !w.alerted) {
            const ok = await sendCallback(w.callbackUrl, { orderId, coin: w.coin, outcome: 'underpaid', amount: w.expectedAmount }, CALLBACK_SECRET);
            if (ok) w.alerted = true;
          }
        }
      } catch (e) { console.error(`[watcher] poll ${orderId}: ${e.message}`); }
    }
  } finally {
    polling = false;
  }
}

setInterval(pollOnce, POLL_MS);
// Bind host: set WATCHER_HOST=127.0.0.1 when the main app runs on the same box and
// reaches the watcher over localhost (no public exposure needed). Defaults to all
// interfaces for back-compat (e.g. behind a container port-map / tunnel).
const HOST = process.env.WATCHER_HOST || '0.0.0.0';
server.listen(PORT, HOST, () => console.log(`[watcher] listening on ${HOST}:${PORT}, coins: ${Object.keys(adapters).join(', ')}`));
