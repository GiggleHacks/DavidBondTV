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
| `LTC_RPC_URL` | no | — | litecoind JSON-RPC URL, e.g. `http://litecoind:9332`. LTC watching is disabled if unset |
| `LTC_RPC_USER` | no | — | litecoind RPC username |
| `LTC_RPC_PASS` | no | — | litecoind RPC password |
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
  -e LTC_RPC_URL=http://litecoind:9332 -e LTC_RPC_USER=<u> -e LTC_RPC_PASS=<p> \
  -p 8745:8745 dbtv-crypto-watcher
```

---

## Litecoind Setup

Run a litecoind container with RPC enabled and a wallet loaded. The watcher calls `importaddress` (rescan=false) automatically for each receiving address, then reads `getreceivedbyaddress` to detect confirmed deposits.

`txindex` is **not** required.

Example litecoind flags:
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

Then fill `data/crypto-config.json` with real ETH and LTC receiving addresses:

```json
{
  "eth": { "address": "0x..." },
  "ltc": { "address": "ltc1..." }
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
