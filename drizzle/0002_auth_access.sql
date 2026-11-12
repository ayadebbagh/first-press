CREATE TABLE "action_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "action_limit_nonnegative" CHECK ("action_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beta_invites" (
	"email" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "beta_invites_claimed_by_unique" UNIQUE("claimed_by"),
	CONSTRAINT "invite_normalized_email" CHECK ("beta_invites"."email" = lower(trim("beta_invites"."email")) AND length("beta_invites"."email") BETWEEN 3 AND 254),
	CONSTRAINT "invite_claim_pair" CHECK (("beta_invites"."claimed_by" IS NULL AND "beta_invites"."claimed_at" IS NULL) OR ("beta_invites"."claimed_by" IS NOT NULL AND "beta_invites"."claimed_at" IS NOT NULL)),
	CONSTRAINT "invite_expiry" CHECK ("beta_invites"."expires_at" > "beta_invites"."created_at")
);
--> statement-breakpoint
CREATE TABLE "mail_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"purpose" text NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lease_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_purpose" CHECK ("mail_outbox"."purpose" IN ('verification', 'reset')),
	CONSTRAINT "mail_state" CHECK ("mail_outbox"."status" IN ('queued', 'sending', 'sent', 'failed') AND "mail_outbox"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "mail_payload" CHECK (("mail_outbox"."status" IN ('queued', 'sending') AND "mail_outbox"."body" IS NOT NULL) OR ("mail_outbox"."status" IN ('sent', 'failed') AND "mail_outbox"."body" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "beta_invites" ADD CONSTRAINT "beta_invites_claimed_by_user_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_audit_target_idx" ON "auth_audit_events" USING btree ("target","created_at");--> statement-breakpoint
CREATE INDEX "mail_queue_idx" ON "mail_outbox" USING btree ("status","available_at");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "member_status" CHECK ("members"."status" IN ('active', 'suspended'));