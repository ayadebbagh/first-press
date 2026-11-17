CREATE TABLE "settlement_batch_orders" (
	"batch_id" text NOT NULL,
	"order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "settlement_batch_orders_batch_id_order_id_pk" PRIMARY KEY("batch_id","order_id"),
	CONSTRAINT "batch_member_ordinal" UNIQUE("batch_id","ordinal"),
	CONSTRAINT "batch_member_ordinal_positive" CHECK ("settlement_batch_orders"."ordinal" >= 1)
);
--> statement-breakpoint
ALTER TABLE "settlement_batches" ADD COLUMN "membership_sealed" boolean;--> statement-breakpoint
ALTER TABLE "settlement_batch_orders" ADD CONSTRAINT "batch_member_batch_artist" FOREIGN KEY ("batch_id","artist_id") REFERENCES "public"."settlement_batches"("id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_batch_orders" ADD CONSTRAINT "batch_member_order_owner" FOREIGN KEY ("order_id","user_id","artist_id") REFERENCES "public"."orders"("id","user_id","artist_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_member_order_idx" ON "settlement_batch_orders" USING btree ("order_id");
--> statement-breakpoint
-- A06 / #24: production time has no request, environment or session override.
CREATE FUNCTION public.fp_settlement_clock() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT pg_catalog.clock_timestamp()
$$;
--> statement-breakpoint
-- Shared by preparation service and the binding guard. Legacy accepted quotes
-- without matching C04 evidence cannot acquire new service authority.
CREATE FUNCTION public.fp_batch_snapshot_eligible(batch_id text, quote_id text, at_time timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM settlement_batches b
    JOIN artists a ON a.id=b.artist_id
    JOIN listener_snapshots s ON s.id=quote_id AND s.artist_id=b.artist_id
    JOIN listener_observations c ON c.snapshot_id=s.id AND c.artist_id=b.artist_id
    WHERE b.id=batch_id AND b.membership_sealed IS TRUE
      AND a.status='active' AND NOT a.synthetic AND NOT s.synthetic
      AND NOT EXISTS(SELECT 1 FROM database_identity WHERE purpose='demo')
      AND s.status='accepted' AND c.status='accepted'
      AND s.provider='spotify' AND s.metric='monthly_listeners'
      AND s.listener_count BETWEEN 1 AND 1000000000000
      AND s.observed_at>=b.cutoff AND s.observed_at>=b.sealed_at
      AND s.fetched_at>=s.observed_at AND s.accepted_at>=s.fetched_at
      AND at_time>=b.sealed_at AND s.accepted_at<=at_time
      AND at_time<b.cutoff+interval '2 hours'
      AND (s.source_updated_at IS NULL OR (s.source_updated_at<=s.observed_at AND s.source_updated_at>=at_time-interval '24 hours'))
      AND s.reviewed_by=c.actor_id AND s.accepted_at=c.received_at
      AND c.validation_version IN ('spotify-listeners-v1','spotify-listeners-v2')
      AND s.source_event_key='observation:'||c.id
      AND s.evidence->>'observationId'=c.id
      AND s.evidence->>'validationVersion'=c.validation_version
      AND s.evidence->>'reference'=c.payload->'evidence'->>'reference'
      AND s.evidence->>'sha256'=c.payload->'evidence'->>'sha256'
      AND length(s.evidence->>'reference')>0 AND s.evidence->>'sha256' ~ '^[a-f0-9]{64}$'
      AND s.parser_version=c.payload->>'parserVersion' AND length(s.parser_version)>0
      AND s.listener_count::text=c.payload->>'listenerCount'
      AND s.provider=c.payload->>'provider' AND s.metric=c.payload->>'metric'
      AND c.payload->>'providerArtistId'=a.spotify_artist_id
      AND s.source_url='https://open.spotify.com/artist/'||a.spotify_artist_id
      AND s.source_url=c.payload->>'sourceUrl'
      AND s.observed_at=(c.payload->>'observedAt')::timestamptz
      AND s.fetched_at=(c.payload->>'fetchedAt')::timestamptz
      AND s.source_updated_at IS NOT DISTINCT FROM (c.payload->>'sourceUpdatedAt')::timestamptz
      AND NOT EXISTS(SELECT 1 FROM snapshot_annotations n JOIN listener_snapshots q ON q.id=n.snapshot_id
        WHERE q.artist_id=b.artist_id AND n.kind='disputed')
      AND NOT fp_observation_artist_needs_review(b.artist_id)
      AND NOT EXISTS(SELECT 1 FROM settlement_batches newer WHERE newer.artist_id=b.artist_id
        AND newer.status='executed' AND newer.cutoff>b.cutoff)
      AND NOT EXISTS(SELECT 1 FROM settlement_batches used WHERE used.id<>b.id AND used.snapshot_id=s.id)
  );
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fp_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s listener_snapshots; watermark timestamptz; binding_time timestamptz;
BEGIN
  IF TG_OP='INSERT' THEN
    -- Even an empty new seal must serialize with order admission. Member-row
    -- guards alone cannot supply this lock when there are no eligible orders.
    -- Legacy NULL historical fixtures retain their original admission path.
    IF NEW.membership_sealed IS FALSE THEN
      PERFORM 1 FROM artists WHERE id=NEW.artist_id FOR UPDATE;
    END IF;
    IF NEW.status<>'sealed' OR NEW.membership_sealed IS TRUE THEN
      RAISE EXCEPTION 'New batches must begin sealed with legacy or building membership' USING ERRCODE='23514';
    END IF;
    IF NEW.membership_sealed IS FALSE AND NEW.snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'A new service batch must collect after its membership seal' USING ERRCODE='23514';
    END IF;
  ELSE
    IF OLD.status<>'sealed' OR ROW(NEW.id,NEW.artist_id,NEW.cutoff,NEW.sealed_at,NEW.eligible_through)
      IS DISTINCT FROM ROW(OLD.id,OLD.artist_id,OLD.cutoff,OLD.sealed_at,OLD.eligible_through) THEN
      RAISE EXCEPTION 'Batch watermark and terminal result are immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.membership_sealed IS NULL AND NEW.membership_sealed IS NOT NULL
      OR OLD.membership_sealed IS TRUE AND NEW.membership_sealed IS DISTINCT FROM true
      OR OLD.membership_sealed IS FALSE AND NEW.membership_sealed IS NULL THEN
      RAISE EXCEPTION 'Legacy membership and finalized seals are immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.membership_sealed IS FALSE AND NEW.membership_sealed IS TRUE THEN
      IF NEW.status<>'sealed' OR NEW.snapshot_id IS NOT NULL THEN
        RAISE EXCEPTION 'Finalize membership before quote binding or terminal status' USING ERRCODE='23514';
      END IF;
      SELECT coalesce(max(accepted_at),NEW.cutoff-interval '1 microsecond') INTO watermark FROM orders
        WHERE artist_id=NEW.artist_id AND status='queued' AND economy_version='backing-v1'
          AND accepted_at<NEW.cutoff AND earliest_cutoff<=NEW.cutoff;
      IF NEW.eligible_through IS DISTINCT FROM watermark OR EXISTS (
        WITH expected AS (
          SELECT id AS order_id,user_id,artist_id,row_number() OVER(ORDER BY accepted_at,id COLLATE "C")::integer AS ordinal
          FROM orders WHERE artist_id=NEW.artist_id AND status='queued' AND economy_version='backing-v1'
            AND accepted_at<NEW.cutoff AND earliest_cutoff<=NEW.cutoff
        ), actual AS (SELECT * FROM settlement_batch_orders WHERE batch_id=NEW.id)
        SELECT 1 FROM expected e FULL JOIN actual m USING(order_id)
          WHERE ROW(e.user_id,e.artist_id,e.ordinal) IS DISTINCT FROM ROW(m.user_id,m.artist_id,m.ordinal)
      ) THEN
        RAISE EXCEPTION 'Membership must freeze the complete eligible order set and exact watermark' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.membership_sealed IS FALSE AND (NEW.status<>'sealed' OR NEW.snapshot_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Building membership cannot bind or resolve' USING ERRCODE='23514';
    END IF;
    IF OLD.membership_sealed IS NULL AND NEW.status='sealed' AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
      RAISE EXCEPTION 'Legacy batches cannot acquire a new service quote binding' USING ERRCODE='23514';
    END IF;
    IF OLD.membership_sealed IS TRUE AND OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
      RAISE EXCEPTION 'A bound service quote is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.membership_sealed IS TRUE AND OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL THEN
      IF OLD.membership_sealed IS NOT TRUE OR NEW.status<>'sealed' THEN
        RAISE EXCEPTION 'Bind a quote only after finalization in a sealed service batch' USING ERRCODE='23514';
      END IF;
      binding_time := public.fp_settlement_clock();
      IF binding_time>=NEW.cutoff+interval '2 hours' THEN
        RAISE EXCEPTION 'The batch binding window ended' USING ERRCODE='FP001',CONSTRAINT='batch_binding_expired';
      END IF;
      IF NOT public.fp_batch_snapshot_eligible(NEW.id,NEW.snapshot_id,binding_time) THEN
        RAISE EXCEPTION 'Batch quote requires matching current C04 evidence' USING ERRCODE='23514',CONSTRAINT='batch_snapshot_eligible';
      END IF;
    END IF;
  END IF;
  -- Retain the original logical-time execution guards for historical NULL
  -- fixtures. This migration does not implement an execution entry point.
  IF NEW.status='executed' THEN
    SELECT * INTO s FROM listener_snapshots WHERE id=NEW.snapshot_id;
    IF s.status IS DISTINCT FROM 'accepted' OR s.artist_id IS DISTINCT FROM NEW.artist_id
      OR s.observed_at<NEW.sealed_at OR s.accepted_at>NEW.executed_at OR s.synthetic THEN
      RAISE EXCEPTION 'Batch requires a new accepted observation after sealing' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM settlement_batches WHERE artist_id=NEW.artist_id AND status='executed' AND cutoff>NEW.cutoff) THEN
      RAISE EXCEPTION 'Cannot execute an older batch after a newer batch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION fp_batch_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b settlement_batches; o orders;
BEGIN
  -- Same artist-first serialization as admission, cancellation and preparation.
  PERFORM 1 FROM artists WHERE id=NEW.artist_id FOR UPDATE;
  SELECT * INTO b FROM settlement_batches WHERE id=NEW.batch_id FOR UPDATE;
  SELECT * INTO o FROM orders WHERE id=NEW.order_id;
  IF b.membership_sealed IS DISTINCT FROM false OR b.status IS DISTINCT FROM 'sealed'
    OR b.artist_id IS DISTINCT FROM NEW.artist_id OR o.artist_id IS DISTINCT FROM NEW.artist_id
    OR o.user_id IS DISTINCT FROM NEW.user_id OR o.status IS DISTINCT FROM 'queued'
    OR o.economy_version IS DISTINCT FROM 'backing-v1' OR o.accepted_at>=b.cutoff
    OR o.accepted_at>b.eligible_through OR o.earliest_cutoff>b.cutoff THEN
    RAISE EXCEPTION 'Membership requires an eligible queued order in its owning building seal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER batch_member_guard BEFORE INSERT ON settlement_batch_orders
FOR EACH ROW EXECUTE FUNCTION fp_batch_member_guard();
--> statement-breakpoint
CREATE TRIGGER batch_member_append_only BEFORE UPDATE OR DELETE ON settlement_batch_orders
FOR EACH ROW EXECUTE FUNCTION fp_append_only();
--> statement-breakpoint
CREATE FUNCTION fp_batch_membership_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE finalized boolean;
BEGIN
  IF TG_TABLE_NAME='settlement_batches' THEN
    SELECT membership_sealed INTO finalized FROM settlement_batches WHERE id=NEW.id;
  ELSE
    SELECT membership_sealed INTO finalized FROM settlement_batches WHERE id=NEW.batch_id;
  END IF;
  IF finalized IS FALSE OR (TG_TABLE_NAME='settlement_batch_orders' AND finalized IS NOT TRUE) THEN
    RAISE EXCEPTION 'Service membership must finalize in its owning transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER batch_membership_finalized AFTER INSERT OR UPDATE ON settlement_batches
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_batch_membership_finalized();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER batch_member_finalized AFTER INSERT ON settlement_batch_orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_batch_membership_finalized();
