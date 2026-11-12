-- One admission transaction, shared by all Better Auth provider paths.
CREATE FUNCTION fp_invite_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invitation beta_invites;
BEGIN
  IF EXISTS (SELECT 1 FROM database_identity WHERE purpose='demo') THEN
    RAISE EXCEPTION 'Demo databases cannot admit accounts' USING ERRCODE='23514';
  END IF;
  NEW.email := lower(trim(NEW.email));
  SELECT * INTO invitation FROM beta_invites WHERE email=NEW.email FOR UPDATE;
  IF NOT FOUND OR invitation.revoked_at IS NOT NULL OR invitation.claimed_by IS NOT NULL
     OR invitation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Beta admission is unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invite_admission BEFORE INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION fp_invite_admission();
--> statement-breakpoint
CREATE FUNCTION fp_claim_invite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE beta_invites SET claimed_by=NEW.id, claimed_at=clock_timestamp() WHERE email=NEW.email;
  INSERT INTO members(user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER claim_invite AFTER INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION fp_claim_invite();
--> statement-breakpoint
CREATE FUNCTION fp_session_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "user" u JOIN members m ON m.user_id=u.id
     WHERE u.id=NEW.user_id AND u.email_verified AND m.status='active') THEN
    RAISE EXCEPTION 'Session admission is unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_admission BEFORE INSERT OR UPDATE ON session FOR EACH ROW EXECUTE FUNCTION fp_session_admission();
--> statement-breakpoint
CREATE FUNCTION fp_member_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status OR NEW.role <> OLD.role THEN
    DELETE FROM session WHERE user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER member_revocation AFTER UPDATE ON members FOR EACH ROW EXECUTE FUNCTION fp_member_revocation();
--> statement-breakpoint
CREATE TRIGGER auth_audit_append_only BEFORE UPDATE OR DELETE ON auth_audit_events FOR EACH ROW EXECUTE FUNCTION fp_append_only();
