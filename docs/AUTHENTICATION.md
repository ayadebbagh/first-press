# Invite-only identity (A02)

A connected identity is separate from the local-storage demo. Account creation does not grant Credits, import browser balances, or publish verified receipts. A03 supplies the [server ledger](LEDGER.md) and explicit initialization endpoint; A04 adds the [connected buy/cancel panel](BUY-ORDERS.md) on `/account`. Exits, settlement and the full portfolio remain A05–A08 work. `/account` and `/reset-password` are independent app screens; demo discovery stays available when accounts are disabled.

## Enable on an isolated host

Apply the committed migrations with the A01 wrapper first. Provide `DATABASE_URL`, a canonical `BETTER_AUTH_URL` origin, a separate random `BETTER_AUTH_SECRET` of at least 32 characters, and `FIRST_PRESS_AUTH_ENABLED=true`. An empty/missing flag disables auth handlers with 503 and shows an explanatory account screen. Invalid configuration fails closed. HTTP is accepted only on loopback; a public host requires HTTPS.

Google is optional per host. Supplying both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` enables the Google button. Register exactly `<BETTER_AUTH_URL>/api/auth/callback/google` as the Web application redirect URI in Google Cloud. Request only the normal OpenID/email/profile scopes; no Spotify account is involved. Credentials and consent-screen configuration must be supplied by the operator; code and fixture tests do not establish that a real Google project is configured.

The browser uses Better Auth's same-origin HTTP client. The server mounts its handler at `/api/auth/[...all]`; no Server Actions or cookie-only proxy establishes authorization. The explicit URL prevents forwarded-host inference. Cookie cache is disabled so revoked sessions are checked against PostgreSQL. Sessions expire after seven days, refresh after a day of use, and have a fifteen-minute freshness interval for sensitive library operations. HTTPS cookies are Secure, HttpOnly and SameSite=Lax. No cross-subdomain cookie scope is enabled. Better Auth's origin, OAuth state/PKCE and CSRF controls remain enabled.

## Admission and administration

Invites are email-bound, expire after seven days and admit one user ID. The SQL trigger locks the invite and creates the default **member** record in the same transaction as the auth user. Better Auth's Drizzle adapter enables transactions, so a failed credential/account write rolls admission back. A before hook returns a generic registration response for unavailable email admission; the database is the final gate for both email and social creation. A database marked `demo` cannot admit accounts. Neither an invite nor a claimed email gives admin access.

Use a release checkout with a private database operator credential for initial admission. Commands read process environment; the local-file form is:

```sh
node --env-file=.env scripts/auth/manage.mjs invite --email YOUR_EMAIL --actor OPERATOR_NAME --reason 'Founder beta admission'
```

The command records an invite and audit event; **it sends no invitation email**. Tell an invited member to visit `/account` through your normal beta onboarding. After the founder creates and verifies their account, promote that member explicitly:

```sh
node --env-file=.env scripts/auth/manage.mjs member --email YOUR_EMAIL --role admin --actor OPERATOR_NAME --reason 'Founder administration'
```

`--status suspended` disables member access; `--status active` restores it. `invite --revoke` withdraws an unclaimed invitation; it does not suspend an existing member. Reissuing an unclaimed invite renews its seven-day window. Role/status changes revoke all sessions immediately through PostgreSQL. Member/admin changes require an actor and reason in an append-only audit record. The private operator role is not a member-facing API and must remain restricted.

Authenticated admins can POST `{ "email": "...", "reason": "..." }` to `/api/admin/invites`. This creates a seven-day invite without sending mail. It is protected by a fresh server session lookup, member role, same-origin write check and a database-backed per-admin limit. There is no public admin promotion or arbitrary balance editor.

## Verification, recovery and linking

Email passwords require at least twelve characters and use Better Auth's built-in hashing. Email sign-up never creates a session automatically. A short-lived verification link marks the address verified; sign-in is still explicit. Verification is idempotent (reopening an already-used link does not mint a session). Resending on an unverified sign-in supplies a new thirty-minute window. Do not disable verification to work around mail configuration.

Password recovery responses are generic for known and unknown emails. Thirty-minute reset tokens are consumed once and successful resets revoke old sessions. Recovery can establish an email password for a Google-first account after proving access to that same mailbox. Reset tokens, passwords, provider tokens and email URLs must never appear in logs or telemetry; scrub query strings on authentication/recovery routes in reverse-proxy access logs. Pages use a no-referrer policy and are not indexable.

Implicit same-email social linking is disabled. An existing email member must sign in first and explicitly connect Google on their account screen. Different-email linking is disabled, and local/provider verified-email requirements remain enabled. A forged ID token or an unverified provider email cannot establish a usable session. Do not treat an email string from a client request as a verified Google claim.

If a member loses access to their verified mailbox and Google identity, automatic recovery cannot establish ownership. Suspend access if compromise is suspected and record an admin review. Screenshots, localStorage, a public username or an asserted wallet amount are not ownership proof. No manual account merge, email replacement, duplicate starting grant or transfer of positions is implemented. Define any exceptional recovery procedure before relying on persistent backing; keep history and ledger retention/privacy work under R02/R05.

## Durable email outbox and SMTP

Auth callbacks enqueue verification/reset mail in PostgreSQL. This keeps SMTP timing and availability outside the authentication response path. The worker sends only queued, unexpired rows, claims them with SKIP LOCKED, uses leases after crashes and retries up to five times with backoff. Failed/expired and delivered rows have their token-bearing body removed. SMTP failures never log recipients, credentials or links. Monitor queue age, failed rows and worker liveness before admitting real members.

The mail worker uses Nodemailer with verified TLS: port 465 uses immediate TLS; other valid ports require STARTTLS. There is no plain-text or certificate-verification bypass. Supply `SMTP_HOST`, `SMTP_PORT`, `AUTH_EMAIL_FROM` and the relay's `SMTP_USER`/`SMTP_PASSWORD` to the worker, then run it under your process supervisor:

```sh
node --env-file=.env.mail scripts/auth/mail-worker.mjs
```

The web service needs database access to enqueue mail; it does not need SMTP credentials. The worker needs its own scoped database/SMTP credentials. Install the pinned dependencies in a release checkout; the standalone web container does not contain this separate worker entry point yet. Add its supervised production container and readiness/queue alerts in O01/O03. No email provider has been purchased or contacted. Real relay delivery, domain SPF/DKIM/DMARC and a live Google sign-in remain operator rollout checks.

## Authorization boundaries

`requireMember` verifies the database session, verified email and active membership. `requireAdmin` additionally reads the server-owned role. Future wallet/order mutations must call these guards inside their domain authorization/transaction path; a client user ID or browser wallet never grants access.

| Endpoint | Authority |
| --- | --- |
| GET/PATCH `/api/account/profile` | Current member only; PATCH accepts display name/privacy preference, never ID, role or status; same-origin and per-member write limit. No public profile is published by this preference. |
| GET `/api/account/wallet` | Current member's wallet only; exact amounts are strings, and missing wallet is NULL until explicitly initialized through the A03 POST endpoint. Query-string user IDs are ignored. |
| GET `/api/account/orders/:id` | Lookup requires both order ID and current member ID; other members and unknown IDs get the same 404. |
| POST `/api/admin/invites` | Active admin session, same origin and per-admin rate limit; actor comes from the session. |

Private responses have `Cache-Control: private, no-store`. There are no public wallet/order write endpoints in A02. Auth throttles use Better Auth's database storage; profile/admin writes use atomic PostgreSQL counters. Counters survive multiple web processes/restarts. By default all unauthenticated clients share a bucket because Next.js route handlers cannot independently attest the peer address. At a private reverse proxy, set `AUTH_TRUSTED_IP_HEADER` only to a header it overwrites and prevent direct public access to the app. Never trust arbitrary client `X-Forwarded-For`; apply proxy-level network throttles and monitoring as part of production setup. Expired throttle/outbox metadata retention is an operations task; do not retain token payloads in backups longer than needed.

## Verification scope

The auth suite uses an explicit disposable `_auth_test` PostgreSQL database and no application credentials. Core tests exercise actual Better Auth handlers, Drizzle transactions, signed cookies, verification/reset records, admission/revocation triggers and persistent throttles. Google tests use a local RSA signing/JWKS fixture with the real Google adapter's signature/issuer/audience/expiry validation; they do not call Google or prove external consent-screen setup.

Isolated browser tests run the actual Next.js production server, PostgreSQL, the real outbox worker and a loopback SMTP fixture using STARTTLS and a test CA trusted only by the test process. They verify registration → delivered verification → sign-in → owned API/profile response, recovery/session revocation, and cross-member/admin/origin rejection at desktop and 320px mobile widths. No test bypass endpoint is exposed by the app; SMTP capture/control exists only in the test fixture process. Existing demo tests remain independent.

References checked 2026-11-12: [Better Auth email/password](https://better-auth.com/docs/authentication/email-password), [Google provider](https://better-auth.com/docs/authentication/google), [account linking](https://better-auth.com/docs/concepts/users-accounts), [database hooks](https://better-auth.com/docs/concepts/database), [rate limits](https://better-auth.com/docs/concepts/rate-limit), [Nodemailer SMTP](https://nodemailer.com/smtp). Pinned 1.7.21 package source was inspected where the current docs differ.
