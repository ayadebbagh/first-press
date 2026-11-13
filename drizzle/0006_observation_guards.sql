CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON listener_observations
FOR EACH ROW EXECUTE FUNCTION fp_append_only();
--> statement-breakpoint
CREATE FUNCTION fp_observation_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quote listener_snapshots; parent listener_observations;
BEGIN
  IF NEW.corrects_observation_id IS NOT NULL THEN
    SELECT * INTO parent FROM listener_observations WHERE id=NEW.corrects_observation_id AND artist_id=NEW.artist_id;
    IF NOT FOUND OR parent.received_at > NEW.received_at OR
      (parent.status='accepted' AND NEW.status='accepted') THEN
      RAISE EXCEPTION 'invalid correction provenance; accepted history requires incident review' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status='accepted' THEN
    SELECT * INTO quote FROM listener_snapshots WHERE id=NEW.snapshot_id AND artist_id=NEW.artist_id;
    IF NOT FOUND OR quote.status <> 'accepted' OR quote.synthetic OR
      quote.reviewed_by IS DISTINCT FROM NEW.actor_id OR quote.accepted_at IS DISTINCT FROM NEW.received_at OR
      quote.evidence->>'observationId' IS DISTINCT FROM NEW.id OR
      quote.listener_count::text IS DISTINCT FROM NEW.payload->>'listenerCount' OR
      quote.provider IS DISTINCT FROM NEW.payload->>'provider' OR quote.metric IS DISTINCT FROM NEW.payload->>'metric' OR
      quote.source_url IS DISTINCT FROM NEW.payload->>'sourceUrl' OR quote.parser_version IS DISTINCT FROM NEW.payload->>'parserVersion' THEN
      RAISE EXCEPTION 'accepted observation must match its immutable quote' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER observation_provenance BEFORE INSERT ON listener_observations
FOR EACH ROW EXECUTE FUNCTION fp_observation_provenance();
