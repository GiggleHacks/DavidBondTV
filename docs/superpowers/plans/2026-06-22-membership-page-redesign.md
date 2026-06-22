# Premium membership page redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the meme-branded two-path payment chooser on the membership offer page with a single, premium, value-first card (Concept A) that has one clear card-checkout CTA, honest crypto "coming soon" footnote, and tasteful "Level 2" color.

**Architecture:** Pure front-end change to two static assets — `public/membership.html` (markup + its inline `<style>` block) and `public/js/membership.js` (event wiring + price rendering). No backend, no Stripe config, no new dependencies. The dynamic price still comes live from `/api/pay/stripe/config`. The active-member view (`#member-view`) and the `?status=success`/`?status=cancel` flows are untouched.

**Tech Stack:** Vanilla ES modules, inline SVG icons, CSS using the existing `--surface` / `--border` / `--text-dim` / `--accent` theme variables and the brand gold `#f4a300`. Tests: vitest (`npm test`) as a regression guard; visual verification via the preview tools.

**Note on TDD:** These are presentational/browser-module changes with no DOM unit-test harness in this repo (`tests/membership.test.js` covers backend `lib/membership.js`, not this page). So each task ends with a concrete verification step (preview render / `npm test`), not a new unit test. Do not add a brittle DOM test harness for this — it is out of scope per the spec.

**Spec:** `docs/superpowers/specs/2026-06-22-membership-page-redesign-design.md`

---

## File structure

- **Modify** `public/membership.html` — replace the inline `<style>` block (remove `.pay-choice` / `.giga*` / `.normie*` / pixelate styles + `@keyframes`; add `.mb-ico` / `.mb-instant` / `.mb-trust` / `.mb-guarantee` / `.mb-crypto-note` + dual-glow). Replace the `#plans-view` markup. Remove the `#pixelate` SVG `<filter>` block.
- **Modify** `public/js/membership.js` — remove the `#pay-crypto` click handler; update `setPrices()` to write the discounted price into the new `#crypto-price` span instead of the removed `#crypto-was` / `#crypto-amount`.
- **Modify** `package.json` — bump `version` `1.13.0` → `1.13.1`.

---

## Task 1: Replace the inline `<style>` block in membership.html

**Files:**
- Modify: `public/membership.html:12-122` (the `<style>…</style>` block)

- [ ] **Step 1: Replace the entire `<style>` block**

Find the block that starts at line 12 (`  <style>`) and ends at the matching `  </style>` (currently line 122). Replace the whole block (including the `<style>`/`</style>` tags) with:

