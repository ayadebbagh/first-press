import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, text, boolean, timestamp, bigint, integer, numeric, jsonb,
  primaryKey, unique, uniqueIndex, index, check, foreignKey,
} from 'drizzle-orm/pg-core';
import { user } from './auth.generated';
export * from './auth.generated';

// Exact amounts hydrate as bigint; NUMERIC(60,0) hydrates as strings, never Number.
const cents = (name: string) => bigint(name, { mode: 'bigint' });
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const exact = (name: string) => numeric(name, { precision: 60, scale: 0 });
export const artistStatus = pgEnum('artist_status', ['review', 'active', 'suspended', 'archived']);
export const observationStatus = pgEnum('observation_status', ['accepted', 'quarantined']);
export const orderSide = pgEnum('order_side', ['buy', 'sell']);
export const orderStatus = pgEnum('order_status', ['queued', 'cancelled', 'settled']);
export const batchStatus = pgEnum('batch_status', ['sealed', 'executed', 'skipped']);
export const reservationStatus = pgEnum('reservation_status', ['held', 'released', 'consumed']);
export const ledgerKind = pgEnum('ledger_kind', ['starting_grant', 'buy_reserve', 'buy_cancel', 'buy_settle', 'sell_settle']);

export const databaseIdentity = pgTable('database_identity', {
  singleton: boolean('singleton').primaryKey().default(true),
  purpose: text('purpose').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [check('identity_singleton', sql`${t.singleton}`), check('identity_purpose', sql`${t.purpose} IN ('demo', 'test', 'live')`)]);

export const members = pgTable('members', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'restrict' }),
  role: text('role').notNull().default('member'),
  status: text('status').notNull().default('active'),
  publicProfile: boolean('public_profile').notNull().default(false),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [check('member_role', sql`${t.role} IN ('member', 'admin')`), check('member_status', sql`${t.status} IN ('active', 'suspended')`)]);

export const artists = pgTable('artists', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  spotifyArtistId: text('spotify_artist_id').notNull().unique(),
  imageUrl: text('image_url'),
  status: artistStatus('status').notNull().default('review'),
  synthetic: boolean('synthetic').notNull().default(false),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [check('spotify_artist_identity', sql`${t.spotifyArtistId} ~ '^[A-Za-z0-9]{22}$'`)]);

