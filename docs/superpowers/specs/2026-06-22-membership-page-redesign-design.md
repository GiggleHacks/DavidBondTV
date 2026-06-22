# Premium membership page redesign — design spec

**Date:** 2026-06-22
**Files:** `public/membership.html`, `public/js/membership.js`
**Goal:** Make the paid-membership offer page cleaner, more premium, more trustworthy, and higher-converting. Remove the meme branding and the dead-end crypto button; make the single working payment path (card via Stripe) unmistakable.

> **Revision 2026-06-22 (post-rescan):** Adapted after a large payments change landed in the working tree (uncommitted). A new admin-driven pricing system (`lib/pricing.js`, `/api/admin/pricing`, `data/pricing.json`) added **a yearly plan** and **intro ("first month") pricing**, and `public/js/membership.js` (+`membership.html`) gained `setCardPricing()` / `setYearly()` and a `#year-row`. Crypto is **still not live** ("Coming soon" unchanged), so the core design holds. This redesign must now **preserve** the yearly option and intro display and the live config contract — not just render a single monthly price. Version is now `1.14.0`.

## Background

The current page (`#plans-view` in `public/membership.html`) presents a two-path payment chooser:
- "Normie Pay" (card) — deliberately styled as the lesser option, with **pixelated** Visa/Mastercard marks.
- "GigaChad Based" (crypto) — visually dominant: animated glowing gradient border, pulsing "20% CHEAPER" badge, cheaper price, hype copy — but its button says **"Coming soon"** because crypto checkout is not implemented.

### Problems identified
1. **The flashiest option is a dead end.** All visual energy steers users toward a crypto button that cannot take money, while the working "Pay with card" button is styled as the boring choice.
2. **"Normie Pay" insults paying customers** and pixelating the Visa/Mastercard logos undermines trust in the only working method.
3. **Value comes after the ask** — the benefits list sits below the payment cards, so users choose a payment path before seeing the "why".
4. **Meme voice conflicts with the stated goal** of premium / professional / trustworthy.

## Decisions (locked with owner)

- **Brand voice:** Fully premium. Drop "Normie Pay" / "GigaChad Based" and all meme styling.
- **Crypto handling:** Card is the sole prominent, working payment method. Crypto becomes a quiet, muted single-line footnote ("coming soon"). No prominent button that cannot take money.
- **Layout:** Concept A — value-first single centered card. Reading order = conversion order: what → why → price → one button → trust.
- **Trust elements to include:** instant-access line, secure-payment badges (real Visa/Mastercard + "Secured by Stripe"), cancel/keep-access guarantee. **No social proof** (no real numbers/quotes available — do not invent any).
- **Primary CTA copy:** "Get instant access" (outcome-focused). Payment method conveyed by the Visa/Mastercard + Stripe lock row directly beneath the button.
- **Crypto footnote price:** show the live discounted price (20% off the **recurring monthly** card price), computed client-side.
- **Yearly plan (new):** presented as a **secondary link/button below** the primary monthly CTA — "Prefer yearly? Get a year for `$120` — save 41%". Re-styled, not removed. Hidden when the config doesn't offer a yearly price.
- **Intro pricing (new):** when `cfg.intro` is present, the price block shows the intro amount as the headline (e.g. "`$X` first month") with a sub-note "then `$Y`/mo"; otherwise the flat monthly price. The crypto footnote always uses the **recurring** monthly price.

## Design

Keep the existing dark "midnight" theme, gold accent (`#f4a300`), and the subtle gold glow on the single offer card. Single centered card, ~min(440px, 100%). Everything stacks naturally on mobile (already single column).

