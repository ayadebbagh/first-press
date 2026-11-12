# Backing v1 — Credits, orders and early-support receipts

Version: `backing-v1`. F04 / [issue #10](https://github.com/ayadebbagh/first-press/issues/10). Founder decisions on 2026-11-12: failed updates leave orders queued and cancellable; a settled receipt uses the original order acceptance time as its early-backer date, and shows execution time separately. The founder also accepted prospective correction of settled data errors, emphasizing prevention through validation. The operational defaults below make those choices implementable.

This is the connected-beta contract. `src/domain/backing-policy.ts` is its exact-arithmetic reference, exercised by `tests/backing-policy.test.mjs`. It does not replace the existing synthetic local-storage demo engine or implement accounts, a transactional ledger or a collector. A01–A08, C03–C08 and R01 still gate a real backing release.

## Product rules

- One account receives 1,000.00 virtual Credits exactly once. Weekly grants stay disabled until D06; daily voting creates no Credits.
- Artist-only backing from the curated, eligible catalog. Credits cannot be purchased, transferred, redeemed, borrowed or made negative. No leverage, trading fees or per-artist stake cap in this beta; available unreserved Credits are the purchase limit.
- Minimum new backing: 1.00 Credit; increments of 0.01. Existing fractional positions may be fully exited even if worth less than this minimum.
- Metric: Spotify monthly listeners, with stable artist/provider identity. Streams, followers and other platforms are not interchangeable prices. No platform/formula substitution without a new version and explicit migration.
- Growth and losses follow the ratio of accepted listener counts. There is no promise of a positive return or extra reward for wallet size. Badges and qualifying early-support thresholds remain D05, not implicit in this contract.

## Exact accounting and schema contract

Credits use integer centi-Credits (100 = 1 Credit), stored as PostgreSQL `bigint` and manipulated using BigInt. Wire amounts are decimal strings, never JavaScript floating-point authority. Wallet fields and individual stored amounts are nonnegative and at most 9,223,372,036,854,775,807 centi-Credits. Intermediate products use exact BigInt / PostgreSQL numeric precision of at least 60 integer digits. Overflow suspends the affected operation for review; it never silently caps a gain.

A settled buy creates its own immutable lot and receipt event:

| Field | Meaning |
| --- | --- |
| principal_cents | Credits actually backed, in centi-Credits |
| entry_listener_count | Positive listener count in the execution snapshot |
| initial_quanta | 1,000,000,000,000 equal fractions of this original lot |
| remaining_quanta | Unsold fraction; initially initial_quanta |
| reserved_quanta | Fraction allocated to pending exits; 0 ≤ reserved ≤ remaining |
| proceeds_remainder | Exact unpaid subcent numerator, initially zero |
| order / snapshot / economy_version | Immutable provenance and rule version |

These fractions describe a particular backing lot, not exchange-traded artist shares. The denominator of a lot's value is `initial_quanta × entry_listener_count`. At current count L, the remaining value in centi-Credits is:

`floor((principal_cents × remaining_quanta × L + proceeds_remainder) / denominator)`.

This directly represents “my Credits at my entry audience size”; it avoids first rounding an artificial share price. Each new backing has a separate entry count. The UI may aggregate lots, but never overwrites their individual entry evidence. Estimated aggregate value is the sum of the displayed integer lot values; subcent differences across lots are not spendable Credits.

Accepted listener counts are integers from 1 to 1,000,000,000,000. Missing, zero, negative, malformed, disputed or implausible readings go to review. A source's real zero/delisting requires the C08 suspension process, not an automatic 100% loss produced by a failed fetch.

## Queued buys and exits

A buy atomically moves its amount from available to reserved Credits and records its immutable intent, server acceptance time, earliest eligible batch and the most recent valid observation known when it was placed. Settlement consumes the reservation, creates the lot and receipt and appends ledger events in one transaction. It uses the execution listener count, not the order-screen estimate. Cancelling returns the exact reservation once and creates no receipt.

An exit is specified as 0.01%–100.00% of available backing. Under an account/lot transaction, allocate that fraction of each existing lot's unreserved quanta, rounded down to whole quanta. Persist the allocation list immediately. A 100% exit reserves every available quantum. A later buy or price change cannot enlarge an already queued exit. Reject an exit whose total allocated quantity is zero. After a partial exit the remaining cost basis is derived from the original principal and remaining fraction; original lot/receipt fields are not rewritten.

Exit proceeds per lot are `floor((principal_cents × allocated_quanta × execution_count + previous_remainder) / denominator)`. Retain the division remainder on an open lot for the next exit, so repeated partial sales do not repeatedly discard the same subcent value or mint Credits through rounding. A final exit retires any remainder smaller than one centi-Credit into an auditable rounding event; it cannot produce another spendable cent. Wallet and reservation movements must balance in the ledger. Sum per-lot integer proceeds into the order's cash event.

Until it executes, either kind of order remains cancellable, including after a scheduled cutoff and during a source outage. Cancellation and settlement lock the same order/reservations; the first successful transaction wins. A cancellation retry returns its stored result; cancelling an already executed order reports that it settled and never refunds it. Stable account/request idempotency keys prevent duplicate grants and orders; unique order/settlement keys prevent repeat execution.

## Update schedule, cutoffs and freshness

Use 00:00 and 12:00 UTC daily, independent of daylight-saving changes. An order accepted strictly before a cutoff may execute in that batch. An order accepted exactly at the cutoff belongs to the following one. `nextUpdateCutoff()` specifies this boundary.

The order acceptance timestamp is a server timestamp persisted by a successful admission transaction. It is not a client clock, an exact WAL commit timestamp or cryptographic proof of the user's first listen. Serialize order admission and batch sealing briefly per artist; no source network calls occur while holding that database lock. A batch seals its eligible order watermark before obtaining its new observation, preventing orders placed after the batch began from using its already observed quote. Late-sealing workers still exclude orders whose acceptance timestamp is at/after the scheduled cutoff.

Each batch has a two-hour collection/acceptance/execution window `[cutoff, cutoff + 2 hours)`. Its snapshot must be observed no earlier than the cutoff, validated after observation, and used for execution before the window ends. A previously accepted older snapshot is never reused to settle a new batch. A replay of a committed settlement returns its existing result; an unexecuted expired batch is skipped, rather than traded retrospectively using a now-known old price. Never execute an older batch after a newer one for the same artist.

If a batch fails, keep orders and reservations pending for the next eligible valid batch, with cancellation available. There is no automatic expiry/refund deadline in v1. Tell members that an order is delayed; do not call it settled, turn a missing metric into zero, or create a receipt prematurely.

A reviewed positive baseline observed within the last 24 hours is required to accept new backing/exit orders. Older data or artist suspension pauses new orders for that artist. Existing pending orders remain cancellable and can resume only after a valid eligible observation and active status return. Valuations may show the last accepted count with its actual observation time and a stale indicator; they are estimates, not execution promises.

`observed_at` means when the collector actually saw the public value. Preserve `fetched_at`, source URL/evidence, parser/reviewer identity, metric/provider, accepted-at and batch timestamps separately. If the platform does not disclose its own calculation/update time, leave `source_updated_at` unknown; do not invent it from our fetch time. An unchanged count in a genuinely new observation can be valid; a copied cached observation with a new fabricated timestamp is not.

## Receipts and early recognition

Issue a receipt only after a real buy settlement commits. Its early-backer date is the original order's server acceptance time. Preserve, display and label both the known observation at placement and the execution observation, with their respective source/observation times. A member can have placed an order when the last known count was 100,000, but executed at 110,000; neither value should be mislabeled as a fresh measurement at the acceptance instant.

Record accepted-at, executed-at, execution snapshot/count, principal, original lot fraction, source/economy versions and receipt ID. Selling later does not erase that history. A cancelled or indefinitely queued order earns no receipt, badge or early-support claim. D05 will choose which observation/commitment threshold qualifies for badges. Public verification and profile privacy remain R01/R02/R05 work; local beta cards are still explicitly unverified demo records.

## Disputed data and corrections

Before settlement, quarantine suspicious readings and skip the affected batch. A corrected reading must meet the same identity, provenance and window requirements; otherwise pending orders wait for a later batch. Pausing an artist must never prevent cancellation.

After settlement, freeze the artist for review and append a dispute/correction record linked to the original snapshot. Executed quotes, order timestamps, original lots and ledger movements are immutable. The conservative v1 default is prospective correction: use the next accepted corrected count for subsequent valuations/executions; do not automatically reprice completed orders or claw back previously released Credits. Receipts retain the original quoted count and display its dispute/corrected-source annotation, rather than asserting a known bad count as verified history. Corrected data cannot silently switch the metric or artist identity. If abuse requires an account restriction or an exceptional compensating grant, it needs an explicit audited admin action and reason, never direct balance edits or a negative wallet. C08 must implement and rehearse this procedure before real beta settlements.

## Worked examples

| Case | Result |
| --- | --- |
| Start and queue | 1,000 Credits; a 250 order leaves 750 available and 250 reserved, with no lot/receipt yet. |
| New execution quote | Placed 11:50 UTC with last known count 100,000; observed 110,000 at 12:05 and executed 12:06. Creates a 250-Credit lot at 110,000, and a receipt accepted at 11:50 with execution/observation shown separately. |
| Growth | A 250-Credit lot entered at 100,000 is worth 500 at 200,000. |
| Loss | The same lot is worth 150 at 60,000; it never creates a debt. |
| Partial exit | Sell 50% of that original lot at 120,000: release 150 Credits, keep half the lot, and retain the original receipt. |
| Full exit | Sell the remaining half at 80,000: release 100. The lot closes and its receipt remains. |
| Odd-cent rounding | A 1.01-Credit lot at an unchanged count, exited in two halves, releases 0.50 then 0.51, preserving the full 1.01. |
| Cancel | Cancel the pending 250 buy: restore available Credits to 1,000 exactly once; no receipt. |
| Failed update | The 12:00 batch fails. The 250 buy remains reserved and cancellable. It may execute using a new valid 00:00 observation; orders placed exactly at 00:00 wait until 12:00. |
| Stale baseline | Last observation is older than 24 hours: block new orders, label the old valuation stale, and preserve cancellation of existing ones. |
| Correction before execution | A 12:05 outlier is quarantined; no cash or receipt changes. A validated correction within the window can execute; a later one cannot resurrect the expired batch. |
| Correction after execution | A 250-Credit lot executed at a reported 100,000 is later disputed. Retain that quote and timestamp, annotate the receipt, freeze for review, then use an accepted corrected 125,000 prospectively: its unchanged exposure values at 312.50. Previously completed payouts are not silently rewritten. |

## Release and implementation gates

A01 models the exact types and constraints; A02 authorizes identities; A03/A04/A05 implement ledger/reservations; A06/A08 prove atomic, idempotent, concurrent settlement. C03 clears a real source, C04 validates snapshots, C06 schedules work, and C08 rehearses corrections. R01 implements real receipt verification. The new reference helpers alone satisfy none of those release gates. The demo remains synthetic and local until these paths are connected and verified.
