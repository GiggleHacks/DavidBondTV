# Premium membership page redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2026-06-22 (post-rescan):** Rewritten after a large payments change landed (uncommitted) in the working tree. The membership page now consumes an admin-driven pricing system (`lib/pricing.js`) that adds a **yearly plan** and **intro ("first month") pricing**. This plan PRESERVES both and the live config contract; crypto is still "Coming soon" so it is still demoted to a footnote. Version is now `1.14.0`.

**Goal:** Replace the meme-branded two-path payment chooser on the membership offer page with a single, premium, value-first card (Concept A): one clear monthly CTA, a secondary yearly link, intro-price support, an honest crypto "coming soon" footnote, and tasteful "Level 2" color — without breaking the new pricing/checkout wiring.

**Architecture:** Pure front-end change to two static assets — `public/membership.html` (markup + inline `<style>`) and `public/js/membership.js` (remove the dead crypto handler; retarget two element writes). All pricing still comes live from `GET /api/pay/stripe/config`. The active-member view (`#member-view`), the yearly flow (`#pay-year` / `setYearly`), intro pricing (`setCardPricing`/`cfg.intro`), and the `?status=success`/`cancel` flows are preserved.

**Tech Stack:** Vanilla ES modules, inline SVG icons, CSS using the existing midnight theme vars (`--surface`, `--surface-2`, `--border`, `--text`, `--text-dim`, `--shadow`, `--accent`) + brand gold `#f4a300`. Reuses existing button helpers `.acc-btn.gold-cta` (primary) and `.acc-btn-ghost` (secondary). Tests: vitest (`npm test`) as a regression guard; visual verification via the preview tools.

**Note on TDD:** Presentational/browser-module change with no DOM unit-test harness in this repo (`tests/membership.test.js` covers backend `lib/membership.js`, not this page). Each task ends with a concrete verification step (`npm test` / preview render), not a new unit test. Do not add a DOM test harness — out of scope.

**Spec:** `docs/superpowers/specs/2026-06-22-membership-page-redesign-design.md`

---

## Config contract (must keep consuming exactly this)

`GET /api/pay/stripe/config` → (from `lib/pricing.js` `publicConfig()` + server `enabled` flag):

```js
{
  enabled,                 // bool — false → disable #pay-card, show "not available" banner
  currency,                // e.g. "usd"
  intervals: { month, year },                       // bools — which are offered
  prices: {
    month: { amount, currency, interval } | null,   // amount in integer CENTS
    year:  { amount, currency, interval } | null
  },
  intro: { amount, label, currency } | null          // present only when monthly intro > 0
}
```

Defaults today: monthly `1700` ($17/mo), yearly `12000` ($120/yr), intro off. The redesign must render whatever the config returns — never hardcode amounts.

---

## File structure

- **Modify** `public/membership.html` — replace the inline `<style>` block (remove `.pay-choice` / `.giga*` / `.normie*` / pixelate + `@keyframes`; add `.mb-ico` / `.mb-instant` / `.mb-trust` / `.mb-guarantee` / `.mb-crypto-note` / `.mb-price-sub` + dual glow; keep `.mb-year*`). Replace the `#plans-view` markup. Remove the `#pixelate` SVG `<filter>` block.
- **Modify** `public/js/membership.js` — remove the `#pay-crypto` click handler; in `setCardPricing()` retarget the intro note to `#price-sub` and the crypto price to `#crypto-price` (drop `#crypto-was`/`#crypto-amount`).
- **Modify** `package.json` — bump `version` `1.14.0` → `1.14.1`.

**Element IDs that MUST exist after the markup rewrite** (JS depends on them): `pay-card`, `price-amount`, `price-per`, `price-sub`, `year-row`, `pay-year`, `year-amount`, `year-save`, `crypto-price`. (Plus untouched member-view: `member-view`, `member-status`, `manage-btn`, `banner`, `msg`.)

---

## Task 1: Replace the inline `<style>` block in membership.html

**Files:**
- Modify: `public/membership.html:12-127` (the `<style>…</style>` block)

- [ ] **Step 1: Replace the entire `<style>` block**

Replace the whole block from line 12 (`  <style>`) through its matching `  </style>` (currently line 127) with:

