# Development Project

F03 [issue #9](https://github.com/ayadebbagh/first-press/issues/9), verified 2026-11-17 UTC: [FIRST PRESS — Development](https://github.com/users/ayadebbagh/projects/2) is a **private**, personal-account Project owned by `ayadebbagh`, linked to the public `ayadebbagh/first-press` repository. Unrelated untitled Project 1 was left untouched. Privacy is intentional; a public repository does not make this planning board public or grant another person access.

The Project contains all 47 repository issues, including epics and the B01/B02/B03/C09 follow-ups; no pull requests or draft cards were imported. Priority (P0/P1/P2), Effort (S/M/L) and Workstream (foundation/backing/data/identity/daily/operations) come from [backlog.json](backlog.json). Exact Project, field, option, view and workflow IDs are in [github-state.json](github-state.json). Existing issue bodies, comments, states, assignees, labels and milestones were preserved.

## Status selection

Status order is Backlog, Ready, In progress, In review, Blocked, Done. Closed repository issues are Done. Epics stay in Backlog until someone actively coordinates them; an epic is not Ready just because its own dependency list is empty.

Ready requires every declared dependency's **live issue** to be closed and no unresolved product, provider, operational or privacy decision. Initially C01 (#11) and C07 (#17) qualified. A06 (#24) became Ready after A05 (#23) closed; its other dependencies C04 (#14) and F04 (#10) were also read back closed. A06 phase 1 then started, so #24 is now In progress alongside F03 (#9). A05 moved through In progress and In review before its real closure. Other work waiting on implementation dependencies stays in Backlog.

Unresolved decisions block C03, R02, R05, O01, O06, D01, D02, D05 and D06. R05 and O01 need decisions despite their source `decision` flag being false; their live acceptance criteria and DECISIONS.md govern. C08's correction policy is accepted, so its remaining implementation dependency keeps it in Backlog. Closed F01/F04 retain their historical decision labels without becoming blocked again. The recorded `decision_blocked_keys` and initial status hints are reviewed planning inputs, not automatic interpretations of issue discussion. Update them when the founder resolves a decision.

Move active work to In progress when implementation starts and In review when review begins. Preserve human triage on subsequent syncs. Never infer completion from a checked local acceptance box, linked PR, or demo behavior.

## Views and repository metadata

[Backlog table](https://github.com/users/ayadebbagh/projects/2/views/1) shows every imported item with Title, Status, Priority, Effort, Workstream, Assignees, Labels and Milestone. Its filter is empty, so completed work remains inspectable. [Status board](https://github.com/users/ayadebbagh/projects/2/views/3) shows the same issue set with **Status as its explicit columns**. Both layouts and visible fields were read back through GraphQL. Status columns were configured using the supported REST `vertical_group_by` field and independently read back as GraphQL `verticalGroupByFields = Status`.

Current GraphQL `createProjectV2View`/`updateProjectV2View` support name, layout and visible field configuration; update additionally accepts a filter. Introspection showed no grouping input. The REST create-view API supports explicit board columns. An intermediate ungrouped board created during verification was deleted from this new Project; the final Project has only the two views above.

The repository's four milestones M0–M3 express release sequencing. `area:*` labels identify workstreams; `priority:P*` labels express priority; `epic` marks tracking issues and `needs:decision` marks decision work. These repository values are displayed directly rather than copied into editable project-only substitutes. This Project operation did not rewrite their live values.

## Automation evidence

All six built-in workflows read back enabled: Item closed, Pull request merged, Auto-close issue, Auto-add sub-issues to project, Pull request linked to issue, and Item added to project. The API exposes workflow name, ID and enabled state, but does not expose their trigger/action configuration. [GitHub documents](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations) closed-to-Done and merged-to-Done as defaults; enabled flags alone do not prove either action.

A real closure proved **closed issue → Done**: item `PVTI_lAHOBtkNQs4Br8Z-zhJWcpA` for #23 was OPEN / In review at `2026-11-17T01:58:42Z`. [PR #59](https://github.com/ayadebbagh/first-press/pull/59), commit `730dbf9cfc3135860f5a81d9cbdb80d9001e3d80`. The issue closed at `01:59:09Z`; its Status changed to Done at `01:59:12Z`. The subsequent API readback confirmed CLOSED / Done. No Project status mutation occurred between that final baseline and the readback. Previously closed issues were explicitly initialized Done during import; that initialization is not automation evidence.

Other workflow behavior was not exercised. In particular, changing an open issue to Done may close the issue because Auto-close issue is enabled; do not use Done as a review shortcut. No auto-add repository filter was configured or claimed verified. Run the CLI below when adding repository issues, and review any workflow changes separately.

## Repeatable item sync

Use normal authenticated `gh` with Projects scope; credentials stay in the CLI's normal credential store. Do not put tokens in this repository or workflow secrets for this manual planning operation.

```sh
node scripts/project-board-sync.mjs          # offline dry run
node scripts/project-board-sync.mjs --check  # read-only live comparison
node scripts/project-board-sync.mjs --apply  # reconcile Project items only
```

The script pins the saved private Project identity and repository link, checks field IDs/options and issue mappings before writing, paginates repository issues and project items, excludes PRs, and reuses existing item IDs. It fills Priority/Effort/Workstream, initializes missing statuses, preserves active open-item triage, demotes an invalid Ready selection, and converges closed issues to Done. An open or reopened issue with stale Done status is reset to a reviewed non-Done initial hint or an eligible Ready/Blocked/Backlog fallback; a Done hint is ignored, including for a newly imported open issue. Unknown/unmapped issues stop the operation so they can be added deliberately through backlog.json and github-state.json, then regenerated with `pnpm project:render`. It does not create projects, change workflow/settings/access, edit issue content, or change issue states. An interrupted run can be repeated. Review status hints when triage or decisions change.

`pnpm project:sync -- --apply` remains the broader repository metadata publisher: it can create issues/labels/milestones and then delegates its Project item phase to the same helper. Use the narrow script for ongoing Project-only work. The installed `gh project item-edit` supports `--url`, `--field` and `--value`. The helper uses identity-pinned GraphQL project, item, field and option IDs to validate its target and reconcile fields consistently.

## Repository operations and later transfer

The repository was independently verified public with founder Admin, default Actions token permission read and `can_approve_pull_request_reviews=false`, and weekly npm plus Actions Dependabot updates. Main-branch protection requires the five passing CI contexts from `ci.yml`: `Types, tests and builds`, `PostgreSQL migrations and constraints`, `Connected identity and recovery`, `Credit ledger concurrency and reconciliation`, and `Settlement batch preparation and recovery`. Checks are pinned to GitHub Actions app 15368. Protection applies to admins, requires PRs and resolved conversations, dismisses stale reviews, and disables force pushes/deletions. Required approving review count is temporarily zero: collaborator onboarding is still pending and requiring another person's approval would block the sole current maintainer. Revisit that count after accepted collaborator access. API readback confirmed the saved protection. [PR #59](https://github.com/ayadebbagh/first-press/pull/59) merged with all four required checks green; its [five-job preflight](https://github.com/ayadebbagh/first-press/actions/runs/43998619701) and [post-merge main CI](https://github.com/ayadebbagh/first-press/actions/runs/43999614989) also passed, including the container HTTP smoke test.

The founder's planned organization is `first-press-app`, intended destination `first-press-app/first-press`, with repository Admin for `TawfiqAbubaker`. No organization creation, transfer, invitation or collaborator access change occurred. Follow [REPOSITORY-TRANSFER.md](../REPOSITORY-TRANSFER.md) later. A repository transfer does not transfer this separately owned personal Project: create/reconnect an organization Project when authorized, preserve item/status evidence, and update the saved owner/IDs/repository mapping before any sync. Repository Admin and organization Owner remain distinct roles; access must be verified after acceptance.
