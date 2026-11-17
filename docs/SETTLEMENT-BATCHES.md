# Durable settlement preparation

This is the first increment of [A06 / #24](https://github.com/ayadebbagh/first-press/issues/24): freeze the eligible order set before collection, bind one reviewed observation, and recover or expire the attempt. It does **not** execute orders, consume reservations, credit proceeds or create lots/receipts. The executor, full accounting reconciliation and settlement concurrency remain open. No public route, scheduled worker or provider collection is enabled.

## Lifecycle

`src/server/backing/settlement-batches.ts` exposes internal server functions:

| Function | Result |
| --- | --- |
| `sealSettlementBatch(db, {artistId, cutoff: Date})` | Creates or replays the artist's unique scheduled batch and immutable member list. |
| `bindBatchSnapshot(db, batchId, snapshotId)` | Binds one eligible accepted C04 snapshot; never collects a source itself. |
| `expireSettlementBatch(db, batchId)` | Skips an unexecuted batch at or after its deadline; before the deadline it returns unchanged. |
| `readSettlementBatch(db, batchId)` | Returns coherent metadata and membership in one read-only repeatable-read transaction. |

The cutoff identifies a 00:00/12:00 UTC slot, not a caller-selected execution clock. Production entry points accept no `now`, clock callback, environment override or session setting. `public.fp_settlement_clock()` is a schema-qualified, volatile wrapper around PostgreSQL `clock_timestamp()`. Clock samples, comparisons and stored watermarks retain microsecond precision in SQL; wire timestamps have six fractional digits.

Mutators lock one artist before its batch. Order admission and cancellation already take that artist lock. A seal freezes every queued `backing-v1` order accepted **strictly before** the cutoff with an eligible earliest cutoff, ordered by acceptance time and ID with the C collation. It records the exact maximum acceptance timestamp; an empty set uses cutoff minus one microsecond. Later admission cannot join this member list. Cancelled members remain historical members; sealing never prevents cancellation or consumes a reservation.

New batches begin with building membership, insert their owned members and finalize in the same transaction. Migration 0010 rejects an unfinalized service batch at commit, incomplete membership or a wrong watermark, later member insertion and member mutation/deletion. Artist locking also applies to direct SQL building-batch insertion, including empty sets. New-service membership is immutable after finalization.

Previously stored batches retain `membership_sealed = NULL`, meaning their original complete membership is unknown. The migration invents no historical members and changes no quote, ledger, lot or receipt. Legacy records remain readable with `membershipSealed: false`; preparation cannot upgrade their membership or bind a new quote. Historical test setup remains legacy evidence, not proof of a new service seal.

## Quote eligibility and retries

A new binding requires finalized membership, an active nonsynthetic artist, a non-demo database and a positive accepted Spotify monthly-listener snapshot backed by matching accepted C04 provenance. Current canonical artist identity, source URL, payload/count/parser/evidence links and chronology must agree. The observation must be taken at or after both the cutoff and committed seal; acceptance must precede the sampled database time. Binding must finish within `[cutoff, cutoff + 2 hours)`. A quarantined capture, old cached observation, disputed history, unsafe correction ancestry or superseding executed batch cannot authorize a new binding.

Binding is null-to-one ID. Same-ID retries return the persisted result before current availability checks; a different bound ID conflicts. Reading a binding is not permission to execute: the future executor must recheck time, source, artist, account and accounting under its own locks. If a new binding crosses the deadline during its update or final reads, its savepoint is rolled back and only skipped/expired metadata commits. No attempted quote survives that rollback.

Expired, empty, paused, review-blocked and superseded attempts retain explicit skip reasons. An invalid candidate quote leaves the batch unbound; missing identifiers and conflicting bindings are errors. A paused or review-blocked binding attempt skips the batch conservatively. Terminal retries return the original result, never reseal, replace a quote or resurrect an expired slot. Pending orders remain queued and cancellable for a later valid update, with their original cash/quantity reservations and support evidence unchanged.

## Verification and operating limits

`TEST_BATCH_DATABASE_URL=... pnpm test:batches` requires a fresh, empty disposable `_test` database, separate from every other suite; provision another database for a full rerun. Its controlled-clock fixture verifies the actual connected name against that explicit URL and requires test identity before replacing the clock function. It restores the real function afterward. Clock DDL is test/migration-owner authority; there is no production setter. Production database-role separation remains deployment work, so using an owner credential at runtime does not establish least privilege.

The deterministic PostgreSQL tests exercise the production entry points with historical matched C04 fixtures and a controlled database clock: exact cutoffs/deadlines, frozen membership, provenance gates, replay, lock waits, rollback and unchanged economic state. A separate untouched-clock smoke checks real PostgreSQL time and clock sampling after artist-lock waits. Controlled tests do not claim physical collection after a real elapsed seal, live settlement, scheduler reliability or launch readiness. Existing C04 HTTP tests separately verify actual intake. Source approval, artifact operations, scheduling, incident handling and public receipt verification remain separate release gates.