```html
  <style>
    .mb-wrap { width: min(560px, 100%); margin: 40px auto 80px; padding: 0 20px; }
    .sub-banner { border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; font-size: 14px; }
    .sub-banner.ok { background: rgba(16,185,129,.12); color: #34d399; }
    .sub-banner.warn { background: rgba(245,158,11,.12); color: #fbbf24; }

    /* Premium offer card — gold anchor accent, dual gold/violet glow (Level 2). */
    .mb-card {
      position: relative; overflow: hidden; text-align: center;
      background:
        radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, #f4a300 16%, var(--surface)), var(--surface) 62%);
      border: 1px solid color-mix(in srgb, #f4a300 28%, var(--border));
      border-radius: 20px; padding: 36px 30px 28px;
      box-shadow:
        0 26px 80px -24px rgba(244,163,0,.45),
        0 -16px 70px -28px rgba(124,92,255,.50),
        0 0 0 1px rgba(244,163,0,.05);
    }
    .mb-card::before {
      content: ''; position: absolute; left: 50%; top: -120px; width: 320px; height: 320px;
      transform: translateX(-50%); pointer-events: none;
      background: radial-gradient(closest-side, rgba(244,163,0,.30), transparent 70%); filter: blur(8px);
    }
    .mb-card > * { position: relative; }

    .mb-badge {
      display: inline-block; margin-bottom: 16px; padding: 6px 15px; border-radius: 999px;
      font-size: 11.5px; font-weight: 800; letter-spacing: .7px; text-transform: uppercase;
      color: #1a1205; background: linear-gradient(135deg, #ffe08a, #f4a300);
      box-shadow: 0 6px 18px rgba(244,163,0,.45);
    }
    .mb-title { font-size: 30px; line-height: 1.12; font-weight: 800; margin: 0 0 10px; letter-spacing: -.5px; }
    .mb-sub { color: var(--text-dim); font-size: 15px; line-height: 1.55; margin: 0 auto 24px; max-width: 400px; }

    .mb-benefits { list-style: none; margin: 0 auto 24px; padding: 0; text-align: left; max-width: 360px; display: grid; gap: 13px; }
    .mb-benefits li { display: flex; align-items: flex-start; gap: 12px; font-size: 14.5px; line-height: 1.4; }
    .mb-ico { flex: none; width: 22px; height: 22px; margin-top: 1px; display: inline-flex; align-items: center; justify-content: center; }
    .mb-ico svg { width: 21px; height: 21px; }

    .mb-price { display: flex; align-items: baseline; justify-content: center; gap: 6px; margin: 4px 0 16px; }
    .mb-amount {
      font-size: 50px; font-weight: 800; letter-spacing: -1.5px; line-height: 1;
      background: linear-gradient(135deg, #ffe08a, #f4a300); -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .mb-per { color: var(--text-dim); font-size: 16px; font-weight: 600; }

    .mb-cta { width: 100%; padding: 16px; font-size: 17px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
    .mb-cta svg { width: 17px; height: 17px; fill: currentColor; }
    /* Gold primary action — scoped to the pay button so the member-view manage button keeps the default accent. */
    #pay-card { background: linear-gradient(135deg, #ffd76a, #f4a300) !important; color: #1a1205 !important; border: none; }
    #pay-card:disabled { opacity: .55; }

    .mb-instant { color: var(--text-dim); font-size: 12.5px; margin: 10px 0 0; display: flex; align-items: center; justify-content: center; gap: 5px; }
    .mb-instant svg { width: 13px; height: 13px; fill: #f4a300; }

    .mb-trust {
      display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap;
      margin: 16px 0 14px; padding: 13px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
      color: var(--text-dim); font-size: 12.5px;
    }
    .mb-trust .brand { height: 22px; width: auto; }
    .mb-trust .visa { background: #fff; border-radius: 4px; padding: 2px 7px; display: inline-flex; align-items: center; }
    .mb-trust .visa svg { height: 13px; width: auto; }
    .mb-trust .secure { display: inline-flex; align-items: center; gap: 5px; }
    .mb-trust .secure svg { width: 13px; height: 13px; fill: currentColor; }

    .mb-guarantee { color: var(--text-dim); font-size: 12.5px; margin: 0 0 16px; display: flex; align-items: center; justify-content: center; gap: 6px; }
    .mb-guarantee svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; }

    .mb-crypto-note { font-size: 12px; line-height: 1.7; color: var(--text-dim); opacity: .9; margin: 0 0 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .mb-crypto-note .coin { font-weight: 700; white-space: nowrap; }
    .mb-crypto-note .dot { margin-right: 3px; }

    .mb-foot { text-align: center; margin-top: 16px; font-size: 14px; }
    .mb-foot a { color: var(--accent); text-decoration: none; }
    .mb-consent { margin: 14px auto 0; max-width: 420px; font-size: 11.5px; line-height: 1.55; color: var(--text-dim); }
    .mb-consent a { color: var(--accent); text-decoration: none; }

    @media (max-width: 480px) {
      .mb-title { font-size: 26px; }
      .mb-amount { font-size: 42px; }
    }
  </style>
```

- [ ] **Step 2: Verify the file still has exactly one `<style>` and one `</style>`**

