CREATE TYPE "public"."member_kind" AS ENUM('asociado', 'sectorial', 'executive', 'other');--> statement-breakpoint
CREATE TYPE "public"."member_source" AS ENUM('intranet', 'manual');--> statement-breakpoint
CREATE TYPE "public"."assembly_status" AS ENUM('draft', 'convened', 'in_session', 'closed');--> statement-breakpoint
CREATE TYPE "public"."assembly_type" AS ENUM('AGO', 'AGE', 'AGET');--> statement-breakpoint
CREATE TYPE "public"."milestone_key" AS ENUM('convocation', 'agenda_requests_close', 'agenda_final', 'documents_close', 'documents_publish', 'amendments_open', 'amendments_close', 'candidacies_close');--> statement-breakpoint
CREATE TYPE "public"."document_format" AS ENUM('structured', 'file');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('positioning', 'resolution', 'internal_motion', 'executive_report', 'regulation', 'statutes', 'budget', 'accounts', 'work_plan', 'agreement', 'report', 'minutes', 'candidacy', 'venue', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'submitted', 'published', 'withdrawn', 'postponed');--> statement-breakpoint
CREATE TYPE "public"."majority" AS ENUM('simple', 'absolute', 'two_thirds');--> statement-breakpoint
CREATE TYPE "public"."document_version_kind" AS ENUM('draft', 'base', 'consolidated');--> statement-breakpoint
CREATE TYPE "public"."acceptance_decision" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."acceptance_role" AS ENUM('author', 'proponent');--> statement-breakpoint
CREATE TYPE "public"."admission_status" AS ENUM('pending', 'admitted', 'inadmissible');--> statement-breakpoint
CREATE TYPE "public"."amendment_kind" AS ENUM('partial', 'formal', 'totality_return', 'totality_alternative', 'transactional');--> statement-breakpoint
CREATE TYPE "public"."amendment_status" AS ENUM('draft', 'submitted', 'inadmissible', 'withdrawn', 'transacted', 'lapsed', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."approval_method" AS ENUM('proponent', 'assent', 'vote', 'formal');--> statement-breakpoint
CREATE TYPE "public"."proponent_position" AS ENUM('pending', 'accept', 'reject', 'transact');--> statement-breakpoint
CREATE TYPE "public"."amendment_relation_kind" AS ENUM('incompatible', 'duplicate', 'depends_on', 'consequence_of', 'subsumed_by', 'same_in_other_document');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('admit_late', 'inadmission', 'unify', 'agenda_change', 'other');--> statement-breakpoint
CREATE TYPE "public"."decision_method" AS ENUM('mesa', 'secretaria', 'assent', 'vote');--> statement-breakpoint
CREATE TYPE "public"."vote_method" AS ENUM('assent', 'show_of_hands', 'secret', 'roll_call', 'portal');--> statement-breakpoint
CREATE TYPE "public"."vote_result" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."vote_subject" AS ENUM('amendment', 'document', 'decision', 'other');--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "member_kind" DEFAULT 'asociado' NOT NULL,
	"acronym" text NOT NULL,
	"name" text NOT NULL,
	"university" text,
	"region" text,
	"source" "member_source" DEFAULT 'manual' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"convocation_intro" text,
	"agenda_finalized_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{"amendmentVisibility":"after_close","positionVisibility":"session","acceptedAmendments":"assent","tieRule":"rejected","denominator":"valid_votes"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_assemblies_dates" CHECK ("assemblies"."end_date" >= "assemblies"."start_date")
);
--> statement-breakpoint
CREATE TABLE "assembly_milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"key" "milestone_key" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_state" (
	"assembly_id" text PRIMARY KEY NOT NULL,
	"agenda_item_id" text,
	"document_id" text,
	"amendment_id" text,
	"vote_id" text,
	"message" text,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agenda_items" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"parent_id" text,
	"title" text NOT NULL,
	"description" text,
	"order" integer DEFAULT 0 NOT NULL,
	"accepts_submissions" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"number" integer NOT NULL,
	"kind" "document_version_kind" NOT NULL,
	"blocks" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"agenda_item_id" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "document_kind" NOT NULL,
	"format" "document_format" NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"reference" text,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"proponent_member_id" text,
	"submitted_by_user_id" text,
	"amendable" boolean DEFAULT false NOT NULL,
	"voted" boolean DEFAULT true NOT NULL,
	"majority" "majority" DEFAULT 'simple' NOT NULL,
	"amendments_open_at" timestamp with time zone,
	"amendments_close_at" timestamp with time zone,
	"working_version_id" text,
	"base_version_id" text,
	"consolidated_version_id" text,
	"final_vote_id" text,
	"file_url" text,
	"file_name" text,
	"carried_from_document_id" text,
	"submitted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "amendment_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"amendment_id" text NOT NULL,
	"member_id" text NOT NULL,
	"role" "acceptance_role" NOT NULL,
	"decision" "acceptance_decision" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"recorded_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "amendment_authors" (
	"amendment_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "amendment_authors_amendment_id_member_id_pk" PRIMARY KEY("amendment_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "amendment_positions" (
	"amendment_id" text PRIMARY KEY NOT NULL,
	"position" "proponent_position" DEFAULT 'pending' NOT NULL,
	"comment" text,
	"decided_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "amendment_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"kind" "amendment_relation_kind" NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "amendment_sources" (
	"transactional_id" text NOT NULL,
	"source_id" text NOT NULL,
	CONSTRAINT "amendment_sources_transactional_id_source_id_pk" PRIMARY KEY("transactional_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "amendments" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"base_version_id" text NOT NULL,
	"number" integer,
	"member_seq" integer,
	"code" text,
	"kind" "amendment_kind" DEFAULT 'partial' NOT NULL,
	"status" "amendment_status" DEFAULT 'draft' NOT NULL,
	"admission" "admission_status" DEFAULT 'pending' NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"ops" jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"justification" text DEFAULT '' NOT NULL,
	"position_key" real DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"submitted_by_user_id" text,
	"submitted_at" timestamp with time zone,
	"approval_method" "approval_method",
	"outcome_vote_id" text,
	"outcome_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"kind" "decision_kind" NOT NULL,
	"method" "decision_method" NOT NULL,
	"vote_id" text,
	"subject_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" text,
	"actor_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"subject_type" "vote_subject" NOT NULL,
	"subject_id" text NOT NULL,
	"method" "vote_method" NOT NULL,
	"in_favor" integer DEFAULT 0 NOT NULL,
	"against" integer DEFAULT 0 NOT NULL,
	"abstentions" integer DEFAULT 0 NOT NULL,
	"blank" integer DEFAULT 0 NOT NULL,
	"invalid" integer DEFAULT 0 NOT NULL,
	"present" integer,
	"majority" "majority" NOT NULL,
	"result" "vote_result" NOT NULL,
	"note" text,
	"recorded_by_user_id" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "member_id" text;--> statement-breakpoint
ALTER TABLE "assembly_milestones" ADD CONSTRAINT "assembly_milestones_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_state" ADD CONSTRAINT "live_state_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_state" ADD CONSTRAINT "live_state_agenda_item_id_agenda_items_id_fk" FOREIGN KEY ("agenda_item_id") REFERENCES "public"."agenda_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_state" ADD CONSTRAINT "live_state_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_state" ADD CONSTRAINT "live_state_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "fk_agenda_items_parent" FOREIGN KEY ("parent_id") REFERENCES "public"."agenda_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_agenda_item_id_agenda_items_id_fk" FOREIGN KEY ("agenda_item_id") REFERENCES "public"."agenda_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_proponent_member_id_members_id_fk" FOREIGN KEY ("proponent_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_working_version_id_document_versions_id_fk" FOREIGN KEY ("working_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_base_version_id_document_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_consolidated_version_id_document_versions_id_fk" FOREIGN KEY ("consolidated_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_carried_from_document_id_documents_id_fk" FOREIGN KEY ("carried_from_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_acceptances" ADD CONSTRAINT "amendment_acceptances_amendment_id_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_acceptances" ADD CONSTRAINT "amendment_acceptances_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_acceptances" ADD CONSTRAINT "amendment_acceptances_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_authors" ADD CONSTRAINT "amendment_authors_amendment_id_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_authors" ADD CONSTRAINT "amendment_authors_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_positions" ADD CONSTRAINT "amendment_positions_amendment_id_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_positions" ADD CONSTRAINT "amendment_positions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_relations" ADD CONSTRAINT "amendment_relations_from_id_amendments_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_relations" ADD CONSTRAINT "amendment_relations_to_id_amendments_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_relations" ADD CONSTRAINT "amendment_relations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_sources" ADD CONSTRAINT "amendment_sources_transactional_id_amendments_id_fk" FOREIGN KEY ("transactional_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_sources" ADD CONSTRAINT "amendment_sources_source_id_amendments_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_base_version_id_document_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_vote_id_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."votes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "members_acronym_unique" ON "members" USING btree ("acronym");--> statement-breakpoint
CREATE INDEX "idx_members_kind" ON "members" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "assemblies_type_number_unique" ON "assemblies" USING btree ("type","number");--> statement-breakpoint
CREATE INDEX "idx_assemblies_status" ON "assemblies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_assemblies_start_date" ON "assemblies" USING btree ("start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "assembly_milestones_key_unique" ON "assembly_milestones" USING btree ("assembly_id","key");--> statement-breakpoint
CREATE INDEX "idx_agenda_items_assembly_id" ON "agenda_items" USING btree ("assembly_id");--> statement-breakpoint
CREATE INDEX "idx_agenda_items_parent_id" ON "agenda_items" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_number_unique" ON "document_versions" USING btree ("document_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_assembly_slug_unique" ON "documents" USING btree ("assembly_id","slug");--> statement-breakpoint
CREATE INDEX "idx_documents_agenda_item_id" ON "documents" USING btree ("agenda_item_id");--> statement-breakpoint
CREATE INDEX "idx_documents_status" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_documents_proponent" ON "documents" USING btree ("proponent_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "amendment_acceptances_party_unique" ON "amendment_acceptances" USING btree ("amendment_id","member_id");--> statement-breakpoint
CREATE INDEX "idx_amendment_authors_member" ON "amendment_authors" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "amendment_relations_unique" ON "amendment_relations" USING btree ("from_id","to_id","kind");--> statement-breakpoint
CREATE INDEX "idx_amendment_relations_to" ON "amendment_relations" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "idx_amendment_sources_source" ON "amendment_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_amendments_document_id" ON "amendments" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_amendments_status" ON "amendments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "amendments_document_number_unique" ON "amendments" USING btree ("document_id","number");--> statement-breakpoint
CREATE INDEX "idx_decisions_assembly" ON "decisions" USING btree ("assembly_id");--> statement-breakpoint
CREATE INDEX "idx_events_entity" ON "events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_events_assembly_created" ON "events" USING btree ("assembly_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_votes_assembly" ON "votes" USING btree ("assembly_id");--> statement-breakpoint
CREATE INDEX "idx_votes_subject" ON "votes" USING btree ("subject_type","subject_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;