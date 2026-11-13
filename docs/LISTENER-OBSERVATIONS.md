# Listener observation intake

Implements [C04 / #14](https://github.com/ayadebbagh/first-press/issues/14). This is an admin-only validation and persistence path, not an automated collector or a live catalog launch. [C01](https://github.com/ayadebbagh/first-press/issues/11) still gates reviewed identities and [C03](https://github.com/ayadebbagh/first-press/issues/13) still gates operational source access. The app's listener figures and charts remain synthetic.

## Authority and provenance

An active, email-verified admin submits a capture already collected and reviewed outside the transaction. The artist must exist under its canonical Spotify ID; only an active, nonsynthetic artist can receive an accepted quote. This endpoint never activates artists, fetches arbitrary URLs, reads localStorage, settles orders or changes Credits. Demo databases cannot use intake. Provider and metric are exclusively Spotify rolling `monthly_listeners`; streams, followers and other platforms are not equivalent.

`POST /api/admin/listener-observations` requires an authenticated admin session, the canonical Origin, JSON and at most 16 KiB. Rate limits are 20 submissions per admin/minute. Example body (replace **all** illustrative identifiers, times and evidence):

```json
{
  "artistId": "reviewed-internal-artist-id",
  "sourceEventKey": "capture-unique-stable-key",
  "provider": "spotify",
  "metric": "monthly_listeners",
  "providerArtistId": "1111111111111111111111",
  "listenerCount": "10000",
  "sourceUrl": "https://open.spotify.com/artist/1111111111111111111111",
  "evidence": {
    "reference": "private-evidence/capture.png",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "parserVersion": "manual-v1",
  "observedAt": "2026-11-12T11:59:00.000Z",
  "fetchedAt": "2026-11-12T11:59:01.000Z",
  "sourceUpdatedAt": null
}
```

Use canonical UTC timestamps (`Date.toISOString()`). `observedAt` is the actual observation; `fetchedAt` is when its collector fetched the evidence, not when this API receives the submission. Preserve those times on retries. `sourceUpdatedAt` is unknown unless the source actually discloses its update time. The database supplies the separate acceptance/receipt time after acquiring locks. Counts accept positive decimal integer strings (preferred) or safe integer JSON numbers, 1 through 10^12. Never coerce missing data to zero or expand abbreviated values such as `10K` into authoritative counts.

The evidence reference points to an operator-retained artifact and the SHA-256 fingerprints its bytes. Do not include credentials, signed URLs, personal data or the full captured page. Evidence upload/storage/retention is not implemented here; an operator must retain the referenced artifact securely before submission. A checksum does not establish that a capture or its timestamp is truthful. Capture authenticity, stable identity review and collector reliability remain operational responsibilities, with C01/C03 and C08 as release gates.

## Validation and review

`listener_observations` stores an immutable JSON copy of the original submission, canonical payload hash, actor, receive time, validation version, reasons, result, optional correction parent and accepted quote ID. New intake uses `spotify-listeners-v2`; historical v1 rows retain their version. Invalid provider/count/date values remain raw; they are never mislabeled as normalized Spotify observations. Unsupported authority fields (`status`, `acceptedAt`, actor, synthetic flag, etc.), invalid envelopes, excessive nesting, oversized bodies, NUL and unpaired UTF-16 surrogates are rejected as requests, rather than stored. Ordinary Unicode is preserved; unsupported strings are never silently cleaned before hashing.

Valid readings create an accepted `listener_snapshots` row and the observation atomically. Quarantines have no pricing snapshot. Both raw history and normalized snapshots reject updates/deletes. Accepted quote ownership, source, count, reviewer, evidence link and acceptance time are checked by a database trigger as well as the service. A failed observation insert rolls back its quote.

Review reasons cover missing/nonpositive/malformed/out-of-range counts; provider/metric/artist/profile mismatches; missing evidence/parser version; invalid, future or reversed instants; observations older than 24 hours; known source updates older than 24 hours; equal/older observations than the last accepted quote; unavailable/synthetic artists; and disputed history. An unknown platform update time remains null and is allowed. Genuine new captures with unchanged counts are allowed.

A change of **50% or more in either direction** from the latest accepted count triggers review. This is a conservative v1 intake guard, not a growth prediction or a change to backing arithmetic. It intentionally creates false positives for human checking, including after long data gaps. It must be versioned if changed; it is not proof that smaller changes are correct.

`GET /api/admin/listener-observations?id=…&artistId=…` returns the raw capture and result for a known record (admin-only, 30 reads/minute, private/no-store). A review dashboard/list and source collection worker are later work. Successful creation returns 201 for accepted **or quarantined** records; inspect `status`, `reasons` and nullable `snapshotId`.

## Retries and corrections

The artist/capture key is unique. Identical JSON meaning (including reordered object keys) returns the original ID/result with 200; changing its payload returns 409. Replays do not refresh the original observation or acceptance time. Intake locks the artist before reading its latest quote, serializing parallel retries and preventing older captures from displacing newer history. Evidence collection must happen outside this lock. Reusing a cached capture under fabricated new times is forbidden; the service cannot independently prove when a manually supplied artifact was collected.

Correct a quarantined transcription with a **new capture/submission key** and `correctsObservationId` pointing to the original observation under the same artist. Keep the actual capture times and evidence; correct only what the reviewed evidence supports. The parent remains unchanged. A confirmed outlier additionally needs an explicit `reviewReason` of at least 20 characters after trimming and a quarantined parent carrying `listener_change_requires_review`. The successor must still pass every hard validation rule. A reason by itself never bypasses the outlier gate.

Outlier confirmation is bound to the original candidate's exact raw count representation, provider/metric/artist, profile URL, parser version, actual observation/fetch/source-update times and evidence. Changing those creates a new quarantined candidate; an old outlier record is not an artist-wide waiver. Reconfirming an already accepted capture cannot refresh its observation time.

Corrections to accepted observations and **all descendants** of accepted or incident-only correction chains remain quarantined with `accepted_correction_requires_incident_review`. A quarantined intermediary cannot remove that gate. SQL guards independently enforce ancestry and candidate binding. Any disputed accepted history blocks further intake acceptance. Forward migrations preserve historical quotes/money; unsafe legacy accepted chains are detected and pause further intake/new orders rather than being repriced or silently trusted. There is deliberately no incident override: C08 must implement freezing, annotations, prospective correction and rehearsal. This endpoint never rewrites executed quotes, receipts, lots or payouts, and is insufficient to resolve an incident. Cancellation of pending orders remains allowed by the backing contract. See [review hardening #57](https://github.com/ayadebbagh/first-press/issues/57).

## Verification

Run `pnpm test` for pure validation and `TEST_OBSERVATION_DATABASE_URL=… pnpm test:observations` against an explicitly disposable PostgreSQL database ending `_test`. The integration suite migrates that database but never infers its target from the app's `DATABASE_URL`. Tests cover concurrent retries, payload conflicts, raw invalid readings, unchanged/out-of-order captures, outlier confirmation, linked corrections, disputes, authorization, immutability, quote provenance and transaction rollback. CI also exercises real session/Origin/body-limit/review APIs through isolated account browsers on desktop/mobile.

Implementation uses [Drizzle transactions](https://orm.drizzle.team/docs/transactions) and forward migrations with [PostgreSQL triggers](https://www.postgresql.org/docs/18/sql-createtrigger.html). No applied migration is edited.
