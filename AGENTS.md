# FIRST PRESS development guidance

Read `docs/PRODUCT.md`, `docs/DECISIONS.md` and the issue before changing behavior. User decisions override proposals. Keep these documents current when decisions change.

- Use Next.js App Router, React, TypeScript and pnpm. Preserve self-hosted standalone/Docker support. Add services only for a demonstrated need.
- The primary product is artist backing and credible early-support history. The daily game is secondary. Preserve the editorial, responsive app layout.
- Clearly distinguish synthetic local-demo data from server data. Client storage must never authorize server Credits, settlement, identity or verified receipts.
- Spotify is the default for confirmed tracks. SoundCloud requires an explicitly reviewed Spotify absence. Playback errors and geographic restrictions do not establish absence or recording equivalence.
- Live accounting requires server authorization, transactions, idempotency, precise units and an audit trail. Failed collection never means zero listeners. Preserve source and observation provenance.
- Keep private keys, `.env` files, local tool state, generated previews and build output out of commits. Do not add unapproved paid services or send provider outreach as part of implementation.
- Link changes to issues. Run relevant tests and `pnpm typecheck`; run the production build for routing/build/config changes. Describe limitations honestly. Browser testing a file preview does not verify Next.js HTTP behavior.
- Update the backlog through `docs/planning/backlog.json`, then regenerate with `pnpm project:render`. Do not overwrite live issue discussion or progress with a planning script.
