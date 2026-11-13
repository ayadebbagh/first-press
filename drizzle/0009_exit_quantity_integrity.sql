-- Lot caches must reconcile with immutable per-order quantity reservations.
-- No monetary payout occurs at reservation or cancellation.
CREATE FUNCTION fp_assert_lot_exit_accounting(lot_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lot position_lots; held numeric; consumed numeric;
BEGIN
  SELECT * INTO lot FROM position_lots WHERE id=lot_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(quanta::numeric) FILTER(WHERE status='held'),0),
    coalesce(sum(quanta::numeric) FILTER(WHERE status='consumed'),0)
    INTO held,consumed FROM exit_allocations WHERE exit_allocations.lot_id=lot.id;
  IF held<>lot.reserved_quanta::numeric OR lot.remaining_quanta::numeric+consumed<>lot.initial_quanta::numeric THEN
    RAISE EXCEPTION 'Lot quantities and exit allocations disagree' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM exit_allocations a JOIN orders o ON o.id=a.order_id
    WHERE a.lot_id=lot.id AND a.status='held' AND o.status<>'queued') THEN
    RAISE EXCEPTION 'Terminal exit retains held backing' USING ERRCODE='23514';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION fp_lot_exit_accounting_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='position_lots' THEN
    PERFORM fp_assert_lot_exit_accounting(NEW.id);
  ELSIF TG_TABLE_NAME='exit_allocations' THEN
    PERFORM fp_assert_lot_exit_accounting(NEW.lot_id);
  ELSE
    PERFORM fp_assert_lot_exit_accounting(a.lot_id) FROM exit_allocations a WHERE a.order_id=NEW.id ORDER BY a.lot_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lot_exit_accounting AFTER INSERT OR UPDATE ON position_lots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_lot_exit_accounting_trigger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER allocation_lot_accounting AFTER INSERT OR UPDATE ON exit_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_lot_exit_accounting_trigger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_exit_accounting AFTER UPDATE ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_lot_exit_accounting_trigger();
--> statement-breakpoint
DO $$
DECLARE lot_id text;
BEGIN
  FOR lot_id IN SELECT id FROM position_lots ORDER BY id LOOP
    PERFORM fp_assert_lot_exit_accounting(lot_id);
  END LOOP;
END $$;