Run: `grep -c "</style>" "public/membership.html"`
Expected: `1`

Also confirm the old class names are gone from the style block:

Run: `grep -nE "pay-choice|pay-opt|\.giga|normie|gigaBorder|gigaGlow|gigaPulse|gigaFloat" "public/membership.html"`
Expected: no output (exit code 1). (The `#plans-view` markup still references some old classes until Task 2 — that's fine; this grep is scoped to confirm the *style* names are removed, and markup is replaced next.)

---

## Task 2: Replace the `#plans-view` markup and remove the pixelate filter

**Files:**
- Modify: `public/membership.html` — the `#plans-view` block (currently lines ~155-224) and the `#pixelate` SVG `<filter>` block (currently lines ~132-141)

- [ ] **Step 1: Remove the pixelate SVG filter block**

Delete this block (currently lines 132-141, including the preceding comment line 132):

```html
  <!-- Slight pixelation filter for the "Normie Pay" card brand marks. -->
  <svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
    <filter id="pixelate" x="0" y="0">
      <feFlood x="1" y="1" height="1" width="1"/>
      <feComposite width="2" height="2"/>
      <feTile result="a"/>
      <feComposite in="SourceGraphic" in2="a" operator="in"/>
      <feMorphology operator="dilate" radius="1"/>
    </filter>
  </svg>
```

(Leave the `<div class="mb-wrap">` and everything else in place.)

- [ ] **Step 2: Replace the entire `#plans-view` block**

Replace the whole `<!-- Offer (non-members) --> … </div>` block — i.e. the `<div id="plans-view" class="mb-card" hidden> … </div>` element (currently lines 155-224) — with:

```html
    <!-- Offer (non-members) -->
    <div id="plans-view" class="mb-card" hidden>
      <span class="mb-badge">★ Premium membership</span>
      <h1 class="mb-title">Unlock every exclusive</h1>
      <p class="mb-sub">The full David Bond TV library — plus every new drop the moment it lands.</p>

      <ul class="mb-benefits">
        <li>
          <span class="mb-ico" style="color:#f4a300"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18M8 4v16M16 4v16"/></svg></span>
          Every exclusive video — the entire premium library
        </li>
        <li>
          <span class="mb-ico" style="color:#e2674a"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/></svg></span>
          New videos the moment they drop
        </li>
        <li>
          <span class="mb-ico" style="color:#2bbd8e"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg></span>
          Ad-free, uninterrupted streaming
        </li>
        <li>
          <span class="mb-ico" style="color:#4a90e2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="11" rx="1.5"/><path d="M2 19h12"/><rect x="17.5" y="9" width="4.5" height="11" rx="1"/></svg></span>
          Watch on any device, anywhere
        </li>
        <li>
          <span class="mb-ico" style="color:#229ED9"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg></span>
          Private David Bond TV Telegram channel
        </li>
      </ul>

      <div class="mb-price">
        <span class="mb-amount" id="price-amount">$1</span>
        <span class="mb-per" id="price-per">/ mo</span>
      </div>

      <button class="acc-btn mb-cta" id="pay-card" type="button">
        <svg viewBox="0 0 24 24"><path d="M12 1a5 5 0 00-5 5v3H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 8H9V6a3 3 0 016 0z"/></svg>
        Get instant access
      </button>

      <p class="mb-instant">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        Start watching the moment you pay
      </p>

      <div class="mb-trust">
        <span class="brand visa"><svg viewBox="0 0 40 14" role="img" aria-label="Visa"><text x="20" y="11.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-style="italic" font-size="13" fill="#1a1f71">VISA</text></svg></span>
        <svg class="brand" viewBox="0 0 48 30" role="img" aria-label="Mastercard"><circle cx="19" cy="15" r="11" fill="#EB001B"/><circle cx="30" cy="15" r="11" fill="#F79E1B" fill-opacity=".85"/></svg>
        <span class="secure"><svg viewBox="0 0 24 24"><path d="M12 1a5 5 0 00-5 5v3H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 8H9V6a3 3 0 016 0z"/></svg> Secured by Stripe</span>
      </div>

      <p class="mb-guarantee">
        <svg viewBox="0 0 24 24"><path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 9A8 8 0 006 5.3L4 7M4 15a8 8 0 0014 3.7L20 17"/></svg>
        Cancel anytime — keep access through the end of your billing period
      </p>

      <p class="mb-crypto-note">
        Prefer crypto?
        <span class="coin"><span class="dot" style="color:#627EEA">●</span>ETH</span> ·
        <span class="coin"><span class="dot" style="color:#FF6600">●</span>XMR</span> ·
        <span class="coin"><span class="dot" style="color:#7CA0E5">●</span>LTC</span> ·
        <span class="coin"><span class="dot" style="color:#0AC18E">●</span>BCH</span>
        coming soon — just <span id="crypto-price">$0.80</span>/mo (20% off) when it lands.
      </p>

      <p class="mb-consent">
        Your membership renews automatically at the price shown until you cancel — cancel
        anytime from your account. By subscribing you agree to our
        <a href="/terms">Terms</a>, <a href="/privacy">Privacy Policy</a>, and
        <a href="/refunds">Refunds &amp; Cancellation Policy</a>.
      </p>
    </div>
```

- [ ] **Step 3: Confirm all old payment-chooser markup and the filter are gone**

Run: `grep -nE "pay-choice|pay-opt|GigaChad|Normie|pay-crypto|crypto-was|crypto-amount|id=\"pixelate\"|url\(#pixelate\)" "public/membership.html"`
Expected: no output (exit code 1).

- [ ] **Step 4: Confirm the new hooks exist exactly once each**

Run: `grep -cE "id=\"pay-card\"|id=\"price-amount\"|id=\"price-per\"|id=\"crypto-price\"" "public/membership.html"`
Expected: `4`

---

## Task 3: Update membership.js (remove crypto handler, retarget the discounted price)

**Files:**
- Modify: `public/js/membership.js:114-121` (`setPrices`) and `public/js/membership.js:142-148` (crypto click handler in `render`)

- [ ] **Step 1: Update `setPrices()` to write the discounted price into `#crypto-price`**

Replace this function (currently lines 114-121):

```js
/** Show the headline price on both cards (card = full, crypto = 20% off). */
function setPrices(amount, currency, per) {
  $('price-amount').textContent = fmtMoney(amount, currency);
  $('price-per').textContent = `/ ${per}`;
  const cryptoAmt = Math.round(amount * (1 - CRYPTO_DISCOUNT));
  $('crypto-was').textContent = fmtMoney(amount, currency);
  $('crypto-amount').textContent = fmtMoney(cryptoAmt, currency);
}
```

with:

```js
/** Headline card price, plus the live "20% off" crypto figure shown in the footnote. */
function setPrices(amount, currency, per) {
  $('price-amount').textContent = fmtMoney(amount, currency);
  $('price-per').textContent = `/ ${per}`;
  const cryptoAmt = Math.round(amount * (1 - CRYPTO_DISCOUNT));
  const cryptoPrice = $('crypto-price');
  if (cryptoPrice) cryptoPrice.textContent = fmtMoney(cryptoAmt, currency);
}
```

- [ ] **Step 2: Remove the `#pay-crypto` click handler**

In `render()`, delete this block (currently lines 144-148):

```js
  $('pay-crypto').addEventListener('click', () => {
    // Crypto checkout (self-hosted ETH/XMR/LTC/BCH) isn't live yet — graceful note.
    showBanner('🚀 GigaChad crypto checkout (ETH · XMR · LTC · BCH) is landing soon — 20% off when it goes live. Card works now.', 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
```

Leave the `#pay-card` and `#manage-btn` listeners immediately around it intact. After the edit the start of `render()` should read:

```js
async function render() {
  $('pay-card').addEventListener('click', (e) => startCheckout(primaryInterval, e.currentTarget));
  $('manage-btn').addEventListener('click', (e) => openPortal(e.currentTarget));

  const status = params.get('status');
```

- [ ] **Step 3: Confirm no dead references remain in the JS**

Run: `grep -nE "pay-crypto|crypto-was|crypto-amount" "public/js/membership.js"`
Expected: no output (exit code 1).

Run: `grep -cE "crypto-price" "public/js/membership.js"`
Expected: `1`

---

## Task 4: Bump the on-site version badge

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Bump the version**

Change line 3 from:

```json
  "version": "1.13.0",
```

to:

```json
  "version": "1.13.1",
```

- [ ] **Step 2: Verify**

Run: `node -e "console.log(require('./package.json').version)"`
Expected: `1.13.1`

---

## Task 5: Verify and commit

- [ ] **Step 1: Regression — run the test suite**

Run: `npm test`
Expected: all suites pass (these cover backend/lib logic; this change must not break any). If anything fails, it indicates an unrelated breakage — stop and investigate before committing.

- [ ] **Step 2: Visual verification of the offer card (non-member view)**

Start the dev server and open the page using the preview tools:
- `preview_start` (runs `npm start` / `server.mjs`).
- Navigate to `/membership.html` (no auth needed — a signed-out visitor hits `showPlans()` and sees the offer card).
- `preview_console_logs` → expect no errors (e.g. no "Cannot set properties of null").
- `preview_snapshot` → confirm in order: badge "Premium membership", "Unlock every exclusive", five benefit rows, the price, a single "Get instant access" button, "Start watching the moment you pay", the Visa/Mastercard/Secured-by-Stripe row, the cancel-guarantee line, and the crypto footnote ending in "(20% off) when it lands."
- `preview_screenshot` (desktop) and `preview_resize` to a narrow width (~390px) + `preview_screenshot` to confirm the card stacks cleanly with no horizontal scroll.

Expected: one focused card, no second "crypto" button, no animation/glow flicker beyond the static dual glow.

- [ ] **Step 3: Confirm the discounted price renders dynamically (if Stripe is configured in this env)**

In the `preview_snapshot`, if Stripe checkout is enabled the headline price reflects the live amount and the crypto footnote shows 20% of it (e.g. headline `$1` → footnote `$0.80`). If Stripe is **not** configured locally, expect `#pay-card` disabled and the "Memberships aren't available just yet" banner — that is correct fallback behavior, and the static `$0.80` placeholder in the footnote is acceptable since `setPrices` only runs when config is enabled.

- [ ] **Step 4: Commit**

```bash
git add public/membership.html public/js/membership.js package.json
git commit -m "feat: premium single-path membership page; drop meme crypto chooser"
```

---

## Self-review checklist (run before handing off)

- [ ] **Spec coverage:** every spec section maps to a task — content order (Task 2), removals (Tasks 1-3), CTA "Get instant access" (Task 2), instant line / trust badges / guarantee (Task 2), crypto footnote with live 20%-off price (Tasks 2-3), Level 2 color: colored benefit icons + crypto coin dots + dual gold/violet glow (Tasks 1-2), version bump (Task 4), member-view untouched (verified by *not* editing `#member-view` / `showMember`).
- [ ] **No leftover IDs/classes:** Task 1 Step 2, Task 2 Step 3, Task 3 Step 3 grep-verify removal of `pay-crypto` / `crypto-was` / `crypto-amount` / `pay-choice` / `giga*` / `normie*` / `pixelate`.
- [ ] **ID consistency:** markup defines `#pay-card`, `#price-amount`, `#price-per`, `#crypto-price`; JS references exactly those (`#pay-card` listener, `setPrices` writes `#price-amount`/`#price-per`/`#crypto-price`). `#manage-btn` listener still has its element in the untouched `#member-view`.
- [ ] **No new test harness added** (per spec scope).
