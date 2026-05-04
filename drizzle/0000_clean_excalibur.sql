CREATE TYPE "public"."assembly_status" AS ENUM('draft', 'provisional', 'definitive');--> statement-breakpoint
CREATE TYPE "public"."assembly_type" AS ENUM('AGO', 'AGE', 'AGET');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'pending_review', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('platform', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."amendment_status" AS ENUM('draft', 'pending_review', 'rejected_secretaria', 'formal', 'accepted_secretaria', 'accepted_proponent', 'rejected_proponent', 'approved_vote', 'rejected_vote');--> statement-breakpoint
CREATE TYPE "public"."amendment_type" AS ENUM('regular', 'formal');--> statement-breakpoint
CREATE TABLE "accounts" (
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_id_account_id_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role_id" text,
	"external_role" text,
	"external_name" text,
	"external_initials" text,
	"university" text,
	"last_role_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"permission_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_unique" UNIQUE("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "assemblies" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"type" "assembly_type" NOT NULL,
	"status" "assembly_status" DEFAULT 'draft' NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"location" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assemblies_number_unique" UNIQUE("number"),
	CONSTRAINT "chk_assemblies_dates" CHECK ("assemblies"."end_date" >= "assemblies"."start_date")
);
--> statement-breakpoint
CREATE TABLE "agenda_items" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"parent_id" text,
	"title" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"allow_document_submission" boolean DEFAULT false NOT NULL,
	"document_submission_deadline" timestamp with time zone,
	"allow_amendments" boolean DEFAULT false NOT NULL,
	"amendment_deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"agenda_item_id" text NOT NULL,
	"type" "document_type" NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"content_version" text DEFAULT '' NOT NULL,
	"content_history" jsonb DEFAULT '[]'::jsonb,
	"file_url" text,
	"submitted_by" text,
	"proponent_id" text,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_documents_content" CHECK (("documents"."type" = 'platform' AND "documents"."content" IS NOT NULL) OR ("documents"."type" = 'pdf' AND "documents"."file_url" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "amendments" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"submitted_by" text NOT NULL,
	"content_patch" text NOT NULL,
	"base_content_version" text NOT NULL,
	"justification" text NOT NULL,
	"type" "amendment_type" DEFAULT 'regular' NOT NULL,
	"status" "amendment_status" DEFAULT 'draft' NOT NULL,
	"parent_amendment_id" text,
	"submitted_at" timestamp with time zone,
	"secretaria_reviewed_at" timestamp with time zone,
	"proponent_decided_at" timestamp with time zone,
	"vote_recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_agenda_item_id_agenda_items_id_fk" FOREIGN KEY ("agenda_item_id") REFERENCES "public"."agenda_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_proponent_id_users_id_fk" FOREIGN KEY ("proponent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_accounts_user_id" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_verifications_expires_at" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_role_permissions_role_id" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_assemblies_status" ON "assemblies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_assemblies_number" ON "assemblies" USING btree ("number");--> statement-breakpoint
CREATE INDEX "idx_agenda_items_assembly_id" ON "agenda_items" USING btree ("assembly_id");--> statement-breakpoint
CREATE INDEX "idx_agenda_items_parent_id" ON "agenda_items" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_documents_agenda_item_id" ON "documents" USING btree ("agenda_item_id");--> statement-breakpoint
CREATE INDEX "idx_documents_status" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_documents_submitted_by" ON "documents" USING btree ("submitted_by");--> statement-breakpoint
CREATE INDEX "idx_amendments_document_id" ON "amendments" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_amendments_submitted_by" ON "amendments" USING btree ("submitted_by");--> statement-breakpoint
CREATE INDEX "idx_amendments_status" ON "amendments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_amendments_parent_amendment_id" ON "amendments" USING btree ("parent_amendment_id");--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "fk_agenda_items_parent" FOREIGN KEY ("parent_id") REFERENCES "agenda_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "fk_amendments_parent" FOREIGN KEY ("parent_amendment_id") REFERENCES "amendments"("id") ON DELETE CASCADE;