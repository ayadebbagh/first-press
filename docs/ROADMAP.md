# Delivery roadmap

This plan is dependency-driven, not a promise of dates. Effort is relative: S is a focused small change, M spans several components, L needs a technical slice and integration testing. Split L issues before committing to a short development cycle. Estimates exclude provider approvals and unknown data access work.

| Milestone | Outcome | Exit gate |
| --- | --- | --- |
| M0 — Reproducible foundation | Published repository, runnable CI, real-server QA and resolved backend/economy choices | Clean frozen install/build; hosted HTTP/container smoke run; reviewable architecture and settlement spec |
| M1 — Connected artist backing | Real accounts and a transactional backing loop in staging | Exactly-once starting grant; buy/cancel/sell/settle; owned API reads; concurrency and authorization tests; demo balances cannot become real balances |
| M2 — Trusted invite-only beta | Traceable artist data, verifiable receipts and operated self-hosting | Eligible baselines and stale controls; audited curation; receipt privacy; HTTPS; tested restore; observability; accessibility/mobile/end-to-end checks; no open critical defects |
| M3 — Daily habit and reputation | Community daily rotation, recognition and decided recurring Credits | Connected comparison design; provider-use clearance; server vote/guess locks; honest low-data results; audited badge/grant rules |

M3 is not a prerequisite for the core artist-backing beta. The M2 source can start with admin-verified imports if automated collection has not cleared access and reliability gates. If live provenance is unresolved, release only a clearly labeled demo without claiming live backing or verified proof.

## Critical path

F01 backend decision + F04 economy contract → A01 schema → A02 sessions → A03 ledger → A04/A05 queued orders → A06 settlement → A07 connected UI → R01 receipts → O04 release verification.

In parallel: C01 artist identity → C03 source investigation and C04 snapshot validation → C05 source adapters → C06 twice-daily scheduling → C08 correction rehearsal. C07 admin enables controlled admission and corrections. Eligible accepted snapshots are necessary for A06 integration; synthetic fixtures are sufficient while developing domain logic, never for live claims.

Operations can begin alongside the backend: O01 staging/self-hosting → O02 restore and O03 monitoring. R02/R05 settle profile privacy and deletion; O06 handles media/license review before wider publication of assets.

## First two development cycles

Cycle 1: F01, F04, F02 and C01. Run C03 as a bounded research spike. Confirm architecture, actual HTTP behavior and source feasibility before growing infrastructure. F03 records GitHub guardrails once CI exists.

Cycle 2: A01, A02, C04 and C02. Then A03 and the buy/cancel vertical slice, using controlled snapshots. Demonstrate one server-backed flow before implementing every screen. Move work into Ready only after its decisions and dependencies are satisfied.

## Release process

Choose a commit; confirm checks; run migrations in staging; complete the issue's acceptance scenarios; create a release note with known limits; verify backup/restore and rollback compatibility; then deploy through the documented self-host workflow. Do not enable daily content, recurring grants or automation merely because their UI exists. Keep production deployment separate from repository publication.
