// Per-coin "how much has this address received at >= minconf confirmations".
// LTC: either a litecoind watch-only wallet (makeLtcAdapter) OR a public Esplora
//   explorer with no local node (makeLtcEsploraAdapter, the default — zero download).
// ETH: public JSON-RPC, balance-delta (works with unique-amount matching). For ETH,
// "confirmations" is enforced by reading balance at (latest - confirmations) blocks.

const E = (n) => 10n ** BigInt(n);

async function rpc(url, method, params, auth = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

export function makeLtcAdapter({ rpcUrl, rpcUser, rpcPass }) {
  const decimals = 8;
  const imported = new Set();
  return {
    decimals,
    async ensureWatch(address) {
      if (imported.has(address)) return;
      // rescan=false: we only care about funds arriving AFTER import (our baseline).
      try { await rpc(rpcUrl, 'importaddress', [address, 'dbtv', false], `${rpcUser}:${rpcPass}`); } catch { /* already imported */ }
      imported.add(address);
    },
    async getReceived(address, minconf) {
      await this.ensureWatch(address);
      const ltc = await rpc(rpcUrl, 'getreceivedbyaddress', [address, minconf], `${rpcUser}:${rpcPass}`); // returns a number in LTC
      // Convert the decimal LTC number to base units without float drift.
      const [w, f = ''] = String(ltc).split('.');
      return BigInt(w) * E(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals));
    },
  };
}

// Litecoin via a public Esplora-style explorer (e.g. litecoinspace.org) — no local
// node, no blockchain download. Reads confirmed outputs to the address and sums the
// ones with >= minconf confirmations, returning litoshi (base units, 8 decimals).
// Trust model: the explorer can only READ the chain; funds go straight to the owner's
// wallet. fetchImpl is injectable for tests.
export function makeLtcEsploraAdapter({ baseUrl = 'https://litecoinspace.org/api', fetchImpl = fetch } = {}) {
  const decimals = 8;
  async function getJson(path) {
    const r = await fetchImpl(`${baseUrl}${path}`);
    if (!r.ok) throw new Error(`LTC API ${path}: ${r.status}`);
    return r.json();
  }
  return {
    decimals,
    async getReceived(address, minconf) {
      const tip = Number(await getJson('/blocks/tip/height'));
      // Esplora returns the address's recent txs (mempool first, then newest confirmed).
      // For our low-volume, fresh receive addresses this single page covers all
      // relevant deposits. Sum outputs paying THIS address on txs with >= minconf.
      const txs = await getJson(`/address/${address}/txs`);
      let total = 0n;
      for (const tx of (Array.isArray(txs) ? txs : [])) {
        const confirmed = tx.status && tx.status.confirmed;
        const conf = confirmed ? (tip - tx.status.block_height + 1) : 0;
        if (conf < minconf) continue;
        for (const vout of (tx.vout || [])) {
          if (vout.scriptpubkey_address === address) total += BigInt(vout.value);
        }
      }
      return total; // litoshi
    },
  };
}

export function makeEthAdapter({ rpcUrl, fetchImpl = fetch }) {
  const decimals = 18; // wei
  async function call(method, params) {
    const r = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }
  return {
    decimals,
    async getLatestBlock() { return Number(BigInt(await call('eth_blockNumber', []))); },
    // tag: a block number (we hex-encode) or a string tag like 'pending'/'latest'
    async getBlock(tag, withTxs = true) {
      const t = typeof tag === 'number' ? '0x' + tag.toString(16) : tag;
      return call('eth_getBlockByNumber', [t, withTxs]);
    },
  };
}

// Find the first incoming transaction in `block` paying `address`. Returns
// { txid, valueWei, enough } or null. Works for self-sends (only the recipient
// + value matter, never the sender), unlike balance-delta detection.
export function findIncomingTx(block, address, minValueWei) {
  if (!block || !Array.isArray(block.transactions)) return null;
  const addr = String(address).toLowerCase();
  for (const tx of block.transactions) {
    if (tx && tx.to && String(tx.to).toLowerCase() === addr) {
      const v = BigInt(tx.value || '0x0');
      if (v > 0n) return { txid: tx.hash, valueWei: v, enough: v >= minValueWei };
    }
  }
  return null;
}
