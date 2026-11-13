-- Historical quotes stay immutable. Unsafe legacy correction chains pause new
-- intake/admission for review rather than rewriting quotes or completed trades.
CREATE FUNCTION fp_observation_incident_ancestry(parent_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT * FROM listener_observations WHERE id=parent_id
    UNION
    SELECT p.* FROM listener_observations p JOIN chain c ON p.id=c.corrects_observation_id
  )
  SELECT EXISTS(SELECT 1 FROM chain WHERE status='accepted' OR
    reasons ? 'accepted_correction_requires_incident_review' OR reasons ? 'disputed_history_requires_incident_review')
$$;
--> statement-breakpoint
CREATE FUNCTION fp_observation_same_candidate(candidate jsonb, reviewed jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(candidate->'listenerCount',candidate->'provider',candidate->'metric',candidate->'providerArtistId',
    candidate->'sourceUrl',candidate->'parserVersion',candidate->'observedAt',candidate->'fetchedAt',candidate->'sourceUpdatedAt',candidate->'evidence')
    = jsonb_build_array(reviewed->'listenerCount',reviewed->'provider',reviewed->'metric',reviewed->'providerArtistId',
    reviewed->'sourceUrl',reviewed->'parserVersion',reviewed->'observedAt',reviewed->'fetchedAt',reviewed->'sourceUpdatedAt',reviewed->'evidence')
$$;
--> statement-breakpoint
CREATE FUNCTION fp_observation_artist_needs_review(artist text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM listener_observations c JOIN listener_observations p ON p.id=c.corrects_observation_id
    WHERE c.artist_id=artist AND c.status='accepted' AND
    (fp_observation_incident_ancestry(p.id) OR
      (p.reasons ? 'listener_change_requires_review' AND NOT fp_observation_same_candidate(c.payload,p.payload))))
$$;
--> statement-breakpoint
CREATE FUNCTION fp_observation_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent listener_observations;
BEGIN
  IF NEW.status <> 'accepted' THEN RETURN NEW; END IF;
  IF fp_observation_artist_needs_review(NEW.artist_id) THEN
    RAISE EXCEPTION 'historical source corrections require incident review' USING ERRCODE='23514';
  END IF;
  IF NEW.corrects_observation_id IS NOT NULL THEN
    IF fp_observation_incident_ancestry(NEW.corrects_observation_id) THEN
      RAISE EXCEPTION 'accepted correction ancestry requires incident review' USING ERRCODE='23514';
    END IF;
    SELECT * INTO parent FROM listener_observations WHERE id=NEW.corrects_observation_id AND artist_id=NEW.artist_id;
    IF parent.reasons ? 'listener_change_requires_review' AND NOT fp_observation_same_candidate(NEW.payload,parent.payload) THEN
      RAISE EXCEPTION 'outlier confirmation must match its candidate' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER observation_review_guard BEFORE INSERT ON listener_observations
FOR EACH ROW EXECUTE FUNCTION fp_observation_review_guard();
