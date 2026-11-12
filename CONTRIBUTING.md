# Working on FIRST PRESS

Use Node 22.13+ and the pnpm version in `package.json`. Install with `pnpm install --frozen-lockfile`; run `pnpm dev`. `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm build:preview` are the baseline checks. See `SELF-HOSTING.md` for production commands and `QA.md` for observed testing limitations.

Work from `main` in short branches such as `feat/23-queued-orders` or `fix/42-cancel-race`. Pick one Ready issue at a time, move it to In progress and keep its scope small enough to review. Use a draft PR early when the design needs discussion. Include `Closes #number` only when all acceptance criteria are met.

A PR should explain the user-visible result, relevant tradeoffs, verification and remaining limitations. Include desktop/mobile screenshots for visual changes. Ledger, authorization, settlement and data-validation changes need tests of failure and concurrency paths. Reversible copy/style edits do not need implementation-mirroring tests.

Before merge: checks pass, no secrets or generated output, acceptance criteria satisfied, and affected docs updated. Prefer squash merges. When another maintainer is available, request their review; do not claim a review happened when working solo. Branch protection should be enabled after the check names exist and repository-plan support is confirmed. It is not configured by these files.

Keep one schema migration per coherent change. Never rewrite a migration already applied to a shared environment. Include recovery notes before changing live data or accounting rules. Production deployment remains a separate, explicit release operation.

No license grant is currently included. Do not assume bundled artist artwork is licensed for redistribution simply because its source is attributed.
