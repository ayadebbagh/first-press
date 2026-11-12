# Beta verification — 2026-11-08


## Invite-only identity and recovery — 2026-11-12

A02 adds gated connected identity while retaining the independent synthetic backing demo. [Branch preflight 43306204008](https://github.com/ayadebbagh/first-press/actions/runs/43306204008) passed 35 unit checks, 14 PostgreSQL schema/migration cases, 10 auth handler cases and 24 browser checks (18 demo + 6 connected-account, across desktop and 320px mobile). Frozen installation, typechecking, production/preview builds, drift and Compose checks also passed. Final PR/main checks are the canonical evidence for the polished revision.

The connected flow uses the actual Next.js server, PostgreSQL, durable outbox, Nodemailer worker and an isolated STARTTLS SMTP fixture with a trusted test CA. It covers invited registration, blocked unverified access, delivered verification, sign-in/out, profile persistence, string-valued owned wallet/order reads, cross-user/origin/role rejection, admin admission and session invalidation. Core handler tests additionally cover forged/expired sessions, generic single-use/expired reset handling, persistent throttling across instances, Secure/HttpOnly/SameSite cookies, and Google signature/claims plus explicit linking. Google uses a local RSA/JWKS fixture; real Google credentials/consent-screen and real relay/domain delivery remain rollout checks, not claims supplied by fixture tests.

The first browser pass caught a password-help string being included in the accessible field name; the hint now uses aria-describedby separately from its label. The corrected flow passed, and desktop/mobile screenshots were downloaded, hash-verified and visually inspected. Final polish adds semantic main landmarks, safe wrapping for long names and a smaller mobile heading so the form is reached sooner. Optional fonts are stubbed in deterministic browser tests, and personal Brave/storage is untouched.

Auth remains explicitly disabled until configured. No demo balance, wallet grant, public receipt or live settlement is created by signing up. [Authentication setup and limits](docs/AUTHENTICATION.md) documents operator steps, SMTP worker supervision, admission/recovery and remaining release gates. Local npm/network restrictions still prevent a complete local dependency installation; the interrupted attempt's existing Next link was restored, and full dependency/build/runtime verification runs in hosted CI.

## PostgreSQL foundation — 2026-11-12

[A01 / PR #51](https://github.com/ayadebbagh/first-press/pull/51) adds persistence tooling without switching the UI to real accounts. The [initial PostgreSQL job](https://github.com/ayadebbagh/first-press/actions/runs/43299923068/job/131468146763) passed all 12 database integration cases on the official PostgreSQL 18.6 image: empty/repeated/concurrent migrations, changed-migration rejection, exact bounded amounts, grant uniqueness, cross-account reservations/exits, immutable quotes/receipts, lot precision and isolated repeatable demo seeding. Drizzle found no uncommitted schema drift; Compose validation passed. Two additional stale/quarantined-baseline and strict-cutoff cases are included in the final PR checks; its CI is the final release evidence.

The existing 34 unit tests also pass locally and with the new dependencies in CI. Typechecking succeeds with the generated auth core and server schema. Local PostgreSQL execution is unavailable because the local Docker daemon is not running; real database execution occurs in an isolated hosted CI service, not a mock or the founder's personal browser. Database tests require an explicit disposable `_test` URL and never default to application credentials.

The development image is 18.6 because the announced 18.7 image was not yet published; upgrade/retest before live deployment. pnpm's release-age policy remains enabled, with Better Auth/CLI/adapter pinned to the compatible 1.7.21 patch. The temporary generation workflow was removed after its lockfile, auth schema and migrations were reviewed and committed. Sign-in, transactional wallet services, collection, verified public receipts and production rollout are still separate release gates. See [database operations and limits](docs/DATABASE.md).

## Artist pictures and isolated browsers — 2026-11-12

[PR #46](https://github.com/ayadebbagh/first-press/pull/46) is merged. All 50 artists have local picture mappings; the 18 new profile images include source and artist-identity evidence in `ASSET-SOURCES.json`. Each new file was decoded locally, and the production and standalone-preview builds passed. The unit check now rejects missing image mappings instead of silently skipping them.

[CI run 43287769563](https://github.com/ayadebbagh/first-press/actions/runs/43287769563) passed the frozen pnpm installation, typecheck, all 21 unit tests, production/preview builds and all 16 Playwright checks. The browser tests use an actual Next.js production server with separate desktop (1440px) and mobile (320px) Chromium contexts. They cover all 50 decoded catalog images, direct artist links, a broken-image fallback, page width, direct routes/root redirect/404, keyboard and dialog focus, watchlist persistence, buy/cancel/settle/full exit/retained receipts, daily vote/prediction locking and the original Dreamflasher Spotify mapping. Desktop/mobile screenshots were downloaded and visually reviewed. Failure traces, reports and screenshots are kept for seven days in Actions artifacts.

Optional fonts and external provider frames are deterministic fixtures in this suite. This proves app behavior and provider selection; it does not revalidate live Spotify/SoundCloud audio eligibility. Every test gets fresh browser storage and no personal Brave window/profile is used. The local environment still denies HTTP binding, so actual-server browser execution runs in hosted CI.

Run `pnpm exec playwright install chromium`, `pnpm build`, then `pnpm test:e2e` on a host that permits local listening. The suite manages its own server on port 3100. Issues #45 and #8 are complete.

## Repository and planning checks — 2026-11-12

Typecheck, all 21 existing tests, the Next.js production build and the React QA preview build passed again while preparing the repository. The 43-issue/four-milestone backlog validates without missing dependencies or cycles; additional invalid fixtures confirmed that the validator rejects cycles, missing keys and duplicate keys. All local Markdown links resolve and GitHub YAML files parse. The project-sync command defaults to a no-network dry run and rejects an unexpected repository target before mutation.

No credential-pattern matches were found in the selected source files. Generated previews/builds, local tool state and private environment files are excluded. The earlier Brave observations used the file preview; real-server isolated coverage was subsequently completed in F02 as documented above. Publication and access status are recorded in `docs/planning/PUBLICATION.md`.

Publication follow-up: the [first GitHub CI run](https://github.com/ayadebbagh/first-press/actions/runs/43282396592) passed its frozen install, checks, both builds and Docker HTTP smoke test. The latter verified health, the root/discovery route, catalog, favicon and invalid-route 404 against the actual production server. The [planning workflow](https://github.com/ayadebbagh/first-press/actions/runs/43282396565) passed and four milestones/43 assigned issues were verified via GitHub's repository API. These HTTP checks do not replace F02's isolated browser/hydration tests.

## Automated checks

`pnpm test`: **21 passed, 0 failed** (Node.js type stripping for the TypeScript core).

Coverage includes catalog cardinality and unique IDs, Credit reservation, double-spend prevention, invalid inputs, cancellation refund idempotency, next-snapshot entry prices, receipt execution data, proportional appreciation and declines, reserved sell quantities, oversell rejection, partial-sale cost basis, full exit with retained receipts, multi-artist batch accounting, no duplicate settlement, local persistence, and invalid JSON recovery.

`pnpm typecheck`, the Next.js production build, and the React companion preview build passed. Next.js emitted `.next/standalone/server.js`. Docker Compose configuration validation passed.

## Next.js / pnpm / self-hosting migration — current result

The application now uses Next.js 16.4.5 App Router, React 19.3.1, strict TypeScript and pnpm 11.25.0. The production target is Next.js standalone output on Node.js or Docker. The earlier Sites static output and vanilla runtime have been retired; the original source is backed up in `outputs/FIRST-PRESS-before-react.zip`.

- `pnpm install --offline --frozen-lockfile` succeeded using 22 platform-compatible packages from an integrity-verified cache. The committed lockfile contains canonical registry packages, including the other platform SWC variants, and no temporary-file dependencies.
- `pnpm typecheck` and `pnpm build` passed. Output includes the App Router application, `/api/health` and the generated standalone server.
- `pnpm test` passed all 21 tests. Three new behavioral tests cover daily matchup eligibility, the four-vote limit, ranking boundaries and reveal lock, and next-day reset without changing portfolio data.
- `docker compose config --quiet` passed. The Docker daemon was not available; the container image was not built or run here.
- The final standalone start helper copied public/static assets successfully, then reached the generated server. Attempting the HTTP server returned `listen EPERM: operation not permitted 127.0.0.1:3000`. This prevents browser-to-Next-server verification in this environment. There is no deployed instance or verified live server URL.
- Browser testing therefore used a single-file build of the **same React components**, with a hash-navigation adapter in place of Next.js routing. This verifies React state/forms/rendering and local persistence. It does not verify Next.js HTTP navigation, SSR hydration or the health endpoint over HTTP.

Observed in Brave after migration, using a separate `firstpress.qa.next-migration.v1` key:

| Flow | Observed result |
| --- | --- |
| Catalog and search | 50 artists; `fakemink` narrowed to one artist. The slash keyboard shortcut focused search. Track search found Dreamflasher. |
| Watchlist | Adding fakemink survived reload. |
| Queue and persistence | A 250-Credit backing reserved 250, left 750 available, and survived reload without creating a holding before settlement. |
| Settlement | Update 001 created a 250-Credit position and entry receipt; total remained 1,000. |
| Partial sell / cancel | 50% showed 125 CR estimated, queued without releasing Credits, and cancellation restored the available position. |
| Growth / full exit | Update 002 showed 257.35 CR and total 1,007.35. The full sale settled on declining update 003, leaving 995.46 Credits and no holding. |
| Receipt retention | Original receipt remained after full sale with 250 Credits, 395,495 entry listeners, and update 001. Copy receipt text succeeded. |
| Daily | All four matchups accepted a pick, then showed ranking controls. Moving Jane down changed the order. Reveal showed 2/8 and the illustrative crowd positions. |
| Spotify | Dreamflasher loaded the pinned original Spotify ID; Play produced Pause and the browser’s Audio playing state. The 320px modal fit inside the viewport. |
| SoundCloud fallback | A separate simulated absence fixture selected the labeled SoundCloud widget; playback stopped at the 20-second limit with completion status. No real catalog availability was changed. |
| Requests | A test artist suggestion saved locally and showed confirmation. |
| Responsive / console | Reviewed the 320px daily result, track catalog, and Spotify dialog. The console showed zero messages during the main React flow; a nonbreaking browser form-field improvement was surfaced separately. |
| Founder preview | Returned to the rebuilt main file on Discover; its existing 900-Credit state loaded under the original key. Test orders and suggestions used separate keys. |

The React review checked component boundaries, effect cleanup for the SoundCloud widget, scoped keyboard handlers, native dialog focus/escape behavior, keys on mapped lists, typed order unions, immutable state updates, and source-safe playback URLs. No `dangerouslySetInnerHTML` is used for the UI. The SVG receipt exporter remains escaped text in a generated download.

## Earlier Spotify-first update — playback behavior

- Verified 93 Spotify track listings against their official track embed metadata. Recorded IDs, titles, credited artists, release dates, durations, source URLs and check timestamps in `SPOTIFY-SOURCES.json`. This does not claim all 93 tracks were listened to in the browser.
- All eight daily picks now select Spotify. Browser-loaded player metadata and Play controls were observed for Night, Blooming Jasmine, Hurt, Dreamflasher, SPEED DEMON, Nosferatu, Made Sum Plans, same language and Living Proof. Pressed Play on fakemink and Hurt; observed Pause and Brave’s Audio playing state.
- Dreamflasher stayed pinned to the original 3:44 Revengeseekerz release. Its different SoundCloud upload is not selected. The daily rotation’s Jane pick remained Dreamflasher.
- At 320 CSS pixels, the Spotify dialog and native player fit inside the viewport; the original Dreamflasher title, artist, Play control and direct Spotify link were visible. The player retains a minimum 280-pixel width.
- Tested an unmapped real catalog track (All Love!): the dialog showed a pending Spotify check and a Spotify search link; no automatic SoundCloud substitution.
- Tested a controlled **separate QA fixture** that marks one Spotify-mapped track as absent, solely to exercise the fallback. The production catalog was not altered by this fixture. The fallback displayed its SoundCloud version note, loaded the official widget, played and automatically paused at 0:20 with the completion message.
- The fallback console exposed SoundCloud encrypted-media permission warnings. Added the widget’s encrypted-media iframe permission, rebuilt and repeated playback: only the SoundCloud informational message remained; those warnings were absent.
- Checked the region-restricted hottie mapping in Brave. It retained its Spotify iframe and direct link, displayed the catalog restriction note, and did not fall back to SoundCloud. Removed a redundant legacy fullscreen attribute from Spotify’s iframe after observing its console warning; fullscreen remains in the modern allow attribute.
- Updated standalone build and static distribution; inspected the final rebuilt main beta in Brave with Dreamflasher’s original Spotify embed loaded and ready. Founder data remained under the original storage key. QA used separate `firstpress.qa.spotify-first.v1` and `firstpress.qa.spotify-fallback.v1` keys.

Six playback regression tests cover provider priority, restriction/error handling, explicit absence fallback, source validation, the exact Dreamflasher release, stable daily picks and checked catalog metadata. Existing accounting tests remain passing.

## Earlier Brave checks actually observed

Used the user’s native Brave browser through the computer-use tool. The standalone QA copy uses a separate `firstpress.qa.v1` storage key, preserving the founder’s beta data.

| Flow | Observed result |
| --- | --- |
| Discover / artist navigation | Opened catalog and fakemink artist detail; route and selected navigation changed correctly. |
| Search | Searching `fakemink` returned one artist. |
| Watchlist | Adding fakemink changed the + to a selected state. It remained selected after reload; mobile Watchlist filter returned one artist. |
| Queue buy | A 250-Credit order reduced available Credits from 1,000 to 750; 250 were reserved, no holding existed yet, and total remained 1,000. |
| Reload pending order | The queued buy and 750 available Credits remained after browser reload. |
| Settle buy | Update 001 created one 250-Credit holding at the new listener figure of 395,495, with no instant gain. |
| Receipt | Entry record showed 250 Credits, 395,495 entry listeners, update 001, and Nov 08, 2026. |
| Text sharing | Copy receipt text returned success. |
| SVG export | Export generated a browser Save dialog with the expected artist-specific filename. File-save completion was not independently confirmed. |
| Queue partial sale | 50% showed an estimated 125 Credits and remained queued without immediately crediting the wallet. |
| Cancel partial sale | Queue cleared and the holding remained intact. |
| Post-entry growth | Update 002 changed the 250-Credit holding to 257.35 (+2.94%); total became 1,007.35. |
| Full sale through decline | The entire holding was queued, then sold on update 003 at the new lower price. Holding cleared and available Credits became 995.46. |
| Receipt retention | Original receipt still existed after the full sale with unchanged entry details. |
| Daily choices | All four choices advanced to the next matchup, then to the prediction view. |
| Ranking reorder | Moving 2hollis up placed it above Jane Remover. |
| Result | Reveal showed a 2/8 score and each sample crowd position. Labels explicitly identified the ranking as illustrative. |
| SoundCloud | Jane Remover’s Dreamflasher loaded inside the official widget, played, and automatically paused at the 20-second sound-check limit. Parent UI displayed completion. |
| Artist suggestion | `QA Artist` saved locally with a success message. |
| Track view | The Watchlist filter produced fakemink’s two discovery tracks. |
| Mobile | Inspected Discover, catalog, daily result, and bottom navigation at 390 CSS pixels. Inspected track catalog at 320 CSS pixels. Navigation worked. |
| Console | No JavaScript errors were shown. DevTools reported 0 page errors / 0 breaking changes; one autocomplete improvement was identified and addressed in the suggestion input. |

## Defects fixed during review

- Two original remote portraits failed to load. Replaced them; the subsequent daily and phone screenshots showed 2hollis and Lucy Bedroque portraits correctly.
- Ensured selecting an unmapped track never silently plays a different song.
- Used the verified SoundCloud track in Jane’s daily matchup.
- Added accessible names to dialogs.
- Restored the daily score summary on narrow screens and rechecked its presence in Brave.
- Refined empty collection copy for pending orders and returning collectors.
- Reduced the featured artist wordmark on phones to fit its image panel.
- Disabled personal-info autocomplete on the artist suggestion field.
- Corrected singular result counts.

## Verification limits

- 93 catalog tracks now have Spotify mappings; seven remain explicitly pending. No production track is currently marked Spotify-absent. SoundCloud sources are retained for future reviewed fallback, with version-match status kept separate.
- Mobile testing used Brave’s responsive viewport, not physical iOS or Android devices.
- SoundCloud owns the embedded frame’s keyboard behavior. Escape while focus was inside its player did not dismiss the parent dialog in this run; the labeled close button worked.
- Rechecked the final suggestion field in Brave at 320 CSS pixels: `QA Final Check` saved successfully. DevTools then showed 0 page errors, 0 breaking changes, and 0 possible improvements.
- No live collector, authenticated multi-user accounting, shared votes, or server-verified receipt proof exists in this UI beta.
- This terminal’s network sandbox prevented npm access and localhost serving. Brave could reach npm, and the direct-file preview allowed browser QA. Publication status must be checked separately; a registered Site URL alone does not establish deployment.

## Publication outcome

Private publication was attempted through the Sites source workflow. It failed before push/archive completion with `Could not resolve host: git.chatgpt-team.site`. No deployment was created, and the expected Site URL must not be presented as live. The project ID remains in `.openai/hosting.json` for resuming after terminal network access is enabled.

## Follow-up listening and artwork pass

- Bundled 32 local artist/cover artwork assets and embedded them in the standalone preview. The source URLs are in `ASSET-SOURCES.json`. The remaining 18 artists use typographic sleeve art.
- Verified nine additional SoundCloud candidates against current public track HTML, capturing canonical URLs, IDs, titles, streamability, and policy fields. An older indexed 2hollis GOD link failed in the widget and was replaced with the current Hurt upload.
- Observed working SoundCloud embeds in Brave for the daily picks by 2hollis (Hurt), fakemink (Night, Blooming Jasmine), Lucy Bedroque (SPEED DEMON), che (Nosferatu), OsamaSon (Made Sum Plans), Nettspend (same language), and xaviersobased (Living Proof). Jane’s original SoundCloud embed had passed earlier. Hurt also emitted a playback-start event.
- Founder identified that Dreamflasher’s SoundCloud upload differed from Spotify. Added explicit source/version labels to track rows, daily cards, and listening dialogs. Then, at the founder’s request, changed Dreamflasher’s default to the original Spotify release.
- Verified Spotify’s embed metadata: Dreamflasher by Jane Remover, track `75Wgg4LerPD3mVO5hEyUN9`, release date April 4, 2025, duration 224,486 ms, playable.
- Opened the resulting Spotify player in Brave and pressed Play: the browser reported Audio playing and showed the Pause control. Left the founder’s main beta file open with that Spotify release ready to play.
- Spotify determines its own preview length and availability. The SoundCloud 20-second limiter is not applied to Spotify’s native player.
- Repeated the source-workflow publication attempt after direct host requests succeeded. The Git child process still failed DNS resolution for `git.chatgpt-team.site`. No hosted deployment exists.
