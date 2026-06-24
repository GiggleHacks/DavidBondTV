# Production-Authoritative, Additive Config Sync

**Date:** 2026-06-24
**Status:** Approved (design)

## Problem

The live site will soon serve real customers, and the owner sometimes edits
configuration **directly on production** (e.g. creates a coupon code in the live
admin panel). Today, publishing from local can silently destroy that work.

Concretely: "Publish to server" runs a config sync as one of its phases
([lib/sync-client.mjs](../../../lib/sync-client.mjs) `pushConfig` →
`/api/sync/config`). That endpoint calls `coupons.importAll` /
`categories.importAll`, both of which **replace the entire prod set** with the
local set:

- `coupons.importAll` → `writeCoupons(next)` rebuilds the list from local only.
  A coupon created on prod that doesn't exist locally is **deleted**. Redemption
  counts / Stripe links are preserved *only* for codes present in both.
- `categories.importAll` → `write(next)` does the same by slug. Prod-only
  categories are **wiped**.

Everything else is already safe:

- **Deploy** ([scripts/deploy.sh](../../../scripts/deploy.sh)) ships code only;
  `data/`, `media/`, `content/` are excluded; it backs up prod and aborts if the
  video count drops.
- **Pricing, products, users, settings, geo-rules** are never synced — already
  100% prod-authoritative.
- **Video artifacts + manifest** merge per-video and never delete prod videos.

So the only destructive path is the config merge.

## Principle

**The live site is the source of truth for all configuration and
customer-facing data.** A deploy or publish from local may *add* entries prod
doesn't have yet, but may **never modify or delete** an entry that already
exists on prod. After any config sync, the entry count can only grow or stay
equal — never shrink.

**Conflict rule (owner decision): production always wins.** When a coupon code
or category slug exists in both places with different values, prod's version is
kept untouched. Local can only contribute brand-new entries. Consequence: to
change an existing category's emoji/name or an existing coupon's terms on the
live site, the owner edits it **on prod directly** — local can no longer
override an existing prod entry.

## Changes

### 1. `coupons.importAll` → additive merge ([lib/coupons.js](../../../lib/coupons.js))

Rename intent from "replace" to "merge-add". Algorithm:

1. Read prod's existing coupons; key them by normalized `code`.
2. Start `next` = all existing prod coupons, **unchanged**.
3. For each incoming local coupon: normalize + validate. If its code is **new to
   prod**, append it (fresh `timesRedeemed: 0`, no Stripe link). If the code
   **already exists on prod**, skip it entirely — prod's version wins.
4. Write `next`. Return `{ ok, added, kept, total }`.

Net effect: prod-only coupons survive; existing prod coupons (including
redemption count + Stripe linkage + any prod edits) are never touched; new
locally-authored coupons are added.

### 2. `categories.importAll` → additive merge ([lib/categories.js](../../../lib/categories.js))

Same rule keyed by `slug`:

1. Read prod's existing categories; key by `slug`.
2. Start `next` = all existing prod categories, unchanged.
3. For each incoming local category (hydrated/validated): if slug is new to
   prod, append it; if it already exists, keep prod's. 
4. Write `next`. Return `{ ok, added, kept, total }`.

New-to-prod categories still flow up so published videos show their styling;
existing prod categories keep their prod-authored name/emoji/icon.

### 3. Receiving-end invariant + backup ([server.mjs](../../../server.mjs) `/api/sync/config`)

Before applying either merge:

- Snapshot the current `coupons.json` and the categories store to a timestamped
  backup file (e.g. alongside the data files) so a future bug can't silently
  wipe config.
- After the merge, assert the new count is `>=` the prior count. If a merge
  would reduce the count, **reject** (do not write) and return an error. Since
  the merges are additive this can't happen normally — it's a guardrail against
  regressions.

Report a structured result: `{ categories: {added, kept, total}, coupons:
{added, kept, total} }`.

### 4. Observability in the publish UI ([public/js/publish.js](../../../public/js/publish.js))

The config phase reports the real outcome, e.g.:

> Config: +2 categories, +1 coupon added · 0 changed · 0 removed (prod preserved)

So the owner can always confirm nothing on prod was modified or deleted.

## Out of scope (intentionally unchanged)

- Deploy script — already code-only and guarded.
- Pricing / products / users / settings / geo-rules — remain unsynced and
  prod-authoritative.
- Video manifest + artifact sync — already additive per-video.
- No new "push config" toggle; config sync stays automatic on publish because it
  is now non-destructive.

## Testing

New/updated tests in [tests/coupons.test.js](../../../tests/coupons.test.js) and
[tests/categories.test.js](../../../tests/categories.test.js):

1. A prod-only coupon **survives** a merge whose payload doesn't include it.
2. An existing prod coupon's fields **and** `timesRedeemed` are untouched when
   local sends a different version of the same code.
3. A brand-new local coupon **is added**.
4. The count-shrink guard rejects a payload that would reduce the total.
5. Same four for categories (keyed by slug; styling preserved on conflict).

## Verification

- `npm test` green.
- Manual: create a coupon on a simulated "prod" store, run an import that omits
  it + includes a new one → prod coupon present, new one added, count grew.