export const tracks = pgTable('tracks', {
  id: text('id').primaryKey(),
  artistId: text('artist_id').notNull().references(() => artists.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  versionLabel: text('version_label').notNull(),
  spotifyTrackId: text('spotify_track_id').unique(),
  soundcloudUrl: text('soundcloud_url'),
  spotifyAbsenceReviewedAt: instant('spotify_absence_reviewed_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [
  index('tracks_artist_idx').on(t.artistId),
  check('spotify_track_identity', sql`${t.spotifyTrackId} IS NULL OR ${t.spotifyTrackId} ~ '^[A-Za-z0-9]{22}$'`),
  check('reviewed_soundcloud_fallback', sql`${t.soundcloudUrl} IS NULL OR (${t.spotifyTrackId} IS NULL AND ${t.spotifyAbsenceReviewedAt} IS NOT NULL)`),
]);

export const listenerSnapshots = pgTable('listener_snapshots', {
  id: text('id').primaryKey(),
  artistId: text('artist_id').notNull().references(() => artists.id, { onDelete: 'restrict' }),
  status: observationStatus('status').notNull(),
  listenerCount: cents('listener_count'),
  provider: text('provider').notNull().default('spotify'),
  metric: text('metric').notNull().default('monthly_listeners'),
  sourceUrl: text('source_url').notNull(),
  sourceEventKey: text('source_event_key').notNull(),
  evidence: jsonb('evidence').notNull(),
  parserVersion: text('parser_version').notNull(),
  observedAt: instant('observed_at').notNull(),
  fetchedAt: instant('fetched_at').notNull(),
  sourceUpdatedAt: instant('source_updated_at'),
  acceptedAt: instant('accepted_at'),
  reviewedBy: text('reviewed_by'),
  synthetic: boolean('synthetic').notNull().default(false),
}, t => [
  unique('snapshot_artist_id').on(t.id, t.artistId),
  unique('snapshot_source_event').on(t.artistId, t.sourceEventKey),
  index('snapshot_history_idx').on(t.artistId, t.observedAt),
  check('snapshot_metric', sql`${t.provider} = 'spotify' AND ${t.metric} = 'monthly_listeners'`),
  check('snapshot_positive_count', sql`${t.listenerCount} IS NULL OR ${t.listenerCount} BETWEEN 1 AND 1000000000000`),
  check('accepted_snapshot_complete', sql`(${t.status} = 'accepted' AND ${t.listenerCount} IS NOT NULL AND ${t.acceptedAt} IS NOT NULL AND ${t.reviewedBy} IS NOT NULL) OR (${t.status} = 'quarantined' AND ${t.acceptedAt} IS NULL)`),
  check('snapshot_chronology', sql`${t.fetchedAt} >= ${t.observedAt} AND (${t.acceptedAt} IS NULL OR ${t.acceptedAt} >= ${t.fetchedAt})`),
  check('snapshot_source_key_nonempty', sql`length(${t.sourceEventKey}) > 0`),
]);

export const snapshotAnnotations = pgTable('snapshot_annotations', {
  id: text('id').primaryKey(),
  snapshotId: text('snapshot_id').notNull().references(() => listenerSnapshots.id, { onDelete: 'restrict' }),
  kind: text('kind').notNull(),
  reason: text('reason').notNull(),
  actorId: text('actor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [check('annotation_kind', sql`${t.kind} IN ('disputed', 'reviewed', 'prospective_correction')`), index('annotation_snapshot_idx').on(t.snapshotId)]);

export const wallets = pgTable('wallets', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'restrict' }),
  availableCents: cents('available_cents').notNull().default(sql`0`),
  reservedCents: cents('reserved_cents').notNull().default(sql`0`),
  updatedAt: instant('updated_at').notNull().defaultNow(),
}, t => [check('wallet_nonnegative', sql`${t.availableCents} >= 0 AND ${t.reservedCents} >= 0`), check('wallet_total_fits', sql`${t.availableCents}::numeric + ${t.reservedCents}::numeric <= 9223372036854775807`)]);

export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => wallets.userId, { onDelete: 'restrict' }),
  artistId: text('artist_id').notNull().references(() => artists.id, { onDelete: 'restrict' }),
  side: orderSide('side').notNull(),
  status: orderStatus('status').notNull().default('queued'),
  amountCents: cents('amount_cents'),
  exitBasisPoints: integer('exit_basis_points'),
  requestKey: text('request_key').notNull(),
  requestHash: text('request_hash').notNull(),
  economyVersion: text('economy_version').notNull().default('backing-v1'),
  placementSnapshotId: text('placement_snapshot_id').notNull(),
  acceptedAt: instant('accepted_at').notNull().defaultNow(),
  earliestCutoff: instant('earliest_cutoff').notNull(),
  cancelledAt: instant('cancelled_at'),
  settledAt: instant('settled_at'),
}, t => [
  unique('order_request_once').on(t.userId, t.requestKey),
  unique('order_owner_artist').on(t.id, t.userId, t.artistId),
  foreignKey({ name: 'order_baseline_artist', columns: [t.placementSnapshotId, t.artistId], foreignColumns: [listenerSnapshots.id, listenerSnapshots.artistId] }),
  index('order_artist_queue_idx').on(t.artistId, t.earliestCutoff, t.acceptedAt).where(sql`${t.status} = 'queued'`),
  index('order_user_history_idx').on(t.userId, t.acceptedAt),
  check('order_intent', sql`(${t.side} = 'buy' AND ${t.amountCents} IS NOT NULL AND ${t.amountCents} >= 100 AND ${t.exitBasisPoints} IS NULL) OR (${t.side} = 'sell' AND ${t.amountCents} IS NULL AND ${t.exitBasisPoints} IS NOT NULL AND ${t.exitBasisPoints} BETWEEN 1 AND 10000)`),
  check('order_nonempty_key', sql`length(${t.requestKey}) BETWEEN 1 AND 200 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'`),
  check('order_version', sql`${t.economyVersion} = 'backing-v1'`),
  check('order_cutoff', sql`${t.earliestCutoff} > ${t.acceptedAt} AND mod(extract(epoch FROM ${t.earliestCutoff}), 43200) = 0`),
  check('order_terminal_time', sql`(${t.status} = 'queued' AND ${t.cancelledAt} IS NULL AND ${t.settledAt} IS NULL) OR (${t.status} = 'cancelled' AND ${t.cancelledAt} IS NOT NULL AND ${t.cancelledAt} >= ${t.acceptedAt} AND ${t.settledAt} IS NULL) OR (${t.status} = 'settled' AND ${t.settledAt} IS NOT NULL AND ${t.settledAt} >= ${t.acceptedAt} AND ${t.cancelledAt} IS NULL)`),
]);

