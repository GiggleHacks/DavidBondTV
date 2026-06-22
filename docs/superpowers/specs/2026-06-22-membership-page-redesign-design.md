# Premium membership page redesign — design spec

**Date:** 2026-06-22
**Files:** `public/membership.html`, `public/js/membership.js`
**Goal:** Make the paid-membership offer page cleaner, more premium, more trustworthy, and higher-converting. Remove the meme branding and the dead-end crypto button; make the single working payment path (card via Stripe) unmistakable.

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
- **Crypto footnote price:** show the live discounted price (20% off the live card price), e.g. "$0.80/mo".

## Design

Keep the existing dark "midnight" theme, gold accent (`#f4a300`), and the subtle gold glow on the single offer card. Single centered card, ~min(440px, 100%). Everything stacks naturally on mobile (already single column).

### Content order (`#plans-view`)
1. Gold pill badge — `★ Premium membership` *(keep)*
2. Headline (`h1.mb-title`) — "Unlock every exclusive"
3. Subhead (`.mb-sub`) — "The full David Bond TV library — plus every new drop the moment it lands."
4. Benefits list (`.mb-benefits`, left-aligned, gold check icons; Telegram item in Telegram-blue):
   - Every exclusive video — the entire premium library
   - New videos the moment they drop
   - Ad-free, uninterrupted streaming
   - Watch on any device, anywhere
   - Private David Bond TV Telegram channel
   *(The "cancel anytime" item moves out of the list and becomes the guarantee line in #9.)*
5. Price block (`.mb-price`) — large gold `$1 / month`. Pulled live from `/api/pay/stripe/config` via `setPrices()`, exactly as today. Never hardcoded; falls back to yearly if monthly isn't offered.
6. Primary CTA (`#pay-card`, `.mb-cta`) — full-width gold button: **"Get instant access"** with a lock icon.
7. Instant-access line (directly under CTA) — "Instant access — start watching the moment you pay."
8. Trust row — crisp, real **Visa** + **Mastercard** SVG marks · "Secured by Stripe" with a lock glyph. This row carries the "paid by card" meaning since the button no longer says "card".
9. Guarantee line — "Cancel anytime — keep access through the end of your billing period."
10. Crypto footnote (`.mb-crypto-note`, muted, single line) — "Prefer crypto? ETH · XMR · LTC · BCH coming soon — just `$0.80`/mo (20% off) when it lands." The price is computed live as 20% off the card price (reuse existing `CRYPTO_DISCOUNT` + `fmtMoney`).
11. Legal consent (`.mb-consent`) — Terms / Privacy / Refunds links *(keep current wording)*.

### Removals
- "Normie Pay" / "GigaChad Based" names and the whole `.pay-choice` two-card grid.
- The `#pixelate` SVG filter and `.normie-logos` pixelation.
- The `.pay-opt.giga` animated gradient border, `gigaBorder` / `gigaGlow` / `gigaPulse` / `gigaFloat` keyframes, and the `.giga-save` pulsing badge.
- The `#pay-crypto` "Coming soon" button and its click handler in `membership.js` (which currently shows a banner and scrolls up). Crypto is now the static footnote in #10.

### Visual / icon upgrades
- Real, crisp Visa and Mastercard SVG marks (no pixelation, no `image-rendering: pixelated`).
- Consistent gold check icons for benefits; Telegram glyph retained for that perk.
- Single lock icon for the secure-payment row.
- No animations — also resolves the prior `prefers-reduced-motion` special-casing.

## JS changes (`public/js/membership.js`)

- Remove the `#pay-crypto` event listener and its banner/scroll behavior.
- Keep `startCheckout`, `applyConfig`, `setPrices`, member view, `?status=success` polling (`pollUntilActive`), and `?status=cancel` banner **unchanged**.
- `setPrices(amount, currency, per)`: keep computing the crypto (discounted) amount via `CRYPTO_DISCOUNT`, but write it into the new footnote element instead of the removed `#crypto-amount` / `#crypto-was`.
- `#pay-card` handler unchanged (starts Stripe checkout for `primaryInterval`).
- When Stripe is disabled (`applyConfig` → not enabled), keep disabling `#pay-card` and showing the existing "not available yet" banner.

## Out of scope
- Implementing crypto checkout.
- The member-already-subscribed view (`#member-view`) and `showMember()` — unchanged.
- Annual/monthly plan toggle — not introduced; headline price logic stays as-is.
- Any backend / Stripe config changes.

## Responsive & accessibility
- Single column; card max-width ~440px; stacks on mobile with no horizontal scroll.
- No motion to gate behind `prefers-reduced-motion`.
- Buttons remain real `<button>` elements; icons decorative with appropriate labelling.

## Versioning
Bump `package.json` version per project convention (shown as the on-site badge, bottom-right).