### Content order (`#plans-view`)
1. Gold pill badge — `★ Premium membership` *(keep)*
2. Headline (`h1.mb-title`) — "Unlock every exclusive"
3. Subhead (`.mb-sub`) — "The full David Bond TV library — plus every new drop the moment it lands."
4. Benefits list (`.mb-benefits`, left-aligned, each item with a meaning-coded colored icon — see Color treatment):
   - `ti-movie` (gold `#f4a300`) — Every exclusive video — the entire premium library
   - `ti-bolt` (coral `#e2674a`) — New videos the moment they drop
   - `ti-circle-off` (green `#2bbd8e`) — Ad-free, uninterrupted streaming
   - `ti-devices` (blue `#4a90e2`) — Watch on any device, anywhere
   - `ti-brand-telegram` (Telegram-blue `#229ED9`) — Private David Bond TV Telegram channel
   *(The "cancel anytime" item moves out of the list and becomes the guarantee line in #9.)*
5. Price block (`.mb-price`) — large gold headline price from `/api/pay/stripe/config`. Two states, both driven by `setCardPricing(month, intro)`:
   - **No intro:** `#price-amount` = monthly amount, `#price-per` = "/ mo", `#price-sub` hidden.
   - **Intro present:** `#price-amount` = intro amount, `#price-per` = the intro label (e.g. "first month"), and a sub-note `#price-sub` shows "then `$Y`/mo".
   Never hardcoded; if only yearly is offered, headline shows the yearly price (existing fallback).
6. Primary CTA (`#pay-card`, `.mb-cta`) — full-width gold button: **"Get instant access"** with a lock icon. Starts checkout for `primaryInterval` (monthly).
7. Instant-access line (directly under CTA) — "Instant access — start watching the moment you pay."
8. Yearly secondary action (`#year-row` → `#pay-year`, re-styled) — a quiet, low-emphasis button below the instant-access line: "Prefer yearly? Get a year for `#year-amount`" + a `#year-save` "save N%" pill. Hidden by `setYearly()` when no yearly price. Clicking starts checkout with interval `year`.
9. Trust row — crisp, real **Visa** + **Mastercard** SVG marks · "Secured by Stripe" with a lock glyph. This row carries the "paid by card" meaning since the button no longer says "card".
10. Guarantee line — "Cancel anytime — keep access through the end of your billing period."
11. Crypto footnote (`.mb-crypto-note`, muted, single line) — "Prefer crypto? ETH · XMR · LTC · BCH coming soon — just `$X`/mo (20% off) when it lands." Each coin name is preceded by a small dot in the coin's brand color (ETH `#627EEA`, XMR `#FF6600`, LTC `#7CA0E5`, BCH `#0AC18E`). The price (`#crypto-price`) is computed live as 20% off the **recurring monthly** price (reuse existing `CRYPTO_DISCOUNT` + `fmtMoney`).
12. Legal consent (`.mb-consent`) — Terms / Privacy / Refunds links *(keep current wording)*.

### Removals
- "Normie Pay" / "GigaChad Based" names and the whole `.pay-choice` two-card grid.
- The `#pixelate` SVG filter and `.normie-logos` pixelation.
- The `.pay-opt.giga` animated gradient border, `gigaBorder` / `gigaGlow` / `gigaPulse` / `gigaFloat` keyframes, and the `.giga-save` pulsing badge.
- The `#pay-crypto` "Coming soon" button and its click handler in `membership.js` (which currently shows a banner and scrolls up). Crypto is now the static footnote in #11.
- The old `#crypto-was` / `#crypto-amount` price elements (their values move into the `#crypto-price` footnote span).

### Preserved (do NOT remove — added by the new pricing system)
- `#year-row` / `#pay-year` / `#year-amount` / `#year-save` — re-styled as the secondary yearly action (#8), kept functionally identical.
- `#price-amount` / `#price-per` and the addition of `#price-sub` for the "then $Y/mo" intro note.
- The `#pay-year` click handler and the `setCardPricing()` / `setYearly()` functions and the `cfg.intro` / `prices.month` / `prices.year` config contract.

### Visual / icon upgrades
- Real, crisp Visa and Mastercard SVG marks (no pixelation, no `image-rendering: pixelated`).
- Single lock icon for the secure-payment row; Telegram glyph retained for that perk.
- No animations — also resolves the prior `prefers-reduced-motion` special-casing.

### Color treatment (chosen: "Level 2")
The page keeps gold as its anchor accent but adds tasteful, meaning-coded color so it doesn't read as monochrome:
- **Benefit icons** — each list item uses a distinct icon in its own hue (colors listed in content order #4). This is also a scannability win over five identical checks.
- **Crypto coins** — coin names in the footnote are each preceded by a dot in that coin's real brand color (see #10).
- **Card backdrop** — a second, subtle **violet** glow (`rgba(124,92,255,…)`) joins the existing gold glow behind the offer card (dual-tone aura). Achieved with layered `box-shadow` / radial backgrounds; no animation.
- Everything else (badge, headline, price, CTA) stays solid gold — gradients are intentionally *not* applied (that was the "Level 3" option, declined) to preserve the premium feel.

## JS changes (`public/js/membership.js`)

Minimal, surgical edits — the new pricing logic stays intact:
- Remove **only** the `#pay-crypto` event listener and its banner/scroll behavior.
- In `setCardPricing(month, intro)`: replace the two writes to `#crypto-was` / `#crypto-amount` with a single write to `#crypto-price` (`fmtMoney(cryptoAmt, cur)`); add the `#price-sub` "then $Y/mo" note in the intro branch (and clear/hide it in the non-intro branch). The `.pay-opt.normie .pay-note` selector it currently writes to no longer exists, so retarget that note to `#price-sub`.
- Keep **unchanged:** `startCheckout`, `setYearly`, `applyConfig`, the `#pay-card` and `#pay-year` handlers, member view, `?status=success` polling (`pollUntilActive`), and `?status=cancel` banner.
- When Stripe is disabled (`applyConfig` → not enabled), keep disabling `#pay-card` and showing the existing "not available yet" banner.

## Out of scope
- Implementing crypto checkout.
- The member-already-subscribed view (`#member-view`) and `showMember()` — unchanged.
- The pricing **backend** (`lib/pricing.js`, `/api/admin/pricing`, `data/pricing.json`) and the config/checkout API shapes — consumed as-is, not modified.
- Changing the yearly *mechanism* — only its presentation (re-styled secondary link).

## Responsive & accessibility
- Single column; card max-width ~440px; stacks on mobile with no horizontal scroll.
- No motion to gate behind `prefers-reduced-motion`.
- Buttons remain real `<button>` elements; icons decorative with appropriate labelling.

## Versioning
Bump `package.json` version per project convention (shown as the on-site badge, bottom-right): `1.14.0` → `1.14.1`.
