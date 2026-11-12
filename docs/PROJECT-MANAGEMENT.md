# Project workflow

The repository is the source of truth for code and issues. GitHub Projects is the view of the work. Planning files do not imply a live board exists: check PUBLICATION.md for observed URLs and setup status.

## Backlog and board

Six epics group 38 actionable issues. Each task has a stable key, acceptance criteria, dependency keys, milestone, priority and relative effort. Do not assign all work immediately. Leave ownership open until someone takes it; do not invite collaborators automatically.

Desired workflow: Backlog → Ready → In progress → In review → Done; use Blocked when an external dependency prevents progress. On a newly created GitHub Project, default Status options may be Todo / In Progress / Done; configure the desired options in its settings. The bootstrap script preserves existing statuses rather than replacing them. Native issue closure should move linked project items to Done once the built-in workflow is verified.

Suggested views: Board grouped by Status; Backlog table grouped by milestone sorted by priority; Roadmap by milestone only after real dates are chosen. Fields: Priority (P0/P1/P2), Effort (S/M/L), Workstream, and built-in Milestone. Labels carry the same priority/workstream for issue filtering. Epics are navigation issues, not a second set of acceptance work.

P0 = integrity or release gate for its milestone; P1 = core planned behavior; P2 = enhancement. A later-milestone P0 does not displace the current milestone. One In progress issue per developer; keep Ready to a small selection. Blocked items name the blocker, owner and next action rather than silently waiting.

## Ready and Done

Ready means the user outcome and boundaries are clear, dependencies are complete, decisions resolved, acceptance criteria testable and the work fits a reviewable slice. A foundation decision/spike can be Ready without an implementation dependency.

Done means implementation merged, acceptance criteria met, relevant checks passed, meaningful failures tested, docs and migrations updated, and observable behavior reviewed. An API stub, a mocked test or a configured workflow alone does not meet a release gate. Close an epic only after all its children satisfy their own criteria.

## Working rhythm

At the start of a short cycle choose a coherent vertical outcome, then the smallest Ready issues that deliver it. Once a week, review new bugs/suggestions, blocked dependencies, data freshness, costs and pilot feedback; choose the next Ready set. Record decisions in DECISIONS.md and link them from the issue. Add estimates only after technical slicing; do not assign speculative calendar dates.

PRs link issues and show verification. Bug reports capture the browser/build, reproduction and expected/actual result. Changes to economy, metric source or proof semantics require updating their versioned specification before implementation. Revisit scope against PRODUCT.md rather than accumulating unbounded features.

## Automation and maintenance

CI runs type checks, tests, production build and preview build; main/manual runs also perform container HTTP smoke checks. Dependabot is configured weekly with limited open PRs. The Planning metadata workflow uses GitHub's repository-scoped workflow token to reconcile planned labels, milestones and issue membership when the backlog changes. It cannot create an account-level Projects board. No deployment automation, personal credentials, branch protections or project workflows are assumed enabled without verification.

`pnpm project:check` validates backlog keys, dependencies and cycles. `pnpm project:render` regenerates BACKLOG.md and issue-body files. `pnpm project:sync` previews setup. With normal `gh` authentication and the `project` scope, `pnpm project:sync -- --apply --repo ayadebbagh/first-press` creates/reuses labels, milestones, issues and a linked Project. It preserves existing issue bodies/progress. It does not create/push the repository, purchase services, invite people or deploy the app. Live IDs are kept in `github-state.json`; keep that file after publication and commit it.

Use `--metadata-only` to omit account-level Projects operations. Existing issue discussion, states and nonempty milestone choices are preserved. Auto-created labels with empty descriptions are filled with the planned description/color; existing customized descriptions are retained.

Project field/view/automation setup and repository protections are explicit verification tasks (F03), not implied by the script. A token with repository access may still lack Projects scope; keep already-created issues and resume after normal authorization rather than recreating them.
