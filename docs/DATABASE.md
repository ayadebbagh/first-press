# PostgreSQL persistence foundation (A01)

The server schema is ready for subsequent account/order services. The app still runs the **synthetic local-storage demo**. Applying migrations does not switch it to server accounts or migrate browser Credits/receipts. No live collector or settlement worker is enabled.

## Local setup

Use Node 22, pnpm 11.25 and Docker with Compose. Install with `pnpm install --frozen-lockfile`. Copy `.env.example` to `.env`, set a distinct `POSTGRES_PASSWORD`, and set `DATABASE_URL` to the matching URL (URL-encode special characters in the password). The example is a template, not a shared credential.

```sh
docker compose -f compose.db.yaml up -d --wait
node --env-file=.env scripts/db/migrate.mjs
pnpm dev
```

PostgreSQL is pinned to `postgres:18.7-bookworm`. Its port binds only to loopback; its persistent volume mounts `/var/lib/postgresql`, the versioned data layout for PostgreSQL 18. The standalone app's `compose.yaml` stays independent. A future app+worker production composition must use the private service hostname, not container loopback. The database command never runs automatically on app startup. Do not remove the database volume to solve migration problems.

The migration CLI deliberately reads injected process environment. For pnpm commands, export the URL through your shell/secret manager; use `node --env-file=.env scripts/db/migrate.mjs` for a local file. Drizzle Kit does not implicitly load this file through our config. Never put credentials in `NEXT_PUBLIC_*`, issues, screenshots or command output. Remote PostgreSQL must use verified TLS (`sslmode=verify-full` plus a trusted CA as required by the host); loopback/private Compose development does not require a public listener.

## Schema and precision

`src/server/db/schema.ts` is the typed domain schema; `auth.generated.ts` is the Better Auth core schema. All timestamps are PostgreSQL **TIMESTAMPTZ**. Instants are rendered as UTC by services/wire formats; neither a user's locale nor a server session timezone changes a cutoff. Unknown provider update time remains NULL.

| Records | Purpose and invariants |
| --- | --- |
| user, session, account, verification | Generated core identity/session tables; unique email, session token and provider/account identity. No auth HTTP routes yet. |
| members, wallets | Server-only role and profile privacy; one bounded nonnegative wallet per user. |
| artists, tracks, watchlists | Stable internal and Spotify identities, reviewed status, explicit recording versions and reviewed SoundCloud fallback. |
| listener_snapshots, snapshot_annotations | Provider/metric, count, observation/fetch/accept instants and evidence; invalid readings quarantined, disputes appended. Accepted counts are positive integers ≤10^12. Rows are append-only, including quarantines: insert a reviewed successor. |
| orders, cash_reservations | Account/request uniqueness and payload hash; immutable intent and placement observation; reservations preserve owner, amount and resolution. |
| settlement_batches, settlements | Artist/cutoff uniqueness, immutable sealed watermark, execution window and observation; one immutable execution per order. |
| position_lots, exit_allocations | Immutable original buy/entry evidence, owned exit allocations and bounded remaining/reserved lot fractions. |
| ledger_events | Append-only wallet movements, exact-once starting grant and order/kind uniqueness. Transfer-shaped reservations/cancellations sum to zero. |
| receipt_events, rounding_events | Immutable receipt linked to a committed buy lot; subcent remainder retirement links to its exit allocation. No arbitrary receipt JSON acts as authority. |

Money is integer **centi-Credits**: 100 = 1 Credit. Monetary fields use PostgreSQL BIGINT, node-postgres decimal strings or Drizzle BigInt, bounded by signed 64-bit limits. Wallet available+reserved also fits that bound. Starting grants are exactly 100,000 cents; minimum buys are 100. No recurring/daily grants exist in the schema's allowed event kinds.

Each buy owns 10^12 original lot quanta. These are fractions of that lot, not interchangeable artist shares. Remainders use NUMERIC(60,0), returned as decimal strings. Cast operands to NUMERIC **before** SQL multiplication; intermediate products can exceed BIGINT. Do not set global `pg` parsers to Number or serialize BigInt as JSON numbers. See [Backing v1](specs/backing-v1.md) for pricing and rounding.

