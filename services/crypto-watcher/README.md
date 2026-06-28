# dbtv-crypto-watcher

## Overview

This service is the **only** component with blockchain/wallet access. The main davidbondtv.com app registers "watches" (order id + coin + address + exact expected amount) and this service polls each chain; when the matching deposit confirms, it POSTs an HMAC-signed callback to the main app's `/api/pay/crypto/webhook`.

It holds **no private keys** — only public receiving addresses (and, in Phase 2, a Monero view key). Phase 1 supports **ETH + LTC**.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CRYPTO_WATCHER_TOKEN` | yes | — | Bearer token the main app uses to call `/quote` and `/watch`. Must match the main app's `CRYPTO_WATCHER_TOKEN`. Generate: `openssl rand -hex 32` |
| `CRYPTO_WEBHOOK_SECRET` | yes | — | HMAC secret used to sign callbacks. Must match the main app's `CRYPTO_WEBHOOK_SECRET`. Generate: `openssl rand -hex 32` |
| `PORT` | no | `8745` | Port the service listens on |
| `POLL_MS` | no | `20000` | How often (ms) to poll the chains |
| `ETH_RPC_URL` | no | — | A read-only Ethereum JSON-RPC endpoint, e.g. `https://ethereum-rpc.publicnode.com`. ETH watching is disabled if unset |
| `LTC_API_URL` | no | `https://litecoinspace.org/api` | Public Esplora explorer base URL. **LTC watching is ON by default via this public API — no node, no download.** Override only to use a self-hosted Esplora/mempool instance |
| `LTC_RPC_URL` | no | — | **Optional alternative to the public API:** a litecoind JSON-RPC URL (e.g. `http://litecoind:9332`). If set, the watcher uses the node instead of the public explorer |
| `LTC_RPC_USER` / `LTC_RPC_PASS` | no | — | litecoind RPC credentials (only when using `LTC_RPC_URL`) |
| `LTC_DISABLED` | no | — | Set to `1` to turn off LTC watching entirely |
| `XMR_WALLET_RPC_URL` | no | — | **(Phase 2)** monero-wallet-rpc URL (view-only wallet) |

---

## Build & Run on Unraid (cccbox)

Copy the service directory to `/mnt/user/appdata/dbtv-crypto-watcher`, then:

```bash
docker build -t dbtv-crypto-watcher /mnt/user/appdata/dbtv-crypto-watcher
docker run -d --name dbtv-crypto-watcher --restart unless-stopped \
  -e CRYPTO_WATCHER_TOKEN=<same as main app> \
  -e CRYPTO_WEBHOOK_SECRET=<same as main app> \
  -e ETH_RPC_URL=https://ethereum-rpc.publicnode.com \
  -p 8745:8745 dbtv-crypto-watcher
```

LTC is enabled automatically via the public explorer (`https://litecoinspace.org/api`) — no extra env needed. To use a self-hosted litecoind node instead, add `-e LTC_RPC_URL=http://litecoind:9332 -e LTC_RPC_USER=<u> -e LTC_RPC_PASS=<p>` (see below).

---

## Litecoin: public explorer (default) vs. self-hosted node

**Default (recommended): public Esplora explorer.** With no LTC env vars set, the watcher
reads the Litecoin chain via `https://litecoinspace.org/api` — no node, no ~150 GB download.
It only *reads* the chain (sums confirmed outputs to the receiving address); funds always go
straight to the owner's wallet. Same trust model as the public ETH RPC. Override the endpoint
with `LTC_API_URL` (e.g. a self-hosted mempool/Esplora instance) if desired.

**Optional: self-hosted litecoind.** Set `LTC_RPC_URL` (+ `LTC_RPC_USER`/`LTC_RPC_PASS`) to
use a node instead — zero external data dependency, but the node downloads/syncs the full
chain. The watcher calls `importaddress` (rescan=false) per address, then reads
`getreceivedbyaddress`. `txindex` is not required. Example flags:
```
-server -rpcuser=<u> -rpcpassword=<p> -rpcallowip=0.0.0.0/0 -rpcbind=0.0.0.0
```

---

## Cloudflare Tunnel (existing tunnel on cccbox)

Add an ingress rule to the existing `CloudflaredTunnel` config mapping:

```
crypto.davidbondtv.com → http://dbtv-crypto-watcher:8745
```

or if referencing by IP:

```
crypto.davidbondtv.com → http://<unraid-ip>:8745
```

No inbound ports need to be opened on the router. The tunnel handles all inbound traffic securely.

Then set the main app's environment variable:

```
CRYPTO_WATCHER_URL=https://crypto.davidbondtv.com
```

---

## Main App (VPS) Side

Set the following in the systemd environment (e.g. `/etc/systemd/system/dbtv.service` or the `.env` equivalent):

```
CRYPTO_WEBHOOK_SECRET=<shared secret>
CRYPTO_WATCHER_URL=https://crypto.davidbondtv.com
CRYPTO_WATCHER_TOKEN=<shared token>
```

Then fill `data/crypto-config.json` with real ETH and LTC receiving addresses (this is the
actual schema the main app loads — see `lib/crypto-config.js`):

```json
{
  "coins": {
    "ETH": { "address": "0x...", "confirmations": 6, "decimals": 6 },
    "LTC": { "address": "ltc1...", "confirmations": 6, "decimals": 8 },
    "XMR": { "address": "", "enabled": false }
  },
  "membership": { "termMonths": 3, "priceUsd": 47 },
  "productDiscountPercent": 10,
  "orderTtlMs": 1200000
}
```

---

## Health Check

```
GET /health
```

Returns `ok` with no authentication required. Use this for uptime monitors or Unraid container health checks.

`/quote` and `/watch` both require the bearer token (`Authorization: Bearer <CRYPTO_WATCHER_TOKEN>`).

---

## Security Notes

- The watcher only needs **public addresses** to watch (ETH/LTC). Funds go straight to the owner's wallet; this service can observe but never spend.
- Never expose `/quote` or `/watch` without the bearer token.
- Keep the container reachable **only** via the Cloudflare Tunnel — do not port-forward 8745 publicly on the router.
- The HMAC-signed callback (`CRYPTO_WEBHOOK_SECRET`) ensures the main app only processes confirmations originating from this watcher.
