# Development backlog

Generated from [backlog.json](backlog.json). 6 epics and 37 actionable tasks. Relative effort is not a delivery-date estimate.

Read [the roadmap](../ROADMAP.md) for sequencing and release gates. Live publication status is in [PUBLICATION.md](PUBLICATION.md).

## M0 — Reproducible foundation

Repository, CI, real-server testing and resolved backend/economy choices.

| Key | Issue | Priority | Effort | Depends on |
| --- | --- | --- | --- | --- |
| F01 | [Decide the self-hosted database and authentication approach](issues/F01.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/7) | P0 | S | — |
| F02 | [Run isolated browser tests against the actual Next.js server](issues/F02.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/8) | P0 | M | — |
| F03 | [Verify repository, Project workflows and collaborator onboarding](issues/F03.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/9) | P1 | S | — |
| F04 | [Specify Credit precision, order eligibility and settlement rules](issues/F04.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/10) | P0 | M | — |
| C01 | [Verify canonical identities for the 50-artist shortlist](issues/C01.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/11) | P0 | M | — |
| C03 | [Investigate listener collection access, reliability and cost](issues/C03.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/13) | P0 | M | C01 |
| O06 | [Review media redistribution and select the source-code license](issues/O06.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/37) | P0 | S | — |

## M1 — Connected artist backing

Authenticated, persistent and transactional artist backing in staging.

| Key | Issue | Priority | Effort | Depends on |
| --- | --- | --- | --- | --- |
| C02 | [Resolve pending recordings and preserve version provenance](issues/C02.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/12) | P1 | M | C01 |
| C04 | [Add immutable listener snapshots and validation](issues/C04.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/14) | P0 | M | A01, C01 |
| A01 | [Create PostgreSQL schema, migrations and isolated seed data](issues/A01.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/19) | P0 | M | F01, F04 |
| A02 | [Implement invite-only sessions and authorization](issues/A02.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/20) | P0 | M | A01 |
| A03 | [Create an auditable Credit ledger and exactly-once starting grant](issues/A03.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/21) | P0 | M | A02 |
| A04 | [Implement server-backed buy reservations and cancellation](issues/A04.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/22) | P0 | M | A03, C04 |
| A05 | [Implement queued partial/full exits and quantity reservations](issues/A05.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/23) | P0 | M | A04 |
| A06 | [Settle eligible orders transactionally at accepted snapshots](issues/A06.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/24) | P0 | L | A05, C04, F04 |
| A07 | [Connect portfolio and artist backing screens to owned APIs](issues/A07.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/25) | P1 | M | A06 |
| A08 | [Test ledger invariants, authorization and settlement concurrency](issues/A08.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/26) | P0 | M | A06 |

## M2 — Trusted invite-only beta

Traceable data, verified receipts, safe operations and release QA.

| Key | Issue | Priority | Effort | Depends on |
| --- | --- | --- | --- | --- |
| C05 | [Implement verified import and the selected listener adapter](issues/C05.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/15) | P0 | M | C03, C04 |
| C06 | [Schedule twice-daily collection and durable settlement jobs](issues/C06.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/16) | P0 | M | C05, A06 |
| C07 | [Build audited catalog admission and artist-request administration](issues/C07.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/17) | P1 | M | A02, C04 |
| C08 | [Rehearse stale-data and bad-snapshot corrections](issues/C08.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/18) | P0 | M | F04, C04, A06 |
| R01 | [Issue server-verifiable early-support receipts](issues/R01.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/27) | P0 | M | A07, C04 |
| R02 | [Define and implement pseudonymous public profiles and sharing](issues/R02.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/28) | P1 | M | R01, R05 |
| R03 | [Persist watchlists and member artist suggestions](issues/R03.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/29) | P1 | M | A02, C07 |
| R04 | [Build onboarding and clear freshness/pending-state explanations](issues/R04.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/30) | P1 | M | A07, C05 |
| R05 | [Implement privacy, retention, export and account deletion policy](issues/R05.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/31) | P0 | M | A02 |
| O01 | [Provision an isolated self-hosted staging environment](issues/O01.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/32) | P0 | M | F01, A01 |
| O02 | [Test database backups, restore and release recovery](issues/O02.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/33) | P0 | M | O01, A06 |
| O03 | [Add operational visibility and failure controls](issues/O03.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/34) | P0 | M | O01, C06 |
| O04 | [Complete invite-beta end-to-end, accessibility and abuse verification](issues/O04.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/35) | P0 | L | F02, A08, R01, R03, R04, R05, C06, C08, O02, O03, O06 |
| O05 | [Define first-party beta analytics and the pilot feedback loop](issues/O05.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/36) | P1 | S | R04 |

## M3 — Daily habit and reputation

Community rotation, badges and decided recurring Credits.

| Key | Issue | Priority | Effort | Depends on |
| --- | --- | --- | --- | --- |
| D01 | [Design connected daily matchups and global ranking rules](issues/D01.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/38) | P0 | M | — |
| D02 | [Resolve Spotify content use for the public daily mechanic](issues/D02.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/39) | P0 | S | — |
| D03 | [Persist daily rotations, vote assignments and locked predictions](issues/D03.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/40) | P1 | M | D01, D02, A02, C07 |
| D04 | [Publish community ranking results honestly](issues/D04.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/41) | P1 | M | D03 |
| D05 | [Define and implement credible early-backer badges](issues/D05.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/42) | P1 | M | R01, C08 |
| D06 | [Decide and implement recurring Credit top-ups](issues/D06.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/43) | P2 | M | A03, A08 |

## Epics

- [[Epic] Foundation and delivery](issues/E01.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/1)
- [[Epic] Accounts, ledger and backing](issues/E02.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/2)
- [[Epic] Music data and catalog](issues/E03.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/3)
- [[Epic] Discovery, receipts and identity](issues/E04.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/4)
- [[Epic] Daily rotation and reputation](issues/E05.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/5)
- [[Epic] Self-hosting, quality and beta release](issues/E06.md) · [GitHub](https://github.com/ayadebbagh/first-press/issues/6)
