# FIRST PRESS — beta

An underground music discovery and artist-backing app, now built with **Next.js 16, React 19, TypeScript and pnpm 11**. The original editorial design and product mechanics are preserved. The app is prepared for self-hosting through Next.js standalone output and Docker; it is not deployed to a server yet.

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

Use Node.js 22.13+ and the pnpm version pinned in `package.json`. See [SELF-HOSTING.md](SELF-HOSTING.md) for Node and Docker deployment commands and observed environment limits.

For isolated browser tests, run `pnpm exec playwright install chromium`, `pnpm build`, then `pnpm test:e2e`. These launch a separate headless browser and production server on port 3100, using fresh test storage for every case. They do not control Brave or load a personal browser profile. CI installs the matching Chromium build and keeps screenshots/reports and failure traces for seven days. Provider embeds are stubbed in these deterministic app tests; actual third-party audio availability remains a separate integration check.

`pnpm build:preview` creates `FIRST-PRESS-preview.html`, a file-open QA companion built from the same React components using Next.js’s pinned compiler. It uses a hash-navigation adapter and embeds the artwork. It does not replace the self-hosted Next.js server or verify HTTP routing. Internet is required for playback and optional fonts.

## Structure

- `src/app`: Next.js App Router, layout, route validation and health endpoint.
- `src/views`: discovery, catalog, artist detail, collection, daily rotation and receipts.
- `src/components`: reusable layout, artist cards, dialogs and provider players.
- `src/state`: typed React state, local persistence and navigation adapters.
- `src/engine.ts`: tested pure Credit reservation, settlement and portfolio rules.
- `src/playback.ts`: Spotify-first source selection and reviewed SoundCloud fallback.
- `public/assets`: 50 bundled artist/profile images; attribution in `ASSET-SOURCES.json`.

## Beta behavior

50 curated artists and 100 discovery tracks. Users start with 1,000 demo Credits, can watch artists, queue artist-only buys and sells, cancel pending orders, settle the next synthetic update and keep entry receipts after selling. Backing value moves proportionally with illustrative listener figures. Artist pages include inspectable monthly-listener history with 7/30/90-day views; this history is explicitly generated demo data until collected snapshots are connected. The daily rotation has four votes, a reorderable prediction and an explicitly illustrative crowd ranking. Artist suggestions stay on the device.

State keeps the original `firstpress.beta.v1` key so the existing file-preview data remains usable. Storage is browser/origin-specific: opening a newly hosted origin does not import another origin’s local data automatically.

## Boundaries

All listener baselines and movements remain synthetic. Selection is an editorial shortlist, not a measured top-50/top-100 chart. There are no connected accounts, shared database, live stats collector, public verified receipts, global votes, request delivery or server-controlled Credits yet. The migration changes the application foundation; these connected features still need implementation.

Current verification results are in [QA.md](QA.md). Generated previews, build output and checkout-local archives are excluded from version control.

## Development plan

Start with the [product scope](docs/PRODUCT.md), [roadmap](docs/ROADMAP.md) and [contribution guide](CONTRIBUTING.md). The [architecture](docs/ARCHITECTURE.md) distinguishes the existing demo from the planned connected beta. Open product and technical choices are tracked in the [decision register](docs/DECISIONS.md).

The [project workflow](docs/PROJECT-MANAGEMENT.md) explains priorities, dependencies and release gates. [The backlog](docs/planning/BACKLOG.md) contains the full issue plan; `backlog.json` is its machine-readable source. Run `pnpm project:check` to validate it and `pnpm project:sync` to preview GitHub setup without making changes. Publishing status is recorded in [PUBLICATION.md](docs/planning/PUBLICATION.md).

CI is configured to check types, run tests and build both artifacts on pull requests. Main-branch runs also build and smoke-test the Docker container. Configured checks are not evidence of a passing GitHub run; see the Actions results after publication.

The Planning metadata workflow reconciles labels, milestones and issue membership when the source backlog changes. It uses GitHub's built-in repository token; no personal token or deployment secret is required. Account-level Projects board setup remains separate.

## Code and media rights

No open-source license has been selected. Bundled artist images and third-party music remain subject to their respective rights; source attribution is recorded in the JSON source files. Asset permission and public-release review are tracked in the backlog. Publishing source does not license third-party media.

## Recording version policy

`src/playback.ts` is the shared selection rule for artist pages, track browsing and daily picks. A confirmed Spotify track ID always selects the official Spotify embed. The old per-track preferred-provider flag is removed. SoundCloud fallback requires `spotifyStatus: "not_found"` plus a valid mapped SoundCloud URL; record the review date, evidence and version notes before using that status. An unchecked or ambiguous listing stays pending. A player error, absent preview or regional restriction is not evidence that the recording is absent from Spotify.

93 of the 100 catalog tracks have Spotify listings checked against the official track embed metadata (artist identity, title, ID, release date and duration); provenance is in `SPOTIFY-SOURCES.json`. This is a metadata check, not a listening comparison of every recording. Seven tracks remain pending: All Love!, radar, radar, HATE UR FACE, I Wanna Be Adored, Anytime, One Death and I Start To Kry. No current entry has been declared Spotify-absent, so the SoundCloud fallback branch was browser-tested using a separate simulated catalog fixture rather than changing a real track’s availability. `hottie` was reported COUNTRY_RESTRICTED at the metadata check and retains its Spotify player and direct link.

Dreamflasher remains pinned to its original Spotify release (`75Wgg4LerPD3mVO5hEyUN9`, April 4, 2025, 224,486 ms / 3:44). Its differing SoundCloud upload remains source metadata. How to Teleport is explicitly labeled as the current Spotify-profile 4:33 version, distinct from earlier releases. Corrected the catalog spelling PYRAMIDZE to Spotify’s PYRAMIDZ. SoundCloud recording-match metadata remains separate from Spotify release metadata; an official upload alone does not establish recording equality.

Spotify uses the [official embed format](https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed). No Spotify Web API credentials are required for this integration. Actual preview availability, playback length and listener eligibility remain controlled by Spotify; we do not extract, host or play raw preview URLs. For public launch, the previously identified [Spotify Widget Terms](https://developer.spotify.com/documentation/embeds/terms) requirement for written approval for game functionality still needs resolution.