```html
  <style>
    .mb-wrap { width: min(540px, 100%); margin: 40px auto 80px; padding: 0 20px; }
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

    .mb-pricing { margin: 4px 0 18px; }
    .mb-price { display: flex; align-items: baseline; justify-content: center; gap: 6px; }
    .mb-amount {
      font-size: 50px; font-weight: 800; letter-spacing: -1.5px; line-height: 1;
      background: linear-gradient(135deg, #ffe08a, #f4a300); -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .mb-per { color: var(--text-dim); font-size: 16px; font-weight: 600; }
    .mb-price-sub { color: var(--text-dim); font-size: 12.5px; margin: 7px 0 0; }
    .mb-price-sub[hidden] { display: none; }

    /* Primary CTA uses the shared .acc-btn.gold-cta helper; this only sizes it up. */
    .mb-cta { width: 100%; padding: 16px; font-size: 17px; }
    .mb-cta svg { width: 17px; height: 17px; fill: currentColor; }

    .mb-instant { color: var(--text-dim); font-size: 12.5px; margin: 10px 0 0; display: flex; align-items: center; justify-content: center; gap: 5px; }
    .mb-instant svg { width: 13px; height: 13px; fill: #f4a300; }

    /* Secondary yearly action — low-emphasis ghost button below the primary CTA. */
    .mb-year-row { margin: 14px 0 2px; }
    .mb-year-label { display: block; font-size: 12.5px; color: var(--text-dim); margin-bottom: 8px; }
    .mb-year { width: auto; padding: 10px 20px; font-size: 14px; }
    .mb-year strong { font-weight: 800; }
    .mb-year-save { font-size: 11px; font-weight: 800; letter-spacing: .4px; padding: 3px 9px; border-radius: 999px; background: rgba(16,185,129,.16); color: #34d399; }
    .mb-year-save[hidden] { display: none; }

    .mb-trust {
      display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap;
      margin: 18px 0 14px; padding: 13px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
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

- [ ] **Step 2: Verify exactly one style block and that old class names are gone**

Run: `grep -c "</style>" "public/membership.html"`
Expected: `1`

Run: `grep -nE "pay-choice|pay-opt|\.giga|gigaBorder|gigaGlow|gigaPulse|gigaFloat|normie-logos" "public/membership.html"`
Expected: no output (exit code 1). (Markup still has some old class refs until Task 2 — that's fine; this confirms the *styles* are removed.)

---

## Task 2: Replace the `#plans-view` markup and remove the pixelate filter

**Files:**
- Modify: `public/membership.html` — the `#pixelate` SVG `<filter>` block (currently lines ~137-146) and the `#plans-view` block (currently lines ~160-237)

- [ ] **Step 1: Remove the pixelate SVG filter block**

Delete this block (currently lines 137-146, including the preceding comment):

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

- [ ] **Step 2: Replace the entire `#plans-view` block**

Replace the whole `<!-- Offer (non-members) --> … </div>` element — `<div id="plans-view" class="mb-card" hidden> … </div>` (currently lines 160-237) — with:

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

      <div class="mb-pricing">
        <div class="mb-price">
          <span class="mb-amount" id="price-amount">$17</span>
          <span class="mb-per" id="price-per">/ mo</span>
        </div>
        <p class="mb-price-sub" id="price-sub" hidden></p>
      </div>

      <button class="acc-btn gold-cta mb-cta" id="pay-card" type="button">
        <svg viewBox="0 0 24 24"><path d="M12 1a5 5 0 00-5 5v3H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 8H9V6a3 3 0 016 0z"/></svg>
        Get instant access
      </button>

      <p class="mb-instant">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        Start watching the moment you pay
      </p>

      <div class="mb-year-row" id="year-row" hidden>
        <span class="mb-year-label">Prefer to pay yearly?</span>
        <button class="acc-btn acc-btn-ghost mb-year" id="pay-year" type="button">
          Get a year for <strong id="year-amount">$120</strong>
          <span class="mb-year-save" id="year-save" hidden>save 41%</span>
        </button>
      </div>

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
        coming soon — just <span id="crypto-price">$13.60</span>/mo (20% off) when it lands.
      </p>

      <p class="mb-consent">
        Your membership renews automatically at the price shown until you cancel — cancel
        anytime from your account. By subscribing you agree to our
        <a href="/terms">Terms</a>, <a href="/privacy">Privacy Policy</a>, and
        <a href="/refunds">Refunds &amp; Cancellation Policy</a>.
      </p>
    </div>
