# Whop dashboard tasks — handoff

Two changes are needed in the **Whop dashboard** for davidbondtv.com. Both must be
done by a human/agent logged into Whop; they cannot be done from our codebase.

You are working in Whop company **`biz_SD4cQIFrv5gIBc`** (David Bond TV).

Read the "Do not touch" list before you start. When you're done, report back the
one value asked for in Task B.

---

## Do NOT touch (these will break live payments or lose money)

| Thing | Id | Why |
|---|---|---|
| The live membership plan | `plan_LCecn0REAGAri` | $28.00 first charge / $19.69 monthly. Real paying members are on it. Do not change its price, billing period, or visibility. |
| The visible access pass | `prod_TbnyMyCcA0PHh` | "DavidBondTV" — what the membership plan grants. Leave it alone. |
| The API key | — | Do **not** rotate or regenerate any API key. The site authenticates with the existing one (`WHOP_API_KEY` in prod systemd env). Rotating it takes the card rail offline. |
| The webhook signing secret | — | Do **not** regenerate it. The site verifies every webhook against `WHOP_WEBHOOK_SECRET`. Changing it silently stops all payment activation. |
| The existing webhook endpoint | `https://davidbondtv.com/api/pay/whop/webhook` | Keep it. You may need to **add** events to it (Task B step 5), never remove or replace it. |
| Existing memberships | e.g. `mem_CAJ6eXWIAWtcaK` | Don't cancel, refund, or edit any membership. |

**Do not issue refunds, cancel memberships, or change any price on an existing
plan.** If a step seems to require any of that, stop and report back instead.

---

## Task A — Archive the $0 plan

There is a **live, visible, one-time plan priced $0.00**:

- Plan id: **`plan_tqCC3gJyDfvsv`**
- Type: `one_time`, initial price `0.0`, renewal `0.0`
- Visibility: `visible`
- Attached access pass: `prod_2rErcEcZaiLx2` (a *hidden* "DavidBondTV" pass)

Whop checkout links resolve by plan id (`https://whop.com/checkout/plan_tqCC3gJyDfvsv`),
so this plan is reachable even though its access pass is hidden.

**Context so you don't over-react:** the site-side hole this created has already
been closed in code (v1.57.0 — the webhook now refuses to grant access for any plan
other than the ones we actually sell). So this task is defence-in-depth, not an
emergency. It is still worth doing: a $0 plan sitting visible in the account is a
trap for the next person who wires something up.

**What to do**

1. Find plan `plan_tqCC3gJyDfvsv` in the dashboard (it lives under the hidden
   `prod_2rErcEcZaiLx2` access pass, not the main DavidBondTV product).
2. **Archive** it (preferred) or set its visibility to hidden/unpublished.
   Prefer archive over delete — it's reversible and preserves history.
3. Do **not** touch `plan_xBng8Db3iCheJ` ($1.00/mo on the same pass) — it is
   already archived. Leave it as is.
4. Do **not** delete the `prod_2rErcEcZaiLx2` access pass itself.

**How to confirm it worked:** the plan shows as archived/not-visible in the
dashboard, and `https://whop.com/checkout/plan_tqCC3gJyDfvsv` no longer offers a
purchase. Report what you observed.

---

## Task B — Create a one-time $299 plan for the course

The site sells a course, **Digital Pickup 2.0** ($299.00 USD, 28 lessons). Until now
it could only be paid for in Ethereum. The code to sell it by card is deployed and
waiting on a Whop plan id.

**Requirements — all of these matter**

1. Create it in the **same company** as the existing plans (`biz_SD4cQIFrv5gIBc`).
   Checkout-session creation and our reconcile lookup are scoped to that company +
   the existing API key. A plan in another company will not work.
2. Create a **new product / access pass** for the course (e.g. named
   "Digital Pickup 2.0"). Do not hang this plan off `prod_TbnyMyCcA0PHh`, the
   membership pass.
