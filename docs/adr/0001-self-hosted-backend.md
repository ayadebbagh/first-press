# ADR 0001 — Self-hosted accounts and backing database

Status: accepted by the founder on 2026-11-12. Resolves F01 / issue #7. This is the beta and production direction; implementation is still tracked in A01/A02 and the backing issues. The existing beta remains a local-storage demo until those issues ship.

## Decision

Use PostgreSQL with Drizzle ORM/migrations, the node-postgres (`pg`) driver and Better Auth with its Drizzle adapter. Keep the current Next.js application and a worker from the same repository. Offer both Google sign-in and email/password. Keep beta registration invite-only regardless of authentication method. No member Spotify login is required for artist discovery or backing.

Selected dependency baseline, verified against official package metadata on 2026-11-12:

| Component | Baseline | Notes |
| --- | --- | --- |
| PostgreSQL | 18.x | A01 development/CI pins the available official 18.6-bookworm image. Upstream 18.7 was announced today but its image is not published yet; upgrade/retest before live deployment. Keep security minors current. |
| Drizzle ORM | 0.45.4 | Stable release; use its Relations v1 adapter path initially. |
| Drizzle Kit | 0.31.11 | Sole application/auth schema migration runner. |
| node-postgres | 8.23.1 | Compatible with Node 22; use a bounded pool. |
| Better Auth | 1.7.21 | Declares peers for Next 16, React 19, pg 8 and Drizzle 0.45. |
| @better-auth/drizzle-adapter | 1.7.21 | Match the Better Auth release and use provider `pg`. |

A01 pins Better Auth and its CLI/adapter to 1.7.21: the initially proposed same-day 1.7.22 release is inside pnpm’s minimum release-age window. Keep that policy enabled and upgrade through a later tested dependency PR. Their official published peer ranges fit the existing Next.js 16.4.5 / React 19.3.1 / Node 22 stack. The ADR initially checked metadata compatibility. A01 adds real PostgreSQL migration/constraint checks; cookie and provider integration tests still belong to A02. Recheck the baseline before installing if development occurs later.

## Why this direction

PostgreSQL provides the transactions and constraints needed for Credit reservations, position lots, idempotent settlement and audit records. Drizzle keeps a typed SQL schema and reviewable migrations in the repository. Better Auth stores identities/sessions in our database and supports the two selected login methods. This keeps beta-to-production continuity and avoids requiring a managed database/auth subscription.

SQLite would simplify the first local setup but introduces a database migration and different concurrency constraints before the server-backed ledger beta. Managed PostgreSQL/auth services reduce host operations but add another provider and pricing boundary. We choose one PostgreSQL design now; hosting, backups, email relay and the domain still have real operational costs and remain separate choices.

## Account admission and recovery

Google uses minimal OpenID/email/profile access. Require a verified identity and the same server-enforced invite rule as email/password. A02 must prevent a social callback from bypassing beta admission and define safe account linking when one email is used through both methods.

Email/password requires verification and reset delivery through a server-side mail transport. Select and test an SMTP relay/provider before public access; no mail service is purchased or contacted by this decision. Use expiring single-use password-reset links and generic recovery responses that do not expose account membership. Verification marks an email idempotently and does not automatically create a session. Do not turn off verification to make a deployment appear complete.

Use Better Auth's password/session primitives, secure production cookies, allowed origins, session expiry and server-side role/ownership checks. A browser wallet or local demo receipt must never establish identity, a starting grant or verified backing history.

## Configuration and migration ownership

`.env.example` documents the proposed server-only values. Local, staging and production use separate databases, OAuth credentials, session secrets and mail settings. Register exact callback URLs for each environment; production requires HTTPS. Do not prefix credentials with `NEXT_PUBLIC_`, commit populated `.env` files, or paste them into issues/logs.

Generate the Better Auth schema through its supported generator, review it with the domain schema, and apply all migrations through Drizzle Kit. Do not run a second independent auth migration runner against the same schema. Never rewrite a migration already applied to staging/production. An implementation PR owns each migration, its CI test and recovery notes; the maintainer verifies it in staging before release.

A01 provides an empty-database setup, migration tests and opt-in isolated demo seeds. A02 provides sign-in/out, admission, verification/reset, cookie and cross-user authorization tests. A03 adds the exactly-once 1,000-Credit grant after identity exists. F04 still gates the production backing economy. O01/O02 own hosting, secret injection, backups and restore rehearsals. No Redis or additional hosted service is required initially.

## References

- [PostgreSQL version support](https://www.postgresql.org/support/versioning/).
- [Drizzle PostgreSQL drivers](https://orm.drizzle.team/docs/get-started-postgresql).
- [Better Auth Drizzle adapter and migrations](https://better-auth.com/docs/adapters/drizzle).
- [Google provider and redirect setup](https://better-auth.com/docs/authentication/google).
- [Email/password, verification and recovery](https://better-auth.com/docs/authentication/email-password).
- Package metadata: [Better Auth](https://registry.npmjs.org/better-auth/1.7.21), [Drizzle ORM](https://registry.npmjs.org/drizzle-orm/0.45.4), [Drizzle Kit](https://registry.npmjs.org/drizzle-kit/0.31.11), [pg](https://registry.npmjs.org/pg/8.23.1), [adapter](https://registry.npmjs.org/@better-auth/drizzle-adapter/1.7.21).