export const settlementBatches = pgTable('settlement_batches', {
  id: text('id').primaryKey(),
  artistId: text('artist_id').notNull().references(() => artists.id, { onDelete: 'restrict' }),
  cutoff: instant('cutoff').notNull(),
  sealedAt: instant('sealed_at').notNull(),
  eligibleThrough: instant('eligible_through').notNull(),
  status: batchStatus('status').notNull().default('sealed'),
  snapshotId: text('snapshot_id'),
  executedAt: instant('executed_at'),
  skipReason: text('skip_reason'),
}, t => [
  unique('batch_artist_cutoff_once').on(t.artistId, t.cutoff),
  unique('batch_artist_id').on(t.id, t.artistId),
  foreignKey({ name: 'batch_snapshot_artist', columns: [t.snapshotId, t.artistId], foreignColumns: [listenerSnapshots.id, listenerSnapshots.artistId] }),
  check('batch_slot', sql`mod(extract(epoch FROM ${t.cutoff}), 43200) = 0 AND ${t.sealedAt} >= ${t.cutoff} AND ${t.eligibleThrough} < ${t.cutoff} AND ${t.eligibleThrough} <= ${t.sealedAt}`),
  check('batch_terminal', sql`(${t.status} = 'sealed' AND ${t.executedAt} IS NULL AND ${t.skipReason} IS NULL) OR (${t.status} = 'executed' AND ${t.snapshotId} IS NOT NULL AND ${t.executedAt} IS NOT NULL AND ${t.executedAt} >= ${t.sealedAt} AND ${t.executedAt} < ${t.cutoff} + interval '2 hours' AND ${t.skipReason} IS NULL) OR (${t.status} = 'skipped' AND ${t.executedAt} IS NULL AND ${t.skipReason} IS NOT NULL)`),
]);

export const settlements = pgTable('settlements', {
  orderId: text('order_id').primaryKey(),
  userId: text('user_id').notNull(),
  artistId: text('artist_id').notNull(),
  batchId: text('batch_id').notNull(),
  executedAt: instant('executed_at').notNull(),
  cashCents: cents('cash_cents').notNull(),
}, t => [
  unique('settlement_owner_artist').on(t.orderId, t.userId, t.artistId),
  foreignKey({ name: 'settlement_order_owner', columns: [t.orderId, t.userId, t.artistId], foreignColumns: [orders.id, orders.userId, orders.artistId] }),
  foreignKey({ name: 'settlement_batch_artist', columns: [t.batchId, t.artistId], foreignColumns: [settlementBatches.id, settlementBatches.artistId] }),
  check('settlement_nonnegative', sql`${t.cashCents} >= 0`),
  index('settlement_batch_idx').on(t.batchId),
]);

export const cashReservations = pgTable('cash_reservations', {
  orderId: text('order_id').primaryKey(),
  userId: text('user_id').notNull(),
  artistId: text('artist_id').notNull(),
  amountCents: cents('amount_cents').notNull(),
  status: reservationStatus('status').notNull().default('held'),
  createdAt: instant('created_at').notNull().defaultNow(),
  resolvedAt: instant('resolved_at'),
}, t => [
  foreignKey({ name: 'cash_reservation_owner', columns: [t.orderId, t.userId, t.artistId], foreignColumns: [orders.id, orders.userId, orders.artistId] }),
  check('cash_reservation_positive', sql`${t.amountCents} >= 100`),
  check('cash_reservation_terminal', sql`(${t.status} = 'held' AND ${t.resolvedAt} IS NULL) OR (${t.status} <> 'held' AND ${t.resolvedAt} IS NOT NULL AND ${t.resolvedAt} >= ${t.createdAt})`),
  index('cash_reservation_user_idx').on(t.userId),
]);

