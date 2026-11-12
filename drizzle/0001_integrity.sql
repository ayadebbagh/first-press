-- Cross-row provenance and immutability cannot be represented by CHECK constraints.
-- Service transactions and lock ordering still belong to A03-A08.
CREATE FUNCTION fp_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION fp_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE baseline listener_snapshots; a artists;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO baseline FROM listener_snapshots WHERE id = NEW.placement_snapshot_id;
    SELECT * INTO a FROM artists WHERE id = NEW.artist_id;
    IF baseline.status IS DISTINCT FROM 'accepted' OR baseline.synthetic OR a.synthetic
       OR a.status IS DISTINCT FROM 'active' OR baseline.artist_id IS DISTINCT FROM NEW.artist_id
       OR baseline.observed_at > NEW.accepted_at OR baseline.accepted_at > NEW.accepted_at
       OR baseline.observed_at < NEW.accepted_at - interval '24 hours' THEN
      RAISE EXCEPTION 'Order needs a fresh accepted baseline and active artist' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'queued' THEN
      RAISE EXCEPTION 'New orders must be queued' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.user_id,NEW.artist_id,NEW.side,NEW.amount_cents,NEW.exit_basis_points,
       NEW.request_key,NEW.request_hash,NEW.economy_version,NEW.placement_snapshot_id,NEW.accepted_at,NEW.earliest_cutoff)
       IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.artist_id,OLD.side,OLD.amount_cents,OLD.exit_basis_points,
       OLD.request_key,OLD.request_hash,OLD.economy_version,OLD.placement_snapshot_id,OLD.accepted_at,OLD.earliest_cutoff)
       OR OLD.status <> 'queued' THEN
      RAISE EXCEPTION 'Order intent and terminal results are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_guard BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION fp_order_guard();
--> statement-breakpoint
CREATE FUNCTION fp_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders; b settlement_batches; s listener_snapshots;
BEGIN
  SELECT * INTO o FROM orders WHERE id = NEW.order_id;
  SELECT * INTO b FROM settlement_batches WHERE id = NEW.batch_id;
  SELECT * INTO s FROM listener_snapshots WHERE id = b.snapshot_id;
  IF o.status IS DISTINCT FROM 'settled' OR b.status IS DISTINCT FROM 'executed'
     OR o.settled_at IS DISTINCT FROM NEW.executed_at OR b.executed_at IS DISTINCT FROM NEW.executed_at
     OR o.accepted_at >= b.cutoff OR o.accepted_at > b.eligible_through OR o.earliest_cutoff > b.cutoff
     OR s.status IS DISTINCT FROM 'accepted' OR s.synthetic
     OR s.observed_at < b.cutoff OR s.accepted_at > NEW.executed_at
     OR NEW.executed_at >= b.cutoff + interval '2 hours'
     OR (o.side = 'buy' AND NEW.cash_cents IS DISTINCT FROM o.amount_cents) THEN
    RAISE EXCEPTION 'Settlement provenance or execution window is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_guard BEFORE INSERT ON settlements FOR EACH ROW EXECUTE FUNCTION fp_settlement_guard();
--> statement-breakpoint
CREATE FUNCTION fp_lot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders; b settlement_batches; s listener_snapshots;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO o FROM orders WHERE id = NEW.buy_order_id;
    SELECT b0.* INTO b FROM settlement_batches b0 JOIN settlements x ON x.batch_id = b0.id WHERE x.order_id = NEW.buy_order_id;
    SELECT * INTO s FROM listener_snapshots WHERE id = NEW.entry_snapshot_id;
    IF o.side IS DISTINCT FROM 'buy' OR o.status IS DISTINCT FROM 'settled'
       OR NEW.principal_cents IS DISTINCT FROM o.amount_cents OR NEW.entry_snapshot_id IS DISTINCT FROM b.snapshot_id
       OR NEW.entry_listener_count IS DISTINCT FROM s.listener_count OR NEW.created_at IS DISTINCT FROM o.settled_at
       OR NEW.remaining_quanta <> NEW.initial_quanta OR NEW.reserved_quanta <> 0 OR NEW.proceeds_remainder <> 0 THEN
      RAISE EXCEPTION 'Lot must preserve its committed buy execution quote' USING ERRCODE = '23514';
    END IF;
  ELSIF ROW(NEW.id,NEW.buy_order_id,NEW.user_id,NEW.artist_id,NEW.entry_snapshot_id,NEW.principal_cents,
      NEW.entry_listener_count,NEW.initial_quanta,NEW.economy_version,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.buy_order_id,OLD.user_id,OLD.artist_id,OLD.entry_snapshot_id,OLD.principal_cents,
      OLD.entry_listener_count,OLD.initial_quanta,OLD.economy_version,OLD.created_at) THEN
    RAISE EXCEPTION 'Original lot evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lot_guard BEFORE INSERT OR UPDATE ON position_lots FOR EACH ROW EXECUTE FUNCTION fp_lot_guard();
