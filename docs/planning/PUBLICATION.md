# Publication status

Prepared 2026-11-12. Target: public `ayadebbagh/first-press`.

[Public repository](https://github.com/ayadebbagh/first-press) created and verified. Its initial README commit is `f0c10d483e23b65f3fa19a7aa07fbbe9c1fca99f`.

GitHub connector write access was restored and verified on 2026-11-12. All [43 planning issues](https://github.com/ayadebbagh/first-press/issues) are published: 6 epics and 37 actionable tasks. Live issue numbers and URLs are recorded in `github-state.json`; generated issue documents link dependencies to the actual GitHub issues.

The [source commit](https://github.com/ayadebbagh/first-press/commit/2a5a63989c888d85f71373f99d92c96f32843ae2) is published. All [four milestones](https://github.com/ayadebbagh/first-press/milestones) and 11 planned labels were created and all 43 issues have milestone assignments. The [Planning metadata run](https://github.com/ayadebbagh/first-press/actions/runs/43282396565) passed; it creates/reuses milestones and reconciles issue membership using GitHub's repository-scoped workflow token.

An account-level Projects board has not been created: the connected GitHub tools do not expose Projects creation, and CLI authentication is unavailable. With normal authenticated GitHub CLI access plus Projects scope, `pnpm project:sync -- --apply --repo ayadebbagh/first-press` can create/reuse and populate the linked Project. Status options, views, automation and main-branch protection still require F03 verification. The sync defaults to a dry run and preserves existing issue bodies and progress.

Local verification on 2026-11-12: typecheck, all 21 existing tests, production build, preview build and backlog validation passed. YAML syntax and local Markdown links passed. The [first hosted CI run](https://github.com/ayadebbagh/first-press/actions/runs/43282396592) also passed its clean frozen install, typecheck, tests, production build, preview build and Docker HTTP smoke test. The container served health, root/discovery, catalog and favicon routes and returned 404 for an invalid route. This is HTTP/container verification, not full browser interaction or hydration coverage. F02 was completed in [PR #46](https://github.com/ayadebbagh/first-press/pull/46), with [16 passing isolated desktop/mobile browser checks](https://github.com/ayadebbagh/first-press/actions/runs/43287769563) and all 50 artist pictures verified. The additional B01 bug (#45) is also complete, bringing the tracked plan to 44 issues. F03 still tracks Project views/workflows and repository protections.

Future collaborator preference: Admin access, username/timing to be supplied later. No invitation sent. Browser interaction stopped so the founder can use Brave independently.

The website itself is not deployed. Self-hosting destination/domain remain undecided.