export const positionLots = pgTable('position_lots', {
  id: text('id').primaryKey(),
  buyOrderId: text('buy_order_id').notNull().unique(),
  userId: text('user_id').notNull(),
  artistId: text('artist_id').notNull(),
  entrySnapshotId: text('entry_snapshot_id').notNull(),
  principalCents: cents('principal_cents').notNull(),
  entryListenerCount: cents('entry_listener_count').notNull(),
  initialQuanta: cents('initial_quanta').notNull().default(sql`1000000000000`),
  remainingQuanta: cents('remaining_quanta').notNull().default(sql`1000000000000`),
  reservedQuanta: cents('reserved_quanta').notNull().default(sql`0`),
  proceedsRemainder: exact('proceeds_remainder').notNull().default('0'),
  economyVersion: text('economy_version').notNull().default('backing-v1'),
  createdAt: instant('created_at').notNull(),
}, t => [
  unique('lot_owner_artist').on(t.id, t.userId, t.artistId),
  foreignKey({ name: 'lot_settled_buy_owner', columns: [t.buyOrderId, t.userId, t.artistId], foreignColumns: [settlements.orderId, settlements.userId, settlements.artistId] }),
  foreignKey({ name: 'lot_entry_artist', columns: [t.entrySnapshotId, t.artistId], foreignColumns: [listenerSnapshots.id, listenerSnapshots.artistId] }),
  check('lot_principal', sql`${t.principalCents} >= 100`),
  check('lot_listeners', sql`${t.entryListenerCount} BETWEEN 1 AND 1000000000000`),
  check('lot_quanta', sql`${t.initialQuanta} = 1000000000000 AND ${t.remainingQuanta} BETWEEN 0 AND ${t.initialQuanta} AND ${t.reservedQuanta} BETWEEN 0 AND ${t.remainingQuanta}`),
  check('lot_remainder', sql`${t.proceedsRemainder} >= 0 AND ${t.proceedsRemainder} < ${t.initialQuanta}::numeric * ${t.entryListenerCount}::numeric AND (${t.remainingQuanta} > 0 OR ${t.proceedsRemainder} = 0)`),
  check('lot_version', sql`${t.economyVersion} = 'backing-v1'`),
  index('lot_user_artist_idx').on(t.userId, t.artistId),
]);

export const exitAllocations = pgTable('exit_allocations', {
  orderId: text('order_id').notNull(),
  lotId: text('lot_id').notNull(),
  userId: text('user_id').notNull(),
  artistId: text('artist_id').notNull(),
  quanta: cents('quanta').notNull(),
  status: reservationStatus('status').notNull().default('held'),
  proceedsCents: cents('proceeds_cents'),
  createdAt: instant('created_at').notNull().defaultNow(),
  resolvedAt: instant('resolved_at'),
}, t => [
  primaryKey({ columns: [t.orderId, t.lotId] }),
  foreignKey({ name: 'exit_order_owner', columns: [t.orderId, t.userId, t.artistId], foreignColumns: [orders.id, orders.userId, orders.artistId] }),
  foreignKey({ name: 'exit_lot_owner', columns: [t.lotId, t.userId, t.artistId], foreignColumns: [positionLots.id, positionLots.userId, positionLots.artistId] }),
  index('exit_lot_idx').on(t.lotId),
  check('exit_quantity', sql`${t.quanta} BETWEEN 1 AND 1000000000000`),
  check('exit_proceeds', sql`(${t.status} = 'consumed' AND ${t.proceedsCents} IS NOT NULL AND ${t.proceedsCents} >= 0 AND ${t.resolvedAt} IS NOT NULL AND ${t.resolvedAt} >= ${t.createdAt}) OR (${t.status} = 'released' AND ${t.proceedsCents} IS NULL AND ${t.resolvedAt} IS NOT NULL AND ${t.resolvedAt} >= ${t.createdAt}) OR (${t.status} = 'held' AND ${t.proceedsCents} IS NULL AND ${t.resolvedAt} IS NULL)`),
]);

