-- Cache, immutable ledger and live cash holds must agree at transaction commit.
-- The services lock member -> user -> wallet -> order before mutating them.
CREATE FUNCTION fp_assert_wallet_accounting(account_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE w wallets; a numeric; r numeric; held numeric;
BEGIN
  SELECT * INTO w FROM wallets WHERE user_id=account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(available_delta::numeric),0),coalesce(sum(reserved_delta::numeric),0)
    INTO a,r FROM ledger_events WHERE user_id=account_id;
  SELECT coalesce(sum(amount_cents::numeric),0) INTO held FROM cash_reservations WHERE user_id=account_id AND status='held';
  IF w.available_cents::numeric<>a OR w.reserved_cents::numeric<>r OR w.reserved_cents::numeric<>held THEN
    RAISE EXCEPTION 'Wallet, ledger and cash holds disagree' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM cash_reservations c JOIN orders o ON o.id=c.order_id
      WHERE c.user_id=account_id AND c.status='held' AND o.status<>'queued') THEN
    RAISE EXCEPTION 'Terminal order retains a cash hold' USING ERRCODE='23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION fp_wallet_accounting_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fp_assert_wallet_accounting(NEW.user_id);
  IF TG_OP='UPDATE' THEN
    IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
      PERFORM fp_assert_wallet_accounting(OLD.user_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_accounting AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_wallet_accounting_trigger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_accounting AFTER INSERT ON ledger_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_wallet_accounting_trigger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER reservation_accounting AFTER INSERT OR UPDATE ON cash_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_wallet_accounting_trigger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_cash_hold_accounting AFTER UPDATE ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_wallet_accounting_trigger();
--> statement-breakpoint
-- Validate historical wallets before enabling the release; never silently repair.
DO $$
DECLARE account_id text;
BEGIN
  FOR account_id IN SELECT user_id FROM wallets LOOP
    PERFORM fp_assert_wallet_accounting(account_id);
  END LOOP;
END;
$$;
