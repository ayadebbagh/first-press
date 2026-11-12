# Architecture

## Current implementation

Next.js App Router serves independent app routes and `/api/health`. React state and `localStorage` implement the entire demo account. `src/engine.ts` holds pure accounting rules; `src/playback.ts` selects the provider. The production bundle uses standalone output and a non-root Docker image. There is no database, authentication or metric collector.

## Accepted connected-beta design — implementation pending

Keep one Next.js application, one PostgreSQL database and one scheduled Node worker from the same repository. Use Drizzle for typed migrations and Better Auth with both Google and email/password sign-in, as accepted in [ADR 0001](adr/0001-self-hosted-backend.md). These backend packages and connected accounts are not implemented yet. Select and test email delivery for verification/recovery before launch; avoid making a paid service a hidden prerequisite. Do not require a member's Spotify login just to use an embed or back an artist.

Browser → authenticated Next.js handlers → domain services → PostgreSQL transactions. The browser supplies intent, never authoritative balances, prices or receipt timestamps. The scheduled worker obtains candidate observations through a provider adapter, validates them, commits immutable snapshots and settles eligible orders transactionally. An admin-only manual import adapter is a useful first implementation if automated source access is unresolved. Do not bypass access controls.

Start without Redis, hosted job services or object storage. PostgreSQL can coordinate durable job claims and idempotency; bundled public assets are sufficient initially. Add infrastructure when load or recovery requirements justify it. Expected recurring costs are hosting, backups/domain and any chosen identity delivery; data access costs remain contingent. No subscription purchase is authorized by this plan.

## Domain boundaries

- Identity: users, sessions, invite admission, roles and public-profile settings.
- Catalog: internal artist IDs, reviewed provider artist IDs, tracks, recording versions, provenance and eligibility.
- Data: raw observation metadata, source/metric identity, observed time, fetched time, validation and accepted snapshots. Preserve revisions through append-only corrections.
- Backing: Credit ledger, reservations, orders, position lots, settlements and idempotency keys. Represent Credits as integer centi-Credits; define position precision and rounding in F04. Use database constraints and transactions rather than JavaScript floating-point balances as authority.
- Trust: immutable backing events, receipt verification, public views and redaction policy. Record order commitment time separately from execution and the metric observation time. Do not claim an earlier timestamp proves the user was the first listener.
- Operations: audited admin actions, collection jobs, settlement batches, migrations, backups and health/readiness.
- Daily (later): rotation versions, connected match assignments, votes, locked predictions and published results, isolated from live backing accounting.

## Settlement model to specify before coding

For a position of q listener-index units, value at an accepted listener count L is q × L, rounded by the versioned rule. A buy of C Credits at execution count L creates q = C/L; a sale queues a quantity of units, so its eventual proceeds are not guaranteed at order time. A split/lot representation and cost basis must support partial exits and retained entry evidence.

Orders must commit before their eligible update boundary; obtain an initial valid baseline before enabling backing. Snapshot observation delay, cutoffs, maximum staleness, source corrections and suspended artists need explicit policy. A fetch failure or missing number never becomes zero. A retry must not debit, settle, grant or create proof twice. Never substitute another platform's metric silently.

## Environments and deployment

Local development and isolated CI fixtures use synthetic data. Staging uses separate credentials and storage. Production has an HTTPS reverse proxy, private database network, persistent volumes and encrypted off-host backups. Separate collection/settlement credentials from ordinary web roles where practical. Health must distinguish liveness from database/job readiness before launch. Pin and roll forward migrations; document restore and application rollback compatibility.

See the [roadmap](ROADMAP.md), [decision register](DECISIONS.md) and [backlog](planning/BACKLOG.md). No proposed backend is production-ready until its issues are implemented and verified.
