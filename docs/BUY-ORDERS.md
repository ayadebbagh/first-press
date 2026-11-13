# Server buy orders and cancellation

[A04 / #22](https://github.com/ayadebbagh/first-press/issues/22) adds the first connected backing slice on `/account`: explicit wallet initialization, eligible artist selection, exact Credit reservations, persisted pending/history views and cancellation. The device demo collection remains separate. Sale orders, settlement/receipts, the full connected portfolio and scheduled collection remain A05–A08/C05–C08 release work; this host does not automatically execute queued orders.

## HTTP contract

All endpoints require an active, verified signed-in member. Responses are private/no-store. Member identity is taken from the session; query parameters or request bodies cannot select another account. Every write requires the configured canonical Origin and bounded input. The browser sends a stable random request key for each buy intent.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/account/backing?cursor=…` | Read-only wallet, currently eligible server artists and up to 50 owned buy orders. Opaque `nextCursor` loads older rows in `(acceptedAt,id)` order. The response uses one repeatable-read database snapshot; errors never fall back to demo funds. |
| `POST /api/account/wallet` with `{}` | Explicit existing A03 initialization: grant the fixed 1,000 virtual Credits once. Registration, GET and mounting the UI never grant/reset money. |
| `POST /api/account/orders` | Exact `{artistId,amountCents,idempotencyKey}`. `amountCents` is a positive canonical integer decimal string in centi-Credits (100 = 1 Credit), minimum 100, maximum PostgreSQL signed bigint. Request keys are 8–128 ASCII alphanumeric/`:_-` characters. No account, price, listener count, clock, side or balance fields are accepted. |
| `GET /api/account/orders/[id]` | Owned intent/status, immutable placement estimate, acceptance time and earliest cutoff. A foreign or missing order returns 404. |
| `POST /api/account/orders/[id]/cancel` with `{}` or empty body | Cancel an owned pending buy and return the exact held Credits once. A retry returns its existing cancelled result; a settled order returns 409 without a refund. Extra authority fields are rejected. |

Buy/cancel bodies are limited to 4 KiB. Limits per member/minute: 30 buys, 60 cancellations, 60 desk reads and 60 order-detail reads. Known failures return `{error,code,intentAbsent}`. Invalid intent is 400, unavailable/unreviewed artist or insufficient funds is 422, missing order/artist is 404, and request conflicts, uninitialized wallets, accounting drift or already-settled cancellation are 409. Auth/Origin/rate errors do not establish whether an earlier intent committed. Unexpected failures return 503 and must be retried with the same key.

Order responses include the current wallet, original server acceptance instant, first eligible 00:00/12:00 UTC cutoff, placement snapshot ID/count/actual observation time and terminal timestamps. These are decimal strings/ISO instants; JavaScript Number is never money authority. The placement count is an estimate, **not** the eventual entry quote or proof of early support. Pending/cancelled orders never create lots, receipts or badges.

## Transaction and race rules

Admission takes locks in this order: artist → member → user → wallet → order → cash reservation. The artist lock is shared with listener intake and future batch sealing. Source/evidence collection is outside locks. The account lock serializes account-wide request keys and shared funds even when two requests name different artists. It checks current verified/active membership, non-demo database, wallet/ledger agreement and an explicitly initialized wallet.

For a new request, the artist must be active/nonsynthetic. Its latest accepted snapshot must be nonsynthetic, C04-linked, accepted no later than database wall-clock time, and observed within 24 hours. Do not fall back to an older convenient quote when the latest accepted row lacks provenance. Disputed history or unsafe historical correction chains pause new admission. The database clock is read **after lock waits**, then the next strictly later cutoff is computed; no client or transaction-start clock can backdate an order.

The transaction inserts immutable intent/context, appends one `buy_reserve` ledger event, moves exact Credits from available to reserved, and creates the matching held cash reservation. Deferred constraints verify wallet, ledger and cash holds at commit. Any failure rolls everything back. No generic balance editor is exposed.

An accepted retry is found before current artist/freshness checks and returns its original order with its **current** terminal status and wallet; artist suspension or an expired baseline does not invalidate a previously committed result. Changed intent under the same account/key returns 409. A cancelled retry never re-reserves Credits. Account authorization still applies to every replay.

Cancellation first discovers the owned immutable artist ID without locking the order, then acquires the same artist/account/wallet/order/reservation lock order. It rechecks status and the owned held amount before the ledger primitive. Cancellation remains available after cutoffs and during stale data, artist suspension or source incidents. The first committed cancel/settle transaction wins: cancel releases the hold once; settlement consumes it and closes cancellation. A06 must use these same locks. The test-only settlement fixture proves both race winners but is not a production execution service.

## Ambiguous-response recovery

The UI saves only the pending intent/key in per-user sessionStorage before POST, never a wallet or quote. After a lost response it keeps that intent locked across reloads and retries the exact key, even when catalog data changes. A confirmed POST result updates the visible order/wallet immediately; a failed later refresh does not erase it.

If a serialized server transaction proves the key has **no committed order**, selected admission failures explicitly return `intentAbsent:true`; only then may an ambiguous retry be discarded safely. A network error, 503, rate limit, expired session or generic conflict is not that proof. Refresh/cancellation are repeatable and no client state authorizes server money. Cross-tab funds can change between reads, so the server always rechecks availability.

## Testing and release boundary

`TEST_ORDER_DATABASE_URL=… pnpm test:orders` requires an explicitly disposable `_test` PostgreSQL database, never the app `DATABASE_URL`. Tests exercise 20 duplicate submits/cancels, account-wide cross-artist key/funds races, exact min/max/insufficient amounts, unavailable/C04/stale/disputed data, member revocation after lock waits, rollback injection, ownership, outages/cutoffs, immutable estimates, pagination and both cancel/settle winners. Real signed-in desktop/mobile browser tests use isolated invited users, delivered local SMTP verification, C04-admin captures and PostgreSQL proofs, including actual commit followed by lost HTTP response. They do not use personal browser storage or production accounts.

No founder decision or paid service is added. C01/C03 source and identity work, C05/C06 collection/operations, C08 incident rehearsal and later backing/receipt checks remain live-release gates. This UI cannot make the synthetic discovery catalog or demo receipts authoritative.
