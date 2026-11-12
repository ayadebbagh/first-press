# Decision register

Record a dated decision, owner, options, consequences and linked issue when resolving a row. A recommendation is not founder approval. Existing accepted product choices are in PRODUCT.md.

| Key | Choice | Recommendation / unresolved detail | Gate |
| --- | --- | --- | --- |
| F01 | Database, migration and authentication approach | Accepted 2026-11-12: PostgreSQL + Drizzle + Better Auth for beta and production, with both Google and email/password. Baseline versions, migration ownership and configuration are in [ADR 0001](adr/0001-self-hosted-backend.md) | Server schema/auth |
| F04 | Backing economy and update contract | 1,000 initial Credits accepted; specify UTC boundaries, centi-Credit rounding, units, order cutoff, reservations, partial lots, source-delay treatment, stale grace, suspensions and correction policy | Live order implementation |
| C03 | Listener source access | Evaluate public-page collection without bypassing restrictions; document allowed operational use, reliability and cost. Use verified manual imports if automation remains unresolved. No paid service selected | Automated collection / live data |
| C08 | Bad or corrected snapshots | Append-only correction events; choose cancel/freeze/recompute behavior before any live incident | Live settlement |
| R02 | Public support history | Pseudonyms, opt-in public profile and selective receipt sharing; define deletion/redaction versus ledger retention | Public receipts |
| D01 | Daily global ranking | Vary balanced pairings across participants so the comparison graph connects all eight tracks. Specify aggregation, ties, minimum coverage and guess cutoff | Community daily |
| D02 | Spotify game use | Resolve provider terms/approval or choose a permitted daily design. Discovery playback and game approval are separate decisions | Public daily |
| D05 | Badges | Define meaningful minimum support, entry-listener thresholds, calculation version and retention after exit; avoid rewards for cancelled orders | Reputation |
| D06 | Weekly top-up | Amount, eligibility, cap, weekly boundary and abuse limits remain undecided; leave disabled until decided | Recurring grant |
| O01 | Host and domain | Small Docker-capable VPS plus PostgreSQL and off-host backups; provider, region, budget and domain remain unselected | Deployment |
| O05 | Pilot outcomes | Set a small invite cohort and observable activation/retention targets before recruiting | Pilot measurement |
| O06 | Code license and media | Owner selects source license; replace or obtain permission for redistributed media where needed | Public media / broad release |

## Source-use notes

Spotify's [Widget Terms, section IV.2.d](https://developer.spotify.com/documentation/embeds/terms) require written approval for game functionality using Spotify content (checked 2026-11-12). The plan does not claim such approval exists. Keep public daily functionality gated until D02 is resolved. Confirm source collection access independently; an embed is not a license to collect monthly-listener data.

## Proposal template

Context and issue → feasible options and recurring costs → recommendation → owner decision/date → migration, rollback and affected acceptance criteria. Preserve superseded decisions so accounting and badge versions remain interpretable.
