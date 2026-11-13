# Queued partial and full exits

[A05 / #23](https://github.com/ayadebbagh/first-press/issues/23) extends the connected Account panel with current backing, quantity reservations, partial/full exit intents and cancellation. It does not execute a sale or credit estimated proceeds. Settlement remains A06/A08 work and automatic collection remains gated by C01/C03/C05/C06/C08. The device demo is separate.

## Amounts and estimates

An exit specifies **0.01%–100.00% of currently available backing**, encoded as an integer `exitBasisPoints` from 1 to 10000. Each original lot has 10^12 fractional quanta. Admission takes `floor((remaining_quanta - reserved_quanta) × basis_points / 10000)` from **each existing owned lot**, skips zero allocations and rejects an all-zero result. A full exit takes every available quantum, including very small remaining quantities; it does not include quantities already reserved by another exit. The same percentage is applied to each available lot, rather than treating unequal lots as exchangeable shares.

The stored allocation list is immutable. New buys, new listener counts and later executions cannot enlarge it. Cancelling releases exactly those held quanta once; it does not change original principal, entry count, original order time, receipt or past support evidence. Queuing/cancelling an exit makes **no wallet or monetary ledger movement**.

The order's estimated proceeds use its immutable placement listener snapshot, original lot principal/entry denominator and allocated quantity. This deterministic estimate excludes mutable subcent carry; the actual execution must apply its fresh execution count and each lot's then-current remainder using Backing v1 arithmetic. It can differ by growth/loss and rounding. Do not treat it as a fixed payout or spendable Credits. Estimates beyond the supported monetary range are unavailable, never capped into a promised return.

Current position values use the last accepted, C04-linked safe observation with its actual timestamp. Old observations are explicitly stale; disputed/unsafe/synthetic or future data gives unavailable estimates. A paused artist can remain visible without accepting new exits. Closed lots leave the current-position list, while original orders and receipts remain retained. The available-value estimate excludes already reserved quanta and mutable carry; it is not a second wallet balance.

## API

All routes use the existing active, verified member session, canonical Origin on writes, private/no-store responses and strict 4-KiB bodies. Identity, lot IDs, allocation quantities, price, payout and timestamps cannot be supplied by the caller.

| Route | Behavior |
| --- | --- |
| `POST /api/account/orders/exit` | Exact `{artistId,exitBasisPoints,idempotencyKey}`. The percentage is an integer, not a string or floating decimal. Keys use the same 8–128 character format as buys. 201 for a new order; 200 for a committed replay. 30 admissions per member/minute. |
| `POST /api/account/orders/[id]/cancel` | Empty body or `{}` dispatches by the owned immutable side. A buy releases Credits; a sell releases backing quantities. Foreign/missing IDs return 404; settled orders return 409 with no refund/release. |
| `GET /api/account/backing?cursor=…` | Current positions plus mixed buy/sell history, paginated 50 orders at a time. One read-only repeatable-read snapshot keeps wallet, order states, allocations and positions coherent. |
| `GET /api/account/orders/[id]` | Owned order and allocation detail in one read-only repeatable-read transaction. A cancellation committing between queries cannot create a mixed queued/released result. |

Sell responses contain `order`, current `wallet`, current `positions` and `created`/`cancelled`. Order detail retains `amountCents:null`, percentage, original timestamps and placement snapshot, a nullable nonbinding `estimatedProceedsCents`, and `{lotId,quanta,status}` allocations. Values travel as decimal strings; basis points are a bounded exact integer. Position summaries retain unavailable/stale states and counts of total, available and reserved lots. Those counts may overlap because one lot can have both available and reserved fractions.

New exits require the same fresh positive reviewed baseline and active nonsynthetic artist as buys. The server rechecks active/verified membership, a non-demo database, initialized wallet and accounting before admission. An absent wallet is not silently initialized. No available backing or a percentage rounding every lot to zero returns `ineligible`; invalid percentages/client-authority fields return 400.

## Transactions and retries

Admission locks artist → member → user → wallet → owned lots in stable ID order; it inserts a new immutable order and holds the calculated quantities in the same transaction. The per-account lock serializes request keys across buy/sell and across artists. Known replays are returned before current artist/source checks; they never reserve again, even after cancellation, suspension or staleness. Reusing the key with a different intent returns 409.

Cancellation discovers the owned artist without first locking the order, then locks artist → member → user → wallet → order → lots in stable ID order → allocations. It checks status and exact ownership/held amounts again, reads the database clock after lock waits, releases quantities and marks the order cancelled atomically. Settlement must use compatible locks. The first successful cancel/settle transaction wins. Cancellation remains allowed after a cutoff and during stale data, source incidents or artist suspension, subject to normal account authorization.

Migration `0009_exit_quantity_integrity.sql` adds deferred commit checks:

- `reserved_quanta = sum(held exit allocations)` for each lot.
- `remaining_quanta + sum(consumed exit allocations) = initial_quanta`.
- Terminal orders cannot retain held quantity allocations.

Existing history is validated during migration. Drift blocks the migration or operation; it is never automatically repaired. Original schema guards still enforce lot ownership, positive bounded quantities, immutable allocations/terminal results and original entry/principal evidence. A transaction failure rolls all reservations back.

The UI saves only a per-user pending exit intent/key in sessionStorage, separate from buy recovery. A lost response keeps the percentage/artist locked and retries the identical key across reloads. Only a serialized `intentAbsent:true` response can establish that a previous ambiguous attempt has no committed order. Confirmed POST data updates the screen before refresh, so a later read failure cannot erase an accepted reservation or cancellation. Storage never authorizes backing quantities or wallet funds.

## Verification

`TEST_EXIT_DATABASE_URL=… pnpm test:exits` requires an explicitly disposable `_test` PostgreSQL database and applies all migrations. Real integration cases cover fractional/tiny quantities, all-zero rejection, overlapping/full exits, concurrent retries and buy/sell key races, unchanged allocations after new lots/prices, rollback, ownership, active-member rechecks, stale/incident/demo gates, direct-SQL drift rejection, original receipt retention, and both cancel/settle winners. A deterministic read test commits cancellation between the real base-order and allocation SELECTs and proves coherent old/new snapshots.

Historical settled-lot helpers refuse non-test databases and seed only past, chronological test state. They provide existing backing for A05 tests; they are not production execution or proof A06 works. Signed-in browser tests separately exercise real Next APIs, delivered local SMTP verification, current C04 admin captures and PostgreSQL invariants with isolated desktop/mobile contexts. No personal browser/profile, real account or live provider credentials are used.