export const ledgerEvents = pgTable('ledger_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => wallets.userId, { onDelete: 'restrict' }),
  kind: ledgerKind('kind').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  orderId: text('order_id'),
  artistId: text('artist_id'),
  availableDelta: cents('available_delta').notNull(),
  reservedDelta: cents('reserved_delta').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [
  unique('ledger_request_once').on(t.userId, t.idempotencyKey),
  uniqueIndex('starting_grant_once').on(t.userId).where(sql`${t.kind} = 'starting_grant'`),
  uniqueIndex('ledger_order_kind_once').on(t.orderId, t.kind).where(sql`${t.orderId} IS NOT NULL`),
  foreignKey({ name: 'ledger_order_owner', columns: [t.orderId, t.userId, t.artistId], foreignColumns: [orders.id, orders.userId, orders.artistId] }),
  check('ledger_shape', sql`(${t.kind} = 'starting_grant' AND ${t.orderId} IS NULL AND ${t.artistId} IS NULL AND ${t.availableDelta} = 100000 AND ${t.reservedDelta} = 0) OR (${t.orderId} IS NOT NULL AND ${t.artistId} IS NOT NULL AND ((${t.kind} = 'buy_reserve' AND ${t.availableDelta} < 0 AND ${t.availableDelta}::numeric + ${t.reservedDelta}::numeric = 0) OR (${t.kind} = 'buy_cancel' AND ${t.availableDelta} > 0 AND ${t.availableDelta}::numeric + ${t.reservedDelta}::numeric = 0) OR (${t.kind} = 'buy_settle' AND ${t.availableDelta} = 0 AND ${t.reservedDelta} < 0) OR (${t.kind} = 'sell_settle' AND ${t.availableDelta} >= 0 AND ${t.reservedDelta} = 0)))`),
  index('ledger_user_history_idx').on(t.userId, t.createdAt),
]);

export const receiptEvents = pgTable('receipt_events', {
  id: text('id').primaryKey(),
  lotId: text('lot_id').notNull().unique().references(() => positionLots.id, { onDelete: 'restrict' }),
  createdAt: instant('created_at').notNull().defaultNow(),
  // Evidence is normalized through immutable lot -> settlement/order -> snapshots.
  // Annotation and privacy presentation are separate; never editable receipt JSON authority.
}, t => [index('receipt_created_idx').on(t.createdAt)]);

export const roundingEvents = pgTable('rounding_events', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
  lotId: text('lot_id').notNull(),
  retiredNumerator: exact('retired_numerator').notNull(),
  denominator: exact('denominator').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [
  foreignKey({ name: 'rounding_exit_allocation', columns: [t.orderId, t.lotId], foreignColumns: [exitAllocations.orderId, exitAllocations.lotId] }),
  unique('rounding_lot_once').on(t.lotId),
  check('rounding_subcent', sql`${t.retiredNumerator} >= 0 AND ${t.retiredNumerator} < ${t.denominator} AND ${t.denominator} > 0`),
]);

export const watchlists = pgTable('watchlists', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  artistId: text('artist_id').notNull().references(() => artists.id, { onDelete: 'restrict' }),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.artistId] })]);

export const betaInvites = pgTable('beta_invites', {
  email: text('email').primaryKey(),
  expiresAt: instant('expires_at').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  revokedAt: instant('revoked_at'),
  claimedBy: text('claimed_by').unique().references(() => user.id, { onDelete: 'restrict' }),
  claimedAt: instant('claimed_at'),
}, t => [
  check('invite_normalized_email', sql`${t.email} = lower(trim(${t.email})) AND length(${t.email}) BETWEEN 3 AND 254`),
  check('invite_claim_pair', sql`(${t.claimedBy} IS NULL AND ${t.claimedAt} IS NULL) OR (${t.claimedBy} IS NOT NULL AND ${t.claimedAt} IS NOT NULL)`),
  check('invite_expiry', sql`${t.expiresAt} > ${t.createdAt}`),
]);

export const authAuditEvents = pgTable('auth_audit_events', {
  id: text('id').primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  reason: text('reason').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [index('auth_audit_target_idx').on(t.target, t.createdAt)]);

export const mailOutbox = pgTable('mail_outbox', {
  id: text('id').primaryKey(),
  recipient: text('recipient').notNull(),
  purpose: text('purpose').notNull(),
  subject: text('subject').notNull(),
  body: text('body'),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: instant('available_at').notNull().defaultNow(),
  expiresAt: instant('expires_at').notNull(),
  leaseAt: instant('lease_at'),
  sentAt: instant('sent_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, t => [
  check('mail_purpose', sql`${t.purpose} IN ('verification', 'reset')`),
  check('mail_state', sql`${t.status} IN ('queued', 'sending', 'sent', 'failed') AND ${t.attempts} BETWEEN 0 AND 5`),
  check('mail_payload', sql`(${t.status} IN ('queued', 'sending') AND ${t.body} IS NOT NULL) OR (${t.status} IN ('sent', 'failed') AND ${t.body} IS NULL)`),
  index('mail_queue_idx').on(t.status, t.availableAt),
]);

export const actionLimits = pgTable('action_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStartedAt: instant('window_started_at').notNull(),
}, t => [check('action_limit_nonnegative', sql`${t.count} >= 0`)]);
