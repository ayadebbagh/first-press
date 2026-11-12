# Server Credit ledger (A03)

The server owns real beta Credit records. The existing browser collection remains a synthetic demo until A04–A08 connect authoritative order services and UI. Neither browser storage nor a submitted balance is imported. Credits remain virtual, with no purchase, transfer or cash redemption.

## Initial grant

An active, verified member explicitly initializes their server wallet through same-origin **POST `/api/account/wallet`**, with an empty body or `{}`. The server derives the account from its session and grants exactly **100,000 centi-Credits = 1,000.00 Credits**. The endpoint accepts no amount, recipient, request-key override or demo data. GET remains side-effect free, returning NULL before initialization and exact decimal-string balances afterward. A07 will call initialization as part of the connected portfolio flow; registration alone still grants nothing.

The service locks member → user → wallet in a PostgreSQL transaction, checking eligibility again under lock. It creates the wallet, appends the fixed starting event and updates the balance atomically. A unique starting-grant index protects each stable account ID independently of retries or provider linking. Repeated calls return the original event ID and the **current** wallet; they do not reset spent/reserved Credits to 1,000. Weekly/daily grants remain disabled. A database classified as demo cannot initialize server Credits.

The POST uses the existing session/origin guards and a database-backed per-member throttle. The HTTP response returns 201 when created or 200 for a successful replay. All money travels as decimal strings. An inconsistent existing wallet returns a review conflict; initialization never silently repairs balances or mints a compensating grant.

## Transaction primitives and invariants

`src/server/backing/ledger.ts` provides an internal order-movement primitive for A04–A06. It must run in the owning order/reservation transaction, with a server-verified account ID and an independently authorized order intent. It validates BigInt centi-Credits, locks the owned account/wallet/order, checks the immutable order amount/side, detects request-key payload reuse and rejects negative/overflowing balances. Order/kind uniqueness prevents another request key from posting the same movement again.

| Movement | Available | Reserved |
| --- | --- | --- |
| Starting grant | +100,000 | 0 |
| Reserve buy | −amount | +amount |
| Cancel buy | +amount | −amount |
| Settle buy | 0 | −amount |
| Settle exit | +accepted proceeds | 0 |

The primitive is **not a public balance editor** and does not implement order admission, cancellation races, settlement quotes, lots or sale authorization. A04–A06 must validate and mutate those records in the same transaction. In particular an exit amount must come from the accepted snapshot/lot calculation, never a caller's proposed payout. No HTTP API accepts these generic movements.

All fields and intermediate arithmetic stay exact: BIGINT/BigInt for stored cents and PostgreSQL NUMERIC for sums. Wallet fields and their combined total cannot exceed the signed 64-bit maximum. Insufficient funds, invalid types, overflow or conflicting idempotency intent abort the transaction; values are never clamped.

The fifth migration adds deferred **commit-time** constraints requiring:

- available and reserved wallet caches equal their respective immutable ledger sums;
- reserved cents equal the total held buy-cash reservations;
- terminal orders retain no held cash reservation.

Intermediate reservation/ledger updates can temporarily differ inside a transaction, but incomplete work cannot commit. The migration validates historical wallets and fails on drift instead of repairing them. Original migrations are unchanged. Existing append-only and per-order/account uniqueness constraints remain in force. Service lock order avoids relying only on deferred cross-row reads for concurrency; direct concurrent writers can abort on constraint/deadlock errors and must not retry by editing history.

Future admission takes the short artist lock before member → user → wallet → order, then lot locks in stable order where needed. Do not fetch metrics or perform network work while holding these database locks. A08 still proves the complete buy/cancel/sell/settlement race matrix; A03's foundation is not evidence that those unimplemented services are live.

## Admin reconciliation

An active admin can GET `/api/admin/ledger?userId=ACCOUNT_ID`; without a target it checks that admin's own account. Ordinary members get 403. The endpoint returns private/no-store results, is rate-limited and cannot modify money.

A single SQL statement compares the wallet, ledger sums/event count/starting-grant count, and held reservations using one coherent MVCC snapshot. Amounts and counts are strings. An untouched account reports `uninitialized` with no wallet. Violations identify missing/duplicate grant evidence, wallet/ledger drift, cash-hold mismatch or a terminal order retaining a hold. The diagnostic exposes account IDs, not email addresses or provider tokens. An unknown target returns 404 to an authenticated admin.

If reconciliation fails, pause the affected operation, preserve the original records and investigate the source transaction. Do not directly edit balances, rewrite ledger rows, delete receipt evidence or automatically regrant Credits. Compensation/corrections need the separately audited policy and operations in C08; recurring grants remain D06.

## Verification and rollout

`pnpm test:ledger` requires an explicit disposable `TEST_LEDGER_DATABASE_URL` ending `_ledger_test`. It uses real PostgreSQL and committed migrations, not mocks. The suite exercises twenty concurrent initialization attempts, separate/ineligible accounts, reserve/replay/cancel and grant replay after spending, competing reservations, rollback/deferred-constraint failures, exact invalid/overflow handling, cross-owner rejection, request-key conflicts, drift diagnostics and immutable/unique grants.

Connected-account browser tests additionally exercise the real POST/GET/admin routes with real sessions: fixed amounts, concurrent retries, malicious amount/recipient/demo fields, origin rejection, member/admin separation and a healthy reconciliation report. These run at desktop and 320px mobile widths. Test identities and databases are isolated; no real member grant is performed by CI.

Apply the new migration through the A01 wrapper before enabling the new API on staging. Verify initialization/replay and admin reconciliation there, then include reconciliation in the release smoke checks and O03 monitoring. Provider/mail/host configuration and production account activation remain separate rollout work. The standalone file preview neither calls these endpoints nor creates server Credits.

References: [PostgreSQL row locking](https://www.postgresql.org/docs/18/explicit-locking.html), [deferred constraint triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html), [Drizzle transactions](https://orm.drizzle.team/docs/transactions), checked 2026-11-12.
