# Architecture

## Current implementation

Next.js App Router serves independent app routes and `/api/health`. React state and `localStorage` implement the entire demo account. `src/engine.ts` holds pure accounting rules; `src/playback.ts` selects the provider. The production bundle uses standalone output and a non-root Docker image. A01 adds a separate PostgreSQL schema, migrations, lazy server-only connection and isolated fixture tooling; the demo does not consume them. A02 adds gated invite-only account routes, verified identity, sessions/recovery and owned read APIs; transactional backing services and a metric collector remain pending.

## Accepted connected-beta design — services pending

Keep one Next.js application, one PostgreSQL database and one scheduled Node worker from the same repository. Use Drizzle for typed migrations and Better Auth with both Google and email/password sign-in, as accepted in [ADR 0001](adr/0001-self-hosted-backend.md). Pinned database/auth dependencies and core tables are installed; invite-only account services are in A02; A03 adds the [server Credit ledger and starting grant](LEDGER.md); order/settlement and connected portfolio services remain A04–A08. See [authentication setup](AUTHENTICATION.md). See [database setup and schema invariants](DATABASE.md). Select and test email delivery for verification/recovery before launch; avoid making a paid service a hidden prerequisite. Do not require a member's Spotify login just to use an embed or back an artist.

Browser → authenticated Next.js handlers → domain services → PostgreSQL transactions. The browser supplies intent, never authoritative balances, prices or receipt timestamps. The scheduled worker obtains candidate observations through a provider adapter, validates them, commits immutable snapshots and settles eligible orders transactionally. An admin-only manual import adapter is a useful first implementation if automated source access is unresolved. Do not bypass access controls.

Start without Redis, hosted job services or object storage. PostgreSQL can coordinate durable job claims and idempotency; bundled public assets are sufficient initially. Add infrastructure when load or recovery requirements justify it. Expected recurring costs are hosting, backups/domain and any chosen identity delivery; data access costs remain contingent. No subscription purchase is authorized by this plan.

## Domain boundaries

- Identity: users, sessions, invite admission, roles and public-profile settings.
- Catalog: internal artist IDs, reviewed provider artist IDs, tracks, recording versions, provenance and eligibility.
- Data: raw observation metadata, source/metric identity, observed time, fetched time, validation and accepted snapshots. Preserve revisions through append-only corrections.
- Backing: Credit ledger, reservations, orders, position lots, settlements and idempotency keys. Represent Credits as integer centi-Credits; use the lot precision and rounding defined in F04. Use database constraints and transactions rather than JavaScript floating-point balances as authority.
- Trust: immutable backing events, receipt verification, public views and redaction policy. Record order commitment time separately from execution and the metric observation time. Do not claim an earlier timestamp proves the user was the first listener.
- Operations: audited admin actions, collection jobs, settlement batches, migrations, backups and health/readiness.
- Daily (later): rotation versions, connected match assignments, votes, locked predictions and published results, isolated from live backing accounting.

## Settlement contract

[Backing v1](specs/backing-v1.md) defines exact centi-Credits, immutable principal/entry-listener lots and fixed fractions reserved for exits. A lot follows the listener ratio from its own execution snapshot, with exact subcent carry across partial exits. `src/domain/backing-policy.ts` provides tested arithmetic and timing references; the browser demo still uses the separate synthetic engine.

Orders must be accepted before their eligible update boundary; obtain a valid baseline before enabling backing. The contract specifies 00:00/12:00 UTC cutoffs, a two-hour execution window, a 24-hour baseline limit, queued carry-forward/cancellation and prospective source corrections. A fetch failure or missing number never becomes zero. A retry must not debit, settle, grant or create proof twice. Never substitute another platform's metric silently.

## Environments and deployment

Local development and isolated CI fixtures use synthetic data. Staging uses separate credentials and storage. Production has an HTTPS reverse proxy, private database network, persistent volumes and encrypted off-host backups. Separate collection/settlement credentials from ordinary web roles where practical. Health must distinguish liveness from database/job readiness before launch. Pin and roll forward migrations; document restore and application rollback compatibility.

See the [roadmap](ROADMAP.md), [decision register](DECISIONS.md) and [backlog](planning/BACKLOG.md). No proposed backend is production-ready until its issues are implemented and verified.