```

- [ ] **Step 3: Confirm old chooser markup and the filter are gone**

Run: `grep -nE "pay-choice|pay-opt|GigaChad|Normie|pay-crypto|crypto-was|crypto-amount|id=\"pixelate\"|url\(#pixelate\)|mb-price-note" "public/membership.html"`
Expected: no output (exit code 1).

- [ ] **Step 4: Confirm every JS-required hook exists exactly once**

Run: `grep -cE "id=\"pay-card\"|id=\"price-amount\"|id=\"price-per\"|id=\"price-sub\"|id=\"year-row\"|id=\"pay-year\"|id=\"year-amount\"|id=\"year-save\"|id=\"crypto-price\"" "public/membership.html"`
Expected: `9`

---

## Task 3: Update membership.js (remove crypto handler; retarget intro note + crypto price)

**Files:**
- Modify: `public/js/membership.js:119-135` (`setCardPricing`) and `public/js/membership.js:180-184` (crypto handler in `render`)

- [ ] **Step 1: Update `setCardPricing()` to write `#price-sub` and `#crypto-price`**

Replace this function (currently lines 119-135):

```js
function setCardPricing(month, intro) {
  const recurring = month.amount;
  const cur = month.currency;
  const note = document.querySelector('.pay-opt.normie .pay-note');
  if (intro && intro.amount > 0) {
    $('price-amount').textContent = fmtMoney(intro.amount, cur);
    $('price-per').textContent = (intro.label || 'first month').toLowerCase();
    if (note) note.textContent = `then ${fmtMoney(recurring, cur)}/mo`;
  } else {
    $('price-amount').textContent = fmtMoney(recurring, cur);
    $('price-per').textContent = '/ mo';
    if (note) note.textContent = 'Standard price';
  }
  const cryptoAmt = Math.round(recurring * (1 - CRYPTO_DISCOUNT));
  $('crypto-was').textContent = fmtMoney(recurring, cur);
  $('crypto-amount').textContent = fmtMoney(cryptoAmt, cur);
}
```

with:

```js
function setCardPricing(month, intro) {
  const recurring = month.amount;
  const cur = month.currency;
  const sub = $('price-sub');
  if (intro && intro.amount > 0) {
    $('price-amount').textContent = fmtMoney(intro.amount, cur);
    $('price-per').textContent = (intro.label || 'first month').toLowerCase();
    if (sub) { sub.textContent = `then ${fmtMoney(recurring, cur)}/mo`; sub.hidden = false; }
  } else {
    $('price-amount').textContent = fmtMoney(recurring, cur);
    $('price-per').textContent = '/ mo';
    if (sub) { sub.textContent = ''; sub.hidden = true; }
  }
  const cryptoAmt = Math.round(recurring * (1 - CRYPTO_DISCOUNT));
  const cryptoPrice = $('crypto-price');
  if (cryptoPrice) cryptoPrice.textContent = fmtMoney(cryptoAmt, cur);
}
```

- [ ] **Step 2: Remove the `#pay-crypto` click handler**

In `render()`, delete this block (currently lines 180-184):

```js
  $('pay-crypto').addEventListener('click', () => {
    // Crypto checkout (self-hosted ETH/XMR/LTC/BCH) isn't live yet — graceful note.
    showBanner('🚀 GigaChad crypto checkout (ETH · XMR · LTC · BCH) is landing soon — 20% off when it goes live. Card works now.', 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
```

After the edit, the top of `render()` should read (these three listeners remain, untouched):

```js
async function render() {
  $('pay-card').addEventListener('click', (e) => startCheckout(primaryInterval, e.currentTarget));
  const payYear = $('pay-year');
  if (payYear) payYear.addEventListener('click', (e) => startCheckout('year', e.currentTarget));
  $('manage-btn').addEventListener('click', (e) => openPortal(e.currentTarget));

  const status = params.get('status');
```

- [ ] **Step 3: Confirm no dead references remain, and the new targets are wired**

Run: `grep -nE "pay-crypto|crypto-was|crypto-amount|\.pay-note" "public/js/membership.js"`
Expected: no output (exit code 1).

Run: `grep -cE "crypto-price|price-sub" "public/js/membership.js"`
Expected: `2`