--> statement-breakpoint
CREATE FUNCTION fp_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders;
BEGIN
  SELECT * INTO o FROM orders WHERE id = NEW.order_id;
  IF TG_TABLE_NAME = 'cash_reservations' THEN
    IF o.side IS DISTINCT FROM 'buy' OR NEW.amount_cents IS DISTINCT FROM o.amount_cents THEN
      RAISE EXCEPTION 'Cash reservation must match buy intent' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF o.side IS DISTINCT FROM 'sell' THEN
      RAISE EXCEPTION 'Lot allocation requires a sell order' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.status <> 'held' OR o.status <> 'queued') THEN
    RAISE EXCEPTION 'New reservations must be held for a queued order' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'held' THEN
    RAISE EXCEPTION 'Resolved reservation is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['status','resolved_at','proceeds_cents'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','resolved_at','proceeds_cents']) THEN
    RAISE EXCEPTION 'Reservation intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_reservation_guard BEFORE INSERT OR UPDATE ON cash_reservations FOR EACH ROW EXECUTE FUNCTION fp_reservation_guard();
--> statement-breakpoint
CREATE TRIGGER exit_allocation_guard BEFORE INSERT OR UPDATE ON exit_allocations FOR EACH ROW EXECUTE FUNCTION fp_reservation_guard();
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['database_identity','listener_snapshots','snapshot_annotations','settlements','ledger_events','receipt_events','rounding_events'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fp_append_only()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['orders','position_lots','cash_reservations','exit_allocations'] LOOP
    EXECUTE format('CREATE TRIGGER retain_history BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fp_append_only()', t);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX account_provider_identity ON account (provider_id, account_id);
--> statement-breakpoint
CREATE FUNCTION fp_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s listener_snapshots;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'sealed' THEN
    RAISE EXCEPTION 'New batches must begin sealed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'sealed' OR ROW(NEW.id,NEW.artist_id,NEW.cutoff,NEW.sealed_at,NEW.eligible_through)
       IS DISTINCT FROM ROW(OLD.id,OLD.artist_id,OLD.cutoff,OLD.sealed_at,OLD.eligible_through) THEN
      RAISE EXCEPTION 'Batch watermark and terminal result are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'executed' THEN
    SELECT * INTO s FROM listener_snapshots WHERE id=NEW.snapshot_id;
    IF s.status IS DISTINCT FROM 'accepted' OR s.artist_id IS DISTINCT FROM NEW.artist_id
      OR s.observed_at < NEW.sealed_at OR s.accepted_at > NEW.executed_at OR s.synthetic THEN
      RAISE EXCEPTION 'Batch requires a new accepted observation after sealing' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM settlement_batches WHERE artist_id=NEW.artist_id AND status='executed' AND cutoff>NEW.cutoff) THEN
      RAISE EXCEPTION 'Cannot execute an older batch after a newer batch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER batch_guard BEFORE INSERT OR UPDATE ON settlement_batches FOR EACH ROW EXECUTE FUNCTION fp_batch_guard();
--> statement-breakpoint
CREATE TRIGGER batch_history BEFORE DELETE ON settlement_batches FOR EACH ROW EXECUTE FUNCTION fp_append_only();
