CREATE TABLE "listener_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"artist_id" text NOT NULL,
	"source_event_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "observation_status" NOT NULL,
	"reasons" jsonb NOT NULL,
	"validation_version" text NOT NULL,
	"snapshot_id" text,
	"corrects_observation_id" text,
	"actor_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listener_observations_snapshot_id_unique" UNIQUE("snapshot_id"),
	CONSTRAINT "observation_artist_id" UNIQUE("id","artist_id"),
	CONSTRAINT "observation_source_event" UNIQUE("artist_id","source_event_key"),
	CONSTRAINT "observation_envelope" CHECK (length("listener_observations"."source_event_key") BETWEEN 1 AND 200 AND "listener_observations"."payload_hash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("listener_observations"."payload") = 'object' AND "listener_observations"."validation_version" = 'spotify-listeners-v1'),
	CONSTRAINT "observation_result" CHECK (CASE WHEN jsonb_typeof("listener_observations"."reasons") = 'array' THEN
    ("listener_observations"."status" = 'accepted' AND "listener_observations"."snapshot_id" IS NOT NULL AND jsonb_array_length("listener_observations"."reasons") = 0) OR
    ("listener_observations"."status" = 'quarantined' AND "listener_observations"."snapshot_id" IS NULL AND jsonb_array_length("listener_observations"."reasons") > 0) ELSE false END),
	CONSTRAINT "observation_no_self_correction" CHECK ("listener_observations"."corrects_observation_id" IS NULL OR "listener_observations"."corrects_observation_id" <> "listener_observations"."id")
);
--> statement-breakpoint
ALTER TABLE "listener_observations" ADD CONSTRAINT "listener_observations_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listener_observations" ADD CONSTRAINT "listener_observations_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listener_observations" ADD CONSTRAINT "observation_quote_artist" FOREIGN KEY ("snapshot_id","artist_id") REFERENCES "public"."listener_snapshots"("id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listener_observations" ADD CONSTRAINT "observation_correction_artist" FOREIGN KEY ("corrects_observation_id","artist_id") REFERENCES "public"."listener_observations"("id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observation_review_idx" ON "listener_observations" USING btree ("status","received_at");