CREATE TYPE "public"."artist_status" AS ENUM('review', 'active', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('sealed', 'executed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('starting_grant', 'buy_reserve', 'buy_cancel', 'buy_settle', 'sell_settle');--> statement-breakpoint
CREATE TYPE "public"."observation_status" AS ENUM('accepted', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('queued', 'cancelled', 'settled');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('held', 'released', 'consumed');--> statement-breakpoint
CREATE TABLE "artists" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"spotify_artist_id" text NOT NULL,
	"image_url" text,
	"status" "artist_status" DEFAULT 'review' NOT NULL,
	"synthetic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artists_slug_unique" UNIQUE("slug"),
	CONSTRAINT "artists_spotify_artist_id_unique" UNIQUE("spotify_artist_id"),
	CONSTRAINT "spotify_artist_identity" CHECK ("artists"."spotify_artist_id" ~ '^[A-Za-z0-9]{22}$')
);
--> statement-breakpoint
CREATE TABLE "cash_reservations" (
	"order_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "reservation_status" DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "cash_reservation_positive" CHECK ("cash_reservations"."amount_cents" >= 100),
	CONSTRAINT "cash_reservation_terminal" CHECK (("cash_reservations"."status" = 'held' AND "cash_reservations"."resolved_at" IS NULL) OR ("cash_reservations"."status" <> 'held' AND "cash_reservations"."resolved_at" IS NOT NULL AND "cash_reservations"."resolved_at" >= "cash_reservations"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "database_identity" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_singleton" CHECK ("database_identity"."singleton"),
	CONSTRAINT "identity_purpose" CHECK ("database_identity"."purpose" IN ('demo', 'test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "exit_allocations" (
	"order_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"quanta" bigint NOT NULL,
	"status" "reservation_status" DEFAULT 'held' NOT NULL,
	"proceeds_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "exit_allocations_order_id_lot_id_pk" PRIMARY KEY("order_id","lot_id"),
	CONSTRAINT "exit_quantity" CHECK ("exit_allocations"."quanta" BETWEEN 1 AND 1000000000000),
	CONSTRAINT "exit_proceeds" CHECK (("exit_allocations"."status" = 'consumed' AND "exit_allocations"."proceeds_cents" IS NOT NULL AND "exit_allocations"."proceeds_cents" >= 0 AND "exit_allocations"."resolved_at" IS NOT NULL AND "exit_allocations"."resolved_at" >= "exit_allocations"."created_at") OR ("exit_allocations"."status" = 'released' AND "exit_allocations"."proceeds_cents" IS NULL AND "exit_allocations"."resolved_at" IS NOT NULL AND "exit_allocations"."resolved_at" >= "exit_allocations"."created_at") OR ("exit_allocations"."status" = 'held' AND "exit_allocations"."proceeds_cents" IS NULL AND "exit_allocations"."resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" text,
	"artist_id" text,
	"available_delta" bigint NOT NULL,
	"reserved_delta" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_request_once" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "ledger_shape" CHECK (("ledger_events"."kind" = 'starting_grant' AND "ledger_events"."order_id" IS NULL AND "ledger_events"."artist_id" IS NULL AND "ledger_events"."available_delta" = 100000 AND "ledger_events"."reserved_delta" = 0) OR ("ledger_events"."order_id" IS NOT NULL AND "ledger_events"."artist_id" IS NOT NULL AND (("ledger_events"."kind" = 'buy_reserve' AND "ledger_events"."available_delta" < 0 AND "ledger_events"."available_delta"::numeric + "ledger_events"."reserved_delta"::numeric = 0) OR ("ledger_events"."kind" = 'buy_cancel' AND "ledger_events"."available_delta" > 0 AND "ledger_events"."available_delta"::numeric + "ledger_events"."reserved_delta"::numeric = 0) OR ("ledger_events"."kind" = 'buy_settle' AND "ledger_events"."available_delta" = 0 AND "ledger_events"."reserved_delta" < 0) OR ("ledger_events"."kind" = 'sell_settle' AND "ledger_events"."available_delta" >= 0 AND "ledger_events"."reserved_delta" = 0))))
);
--> statement-breakpoint
CREATE TABLE "listener_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"artist_id" text NOT NULL,
	"status" "observation_status" NOT NULL,
	"listener_count" bigint,
	"provider" text DEFAULT 'spotify' NOT NULL,
	"metric" text DEFAULT 'monthly_listeners' NOT NULL,
	"source_url" text NOT NULL,
	"source_event_key" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"parser_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"reviewed_by" text,
	"synthetic" boolean DEFAULT false NOT NULL,
	CONSTRAINT "snapshot_artist_id" UNIQUE("id","artist_id"),
	CONSTRAINT "snapshot_source_event" UNIQUE("artist_id","source_event_key"),
	CONSTRAINT "snapshot_metric" CHECK ("listener_snapshots"."provider" = 'spotify' AND "listener_snapshots"."metric" = 'monthly_listeners'),
	CONSTRAINT "snapshot_positive_count" CHECK ("listener_snapshots"."listener_count" IS NULL OR "listener_snapshots"."listener_count" BETWEEN 1 AND 1000000000000),
	CONSTRAINT "accepted_snapshot_complete" CHECK (("listener_snapshots"."status" = 'accepted' AND "listener_snapshots"."listener_count" IS NOT NULL AND "listener_snapshots"."accepted_at" IS NOT NULL AND "listener_snapshots"."reviewed_by" IS NOT NULL) OR ("listener_snapshots"."status" = 'quarantined' AND "listener_snapshots"."accepted_at" IS NULL)),
	CONSTRAINT "snapshot_chronology" CHECK ("listener_snapshots"."fetched_at" >= "listener_snapshots"."observed_at" AND ("listener_snapshots"."accepted_at" IS NULL OR "listener_snapshots"."accepted_at" >= "listener_snapshots"."fetched_at")),
	CONSTRAINT "snapshot_source_key_nonempty" CHECK (length("listener_snapshots"."source_event_key") > 0)
);
--> statement-breakpoint
CREATE TABLE "members" (
	"user_id" text PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"public_profile" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_role" CHECK ("members"."role" IN ('member', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"side" "order_side" NOT NULL,
	"status" "order_status" DEFAULT 'queued' NOT NULL,
	"amount_cents" bigint,
	"exit_basis_points" integer,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"economy_version" text DEFAULT 'backing-v1' NOT NULL,
	"placement_snapshot_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"earliest_cutoff" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "order_request_once" UNIQUE("user_id","request_key"),
	CONSTRAINT "order_owner_artist" UNIQUE("id","user_id","artist_id"),
	CONSTRAINT "order_intent" CHECK (("orders"."side" = 'buy' AND "orders"."amount_cents" IS NOT NULL AND "orders"."amount_cents" >= 100 AND "orders"."exit_basis_points" IS NULL) OR ("orders"."side" = 'sell' AND "orders"."amount_cents" IS NULL AND "orders"."exit_basis_points" IS NOT NULL AND "orders"."exit_basis_points" BETWEEN 1 AND 10000)),
	CONSTRAINT "order_nonempty_key" CHECK (length("orders"."request_key") BETWEEN 1 AND 200 AND "orders"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "order_version" CHECK ("orders"."economy_version" = 'backing-v1'),
	CONSTRAINT "order_cutoff" CHECK ("orders"."earliest_cutoff" > "orders"."accepted_at" AND mod(extract(epoch FROM "orders"."earliest_cutoff"), 43200) = 0),
	CONSTRAINT "order_terminal_time" CHECK (("orders"."status" = 'queued' AND "orders"."cancelled_at" IS NULL AND "orders"."settled_at" IS NULL) OR ("orders"."status" = 'cancelled' AND "orders"."cancelled_at" IS NOT NULL AND "orders"."cancelled_at" >= "orders"."accepted_at" AND "orders"."settled_at" IS NULL) OR ("orders"."status" = 'settled' AND "orders"."settled_at" IS NOT NULL AND "orders"."settled_at" >= "orders"."accepted_at" AND "orders"."cancelled_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "position_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"buy_order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"entry_snapshot_id" text NOT NULL,
	"principal_cents" bigint NOT NULL,
	"entry_listener_count" bigint NOT NULL,
	"initial_quanta" bigint DEFAULT 1000000000000 NOT NULL,
	"remaining_quanta" bigint DEFAULT 1000000000000 NOT NULL,
	"reserved_quanta" bigint DEFAULT 0 NOT NULL,
	"proceeds_remainder" numeric(60, 0) DEFAULT '0' NOT NULL,
	"economy_version" text DEFAULT 'backing-v1' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "position_lots_buy_order_id_unique" UNIQUE("buy_order_id"),
	CONSTRAINT "lot_owner_artist" UNIQUE("id","user_id","artist_id"),
	CONSTRAINT "lot_principal" CHECK ("position_lots"."principal_cents" >= 100),
	CONSTRAINT "lot_listeners" CHECK ("position_lots"."entry_listener_count" BETWEEN 1 AND 1000000000000),
	CONSTRAINT "lot_quanta" CHECK ("position_lots"."initial_quanta" = 1000000000000 AND "position_lots"."remaining_quanta" BETWEEN 0 AND "position_lots"."initial_quanta" AND "position_lots"."reserved_quanta" BETWEEN 0 AND "position_lots"."remaining_quanta"),
	CONSTRAINT "lot_remainder" CHECK ("position_lots"."proceeds_remainder" >= 0 AND "position_lots"."proceeds_remainder" < "position_lots"."initial_quanta"::numeric * "position_lots"."entry_listener_count"::numeric AND ("position_lots"."remaining_quanta" > 0 OR "position_lots"."proceeds_remainder" = 0)),
	CONSTRAINT "lot_version" CHECK ("position_lots"."economy_version" = 'backing-v1')
);
--> statement-breakpoint
CREATE TABLE "receipt_events" (
	"id" text PRIMARY KEY NOT NULL,
	"lot_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_events_lot_id_unique" UNIQUE("lot_id")
);
--> statement-breakpoint
CREATE TABLE "rounding_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"retired_numerator" numeric(60, 0) NOT NULL,
	"denominator" numeric(60, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rounding_lot_once" UNIQUE("lot_id"),
	CONSTRAINT "rounding_subcent" CHECK ("rounding_events"."retired_numerator" >= 0 AND "rounding_events"."retired_numerator" < "rounding_events"."denominator" AND "rounding_events"."denominator" > 0)
);
--> statement-breakpoint
CREATE TABLE "settlement_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"artist_id" text NOT NULL,
	"cutoff" timestamp with time zone NOT NULL,
	"sealed_at" timestamp with time zone NOT NULL,
	"eligible_through" timestamp with time zone NOT NULL,
	"status" "batch_status" DEFAULT 'sealed' NOT NULL,
	"snapshot_id" text,
	"executed_at" timestamp with time zone,
	"skip_reason" text,
	CONSTRAINT "batch_artist_cutoff_once" UNIQUE("artist_id","cutoff"),
	CONSTRAINT "batch_artist_id" UNIQUE("id","artist_id"),
	CONSTRAINT "batch_slot" CHECK (mod(extract(epoch FROM "settlement_batches"."cutoff"), 43200) = 0 AND "settlement_batches"."sealed_at" >= "settlement_batches"."cutoff" AND "settlement_batches"."eligible_through" < "settlement_batches"."cutoff" AND "settlement_batches"."eligible_through" <= "settlement_batches"."sealed_at"),
	CONSTRAINT "batch_terminal" CHECK (("settlement_batches"."status" = 'sealed' AND "settlement_batches"."executed_at" IS NULL AND "settlement_batches"."skip_reason" IS NULL) OR ("settlement_batches"."status" = 'executed' AND "settlement_batches"."snapshot_id" IS NOT NULL AND "settlement_batches"."executed_at" IS NOT NULL AND "settlement_batches"."executed_at" >= "settlement_batches"."sealed_at" AND "settlement_batches"."executed_at" < "settlement_batches"."cutoff" + interval '2 hours' AND "settlement_batches"."skip_reason" IS NULL) OR ("settlement_batches"."status" = 'skipped' AND "settlement_batches"."executed_at" IS NULL AND "settlement_batches"."skip_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"order_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"cash_cents" bigint NOT NULL,
	CONSTRAINT "settlement_owner_artist" UNIQUE("order_id","user_id","artist_id"),
	CONSTRAINT "settlement_nonnegative" CHECK ("settlements"."cash_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "snapshot_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "annotation_kind" CHECK ("snapshot_annotations"."kind" IN ('disputed', 'reviewed', 'prospective_correction'))
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"artist_id" text NOT NULL,
	"title" text NOT NULL,
	"version_label" text NOT NULL,
	"spotify_track_id" text,
	"soundcloud_url" text,
	"spotify_absence_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracks_spotify_track_id_unique" UNIQUE("spotify_track_id"),
	CONSTRAINT "spotify_track_identity" CHECK ("tracks"."spotify_track_id" IS NULL OR "tracks"."spotify_track_id" ~ '^[A-Za-z0-9]{22}$'),
	CONSTRAINT "reviewed_soundcloud_fallback" CHECK ("tracks"."soundcloud_url" IS NULL OR ("tracks"."spotify_track_id" IS NULL AND "tracks"."spotify_absence_reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"available_cents" bigint DEFAULT 0 NOT NULL,
	"reserved_cents" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_nonnegative" CHECK ("wallets"."available_cents" >= 0 AND "wallets"."reserved_cents" >= 0),
	CONSTRAINT "wallet_total_fits" CHECK ("wallets"."available_cents"::numeric + "wallets"."reserved_cents"::numeric <= 9223372036854775807)
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"user_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlists_user_id_artist_id_pk" PRIMARY KEY("user_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_reservations" ADD CONSTRAINT "cash_reservation_owner" FOREIGN KEY ("order_id","user_id","artist_id") REFERENCES "public"."orders"("id","user_id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_allocations" ADD CONSTRAINT "exit_order_owner" FOREIGN KEY ("order_id","user_id","artist_id") REFERENCES "public"."orders"("id","user_id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_allocations" ADD CONSTRAINT "exit_lot_owner" FOREIGN KEY ("lot_id","user_id","artist_id") REFERENCES "public"."position_lots"("id","user_id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_user_id_wallets_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."wallets"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_order_owner" FOREIGN KEY ("order_id","user_id","artist_id") REFERENCES "public"."orders"("id","user_id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listener_snapshots" ADD CONSTRAINT "listener_snapshots_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_wallets_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."wallets"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "order_baseline_artist" FOREIGN KEY ("placement_snapshot_id","artist_id") REFERENCES "public"."listener_snapshots"("id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_lots" ADD CONSTRAINT "lot_settled_buy_owner" FOREIGN KEY ("buy_order_id","user_id","artist_id") REFERENCES "public"."settlements"("order_id","user_id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_lots" ADD CONSTRAINT "lot_entry_artist" FOREIGN KEY ("entry_snapshot_id","artist_id") REFERENCES "public"."listener_snapshots"("id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_events" ADD CONSTRAINT "receipt_events_lot_id_position_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."position_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounding_events" ADD CONSTRAINT "rounding_exit_allocation" FOREIGN KEY ("order_id","lot_id") REFERENCES "public"."exit_allocations"("order_id","lot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_batches" ADD CONSTRAINT "batch_snapshot_artist" FOREIGN KEY ("snapshot_id","artist_id") REFERENCES "public"."listener_snapshots"("id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlement_order_owner" FOREIGN KEY ("order_id","user_id","artist_id") REFERENCES "public"."orders"("id","user_id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlement_batch_artist" FOREIGN KEY ("batch_id","artist_id") REFERENCES "public"."settlement_batches"("id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_annotations" ADD CONSTRAINT "snapshot_annotations_snapshot_id_listener_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."listener_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_annotations" ADD CONSTRAINT "snapshot_annotations_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_reservation_user_idx" ON "cash_reservations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "exit_lot_idx" ON "exit_allocations" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "starting_grant_once" ON "ledger_events" USING btree ("user_id") WHERE "ledger_events"."kind" = 'starting_grant';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_order_kind_once" ON "ledger_events" USING btree ("order_id","kind") WHERE "ledger_events"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_user_history_idx" ON "ledger_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "snapshot_history_idx" ON "listener_snapshots" USING btree ("artist_id","observed_at");--> statement-breakpoint
CREATE INDEX "order_artist_queue_idx" ON "orders" USING btree ("artist_id","earliest_cutoff","accepted_at") WHERE "orders"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "order_user_history_idx" ON "orders" USING btree ("user_id","accepted_at");--> statement-breakpoint
CREATE INDEX "lot_user_artist_idx" ON "position_lots" USING btree ("user_id","artist_id");--> statement-breakpoint
CREATE INDEX "receipt_created_idx" ON "receipt_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "settlement_batch_idx" ON "settlements" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "annotation_snapshot_idx" ON "snapshot_annotations" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "tracks_artist_idx" ON "tracks" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");