Composite foreign keys bind order, account, artist, lot, snapshot and batch identities. Partial unique indexes enforce one initial grant per account and one ledger movement of each kind per order. Custom migration guards preserve original intent, quotes, history and compatible settlement evidence. Corrections append annotations; they do not rewrite trades.

These constraints do **not** implement a balanced wallet service. A03–A08 must transact ledger+wallet+reservation+lot changes, verify authorization, atomically reconcile aggregate reservations, lock account/artist/order/lot rows in a consistent order, and prove concurrent admission/cancellation/settlement. Database credentials confer direct write authority: never expose a database connection to members. R01/R02/C08 still own verified receipt publication, privacy/deletion and correction operations. A01 alone does not satisfy those release gates.

## Migrations and generated auth schema

Better Auth's pinned CLI generates only the core schema from `scripts/db/auth-schema-config.ts`. That config has no runtime routes, provider credentials or invite implementation. To regenerate for an intentional A02 schema change:

```sh
pnpm auth:schema
node scripts/db/normalize-auth-schema.mjs
pnpm db:generate --name=describe_change
```

Review the diff. Normalization uses TIMESTAMPTZ; the reviewed provider-identity uniqueness is maintained separately in the custom migration. Future generator changes must preserve that index. Auth configuration, social linking, invite enforcement, verified email and reset flows are A02; merely creating these tables does not enable sign-in.

Commit SQL and Drizzle's journal/snapshots together. Review SQL before applying. Use only `pnpm db:migrate` (or the env-file Node command), never `drizzle-kit push`, an independent auth migrate command or ad hoc schema edits on shared data. The wrapper checks all previously applied migration hashes/timestamps and serializes release invocations with a session advisory lock; Drizzle Kit remains the migration writer. A changed/missing applied migration blocks the release. New forward migrations are the only supported change path.

The first migration creates tables/constraints; the second adds append-only/provenance triggers and the provider identity index. Keep its custom SQL: Drizzle Kit snapshots do not describe trigger bodies. CI rejects domain schema drift but a trigger change requires a new reviewed custom migration and integration tests.

On staging: back up, apply from a release checkout with an injected staging URL, rerun to prove no-op replay, then run the release smoke checks. On failure inspect the migration transaction and journal using an operator account, preserve evidence, and fix forward. Never stamp a failed migration as applied or rewrite an applied file. Backup/restore and actual production rollout are O01/O02, not evidence supplied by CI.

## Isolated synthetic seed

No migration seeds anything. For an optional fixture, first create a **separate empty database ending `_demo`**, apply migrations there, then explicitly run:

```sh
ALLOW_DEMO_SEED=true node --env-file=.env.demo scripts/db/seed-demo.mjs
```

The seed verifies the actual database name, takes a transaction lock, and refuses a non-demo identity or an occupied unclassified database. It creates one unmistakably synthetic review-only artist and observation. Repeat runs are safe. It creates no accounts, grants, wallets or receipts and never imports localStorage. A `database_identity` marker is permanent environment classification, not an authorization boundary against a database administrator. Production and staging must use separate databases and credentials; never promote a demo database to live.

## Verification

`pnpm test:db` requires an explicit `TEST_DATABASE_URL` ending `_test`; it never falls back to `DATABASE_URL`. Use a **disposable** database owned by the test role. CI provides an isolated PostgreSQL 18.7 service, migrates from empty, tests replay/tamper detection/concurrent migration calls, and rolls back transaction fixtures. The seed test creates/drops its own random `_demo` database, so the isolated test role needs CREATEDB; the production runtime role must not have that privilege. Browser tests continue against the local demo and prove no connected account behavior.

References checked 2026-11-12: [Drizzle migrations](https://orm.drizzle.team/docs/migrations), [Better Auth generation](https://better-auth.com/docs/concepts/cli), [PostgreSQL constraints](https://www.postgresql.org/docs/18/ddl-constraints.html), [Docker PostgreSQL 18 layout](https://hub.docker.com/_/postgres).