3. Pricing must be **one-time / single payment** — Whop `plan_type: one_time`.
   **Not** a subscription or renewal plan. A recurring plan would bill the buyer
   again every period for a product sold as "one-time purchase, lifetime access".
4. Price: **$299.00 USD** exactly. Currency `usd`. No trial, no setup fee, no
   initial-vs-renewal split.
5. Visibility: visible / published, `buy_now` release method. Card payments enabled.
6. **Do not attach any Whop-side gated content, files, or Discord/Telegram roles.**
   Access is granted on davidbondtv.com — Whop is only the payment processor here.
   Anything you attach on the Whop side is redundant and can confuse buyers.
7. Confirm the webhook endpoint `https://davidbondtv.com/api/pay/whop/webhook`
   receives events for this **new** plan. Whop subscriptions are usually
   company-level, in which case there is nothing to do — but verify. The events the
   site needs are:
   - `payment_succeeded`
   - `membership_activated` (and `membership_went_valid` if listed separately)
   - `refund_created` / `payment_refunded`

   If Whop scopes webhooks per product, add the new product to the existing
   endpoint. **Add** — never replace the endpoint or regenerate its secret.

**What to report back**

The new plan id (`plan_XXXXXXXXXXXX`) is the essential value — plus the details
captured in the report block at the end of this document. Fill that block in
verbatim; it is what unblocks the rest of the work on the site side.

---

## What happens after you're done

For reference only — nobody needs to do this in Whop:

- David pastes the plan id into `/god-products`. The course page then shows a card
  "Purchase $299" button next to the existing Ethereum option.
- On payment, Whop's webhook hits our endpoint, we match the sale to the buyer's
  account by the `productId` we stamped in the checkout metadata (falling back to
  the plan id, then their email), and grant lifetime course access.
- If the plan id is ever wrong or blank, the course simply stays crypto-only. It
  fails closed, so a mistake here cannot charge anyone incorrectly.

## If something doesn't match this document

The plan/pass ids above were read from the live Whop API on 2026-07-28. If what you
see in the dashboard differs — different ids, different prices, extra plans — **stop
and report the discrepancy** rather than guessing which one is live. Getting this
wrong on the membership plan would affect real paying members.

---

## FINAL STEP — fill in this report and give it to David

Your last action is to output the block below with every `<…>` replaced. Copy the
whole thing, fences included. Do not summarise it in prose instead — the exact
fields are what the site-side work keys off.

If you could not complete a task, still send the block and put what happened in the
field. A blank or guessed plan id is worse than an honest "not done" — the site
fails closed, so an unfinished task costs nothing, but a wrong plan id sends buyers
to the wrong checkout.

```
WHOP HANDOFF REPORT — davidbondtv.com

TASK A — $0 plan plan_tqCC3gJyDfvsv
  result:            <archived | hidden | deleted | not found | NOT DONE>
  checkout link now: <no longer purchasable | still purchasable | did not check>

TASK B — new one-time course plan
  plan id:           <plan_XXXXXXXXXXXX | NOT CREATED>
  access pass id:    <prod_XXXXXXXXXXXX>
  plan type:         <one_time | recurring>   (must be one_time)
  price in dashboard:<$XXX.XX USD>
  visibility:        <visible | hidden>
  gated content attached on Whop side: <none | (describe)>

WEBHOOK
  endpoint:          <unchanged | changed — describe>
  secret:            <unchanged | REGENERATED>   (must be unchanged)
  events present:    <payment_succeeded / membership_activated / membership_went_valid / refund_created / payment_refunded — list what you see>
  changes made:      <none | added the new product to the existing endpoint | other>

ANYTHING UNEXPECTED
  <ids or prices that differed from the handoff doc, anything you chose not to do,
   anything you're unsure about — or "none">
```

**David:** paste that block into Claude Code along with the line

> Whop is done — here's the report, go ahead and finish it.

That gives Claude the plan id plus explicit approval to make the remaining
production changes: setting the plan id on the live product so the card button turns
on for the course, deploying v1.57.0, and verifying the funnel afterwards. Claude
will not touch production without that go-ahead.