Confirm `setYearly` and the yearly handler are still present (must NOT have been removed):

Run: `grep -cE "function setYearly|pay-year" "public/js/membership.js"`
Expected: `2`  (the `function setYearly` definition line + the `const payYear = $('pay-year')` line; the `if (payYear) …` line uses `payYear`, not the `pay-year` string)

---

## Task 4: Bump the on-site version badge

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Bump the version**

Change line 3 from:

```json
  "version": "1.14.0",
```

to:

```json
  "version": "1.14.1",
```

- [ ] **Step 2: Verify**

Run: `node -e "console.log(require('./package.json').version)"`
Expected: `1.14.1`

---

## Task 5: Verify and commit

- [ ] **Step 1: Regression — run the test suite**

Run: `npm test`
Expected: all suites pass (these cover backend/lib logic incl. the new `pricing.test.js`, `stripe-payments.test.js`; this front-end change must not break any). If anything fails, it indicates a pre-existing/unrelated breakage — stop and investigate before committing.

- [ ] **Step 2: Visual verification of the offer card (non-member view)**

Use the preview tools:
- `preview_start` (runs `npm start` / `server.mjs`).
- Navigate to `/membership.html` (signed-out → `showPlans()` shows the offer).
- `preview_console_logs` → expect no errors (e.g. no "Cannot set properties of null", confirming all retargeted IDs resolve).
- `preview_snapshot` → confirm order: badge, "Unlock every exclusive", five colored benefit rows, the price block, "Get instant access" (gold), "Start watching the moment you pay", the yearly ghost button (if yearly configured), the Visa/Mastercard/Secured-by-Stripe row, the cancel-guarantee line, and the crypto footnote.
- `preview_screenshot` (desktop) + `preview_resize` ~390px + `preview_screenshot` → card stacks cleanly, no horizontal scroll, no second crypto button.

- [ ] **Step 3: Verify pricing states render (depends on local config)**

- If Stripe + pricing are configured: headline shows the live monthly amount (default `$17 / mo`); the crypto footnote shows 20% off the recurring monthly (default `$13.60`); the yearly ghost button shows `$120` with a `save 41%` pill.
- If an **intro** is configured: headline shows the intro amount + label (e.g. "$X first month") and `#price-sub` shows "then $17/mo".
- If Stripe is **not** configured locally: `#pay-card` is disabled and the "Memberships aren't available just yet" banner shows — correct fallback; the static `$17` / `$13.60` placeholders are acceptable because `setCardPricing` only runs when config is enabled.

- [ ] **Step 4: Commit**

```bash
git add public/membership.html public/js/membership.js package.json
git commit -m "feat: premium single-path membership page; keep yearly + intro pricing"
```

Note: many unrelated files are already modified in the working tree (the payments change). The `git add` above stages **only** these three files so the commit stays scoped to the redesign.

---

## Self-review checklist (run before handing off)

- [ ] **Spec coverage:** content order (Task 2), removals (Tasks 1-3), CTA "Get instant access" via `gold-cta` (Task 2), instant line / trust badges / guarantee (Task 2), **yearly secondary link preserved** (`#year-row`/`#pay-year`, Tasks 1-2; handler untouched Task 3), **intro pricing preserved** (`#price-sub`, Tasks 2-3), crypto footnote with live 20%-off recurring price (Tasks 2-3), Level 2 color (Tasks 1-2), version bump (Task 4), member-view untouched.
- [ ] **No leftover IDs/classes:** Task 1 Step 2, Task 2 Step 3, Task 3 Step 3 grep-verify removal of `pay-crypto`/`crypto-was`/`crypto-amount`/`pay-choice`/`giga*`/`normie*`/`pixelate`/`.pay-note`/`mb-price-note`.
- [ ] **ID consistency:** markup defines all 9 JS-required IDs (Task 2 Step 4); `setCardPricing` writes `#price-amount`/`#price-per`/`#price-sub`/`#crypto-price`; `setYearly` writes `#year-amount`/`#year-save`/`#year-row`; handlers reference `#pay-card`/`#pay-year`/`#manage-btn`.
- [ ] **Contract preserved:** no edits to `lib/pricing.js`, server routes, or the config/checkout JSON shapes.
- [ ] **Scoped commit:** only the 3 redesign files staged (Task 5 Step 4).
