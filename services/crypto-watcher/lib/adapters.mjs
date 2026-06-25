// Per-coin "how much has this address received at >= minconf confirmations".
// LTC: litecoind watch-only wallet (importaddress once), getreceivedbyaddress.
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

export function makeEthAdapter({ rpcUrl }) {
  const decimals = 18; // wei; matcher works in wei, main app quotes to 6 display decimals
  return {
    decimals,
    async _blockNumber() { return BigInt(await rpc(rpcUrl, 'eth_blockNumber', [])); },
    async getReceived(address, minconf) {
      const latest = await this._blockNumber();
      const at = latest > BigInt(minconf) ? latest - BigInt(minconf) : 0n;
      const hex = '0x' + at.toString(16);
      const balWei = BigInt(await rpc(rpcUrl, 'eth_getBalance', [address, hex]));
      return balWei; // base units = wei
    },
  };
}
