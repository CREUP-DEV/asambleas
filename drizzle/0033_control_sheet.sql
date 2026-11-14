CREATE TYPE "public"."cea_position" AS ENUM('accept', 'transact', 'reject', 'lapse');--> statement-breakpoint
CREATE TYPE "public"."control_sheet_result" AS ENUM('withdrawn', 'lapsed', 'not_applicable');--> statement-breakpoint
CREATE TABLE "control_sheet_amendments" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"amendment_id" text NOT NULL,
	"cea_position" "cea_position",
	"cea_position_updated_at" timestamp with time zone,
	"cea_position_updated_by_user_id" text,
	"treated_at" timestamp with time zone,
	"treated_by_user_id" text,
	"treated_updated_at" timestamp with time zone,
	"observations" text DEFAULT '' NOT NULL,
	"observations_updated_at" timestamp with time zone,
	"observations_updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_sheet_items" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"agenda_item_id" text NOT NULL,
	"listed" boolean DEFAULT false NOT NULL,
	"listed_updated_at" timestamp with time zone,
	"manual_result" "control_sheet_result",
	"result_updated_at" timestamp with time zone,
	"treated_at" timestamp with time zone,
	"treated_by_user_id" text,
	"progress_updated_at" timestamp with time zone,
	"observations" text DEFAULT '' NOT NULL,
	"observations_updated_at" timestamp with time zone,
	"observations_updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_sheet_observation_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"item_row_id" text,
	"amendment_row_id" text,
	"text" text NOT NULL,
	"author_user_id" text,
	"impersonation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_sheet_revisions_one_row" CHECK (("control_sheet_observation_revisions"."item_row_id" is null) <> ("control_sheet_observation_revisions"."amendment_row_id" is null))
);
--> statement-breakpoint
ALTER TABLE "control_sheet_amendments" ADD CONSTRAINT "control_sheet_amendments_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_amendments" ADD CONSTRAINT "control_sheet_amendments_amendment_id_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_amendments" ADD CONSTRAINT "control_sheet_amendments_cea_position_updated_by_user_id_users_id_fk" FOREIGN KEY ("cea_position_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_amendments" ADD CONSTRAINT "control_sheet_amendments_treated_by_user_id_users_id_fk" FOREIGN KEY ("treated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_amendments" ADD CONSTRAINT "control_sheet_amendments_observations_updated_by_user_id_users_id_fk" FOREIGN KEY ("observations_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_items" ADD CONSTRAINT "control_sheet_items_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_items" ADD CONSTRAINT "control_sheet_items_agenda_item_id_agenda_items_id_fk" FOREIGN KEY ("agenda_item_id") REFERENCES "public"."agenda_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_items" ADD CONSTRAINT "control_sheet_items_treated_by_user_id_users_id_fk" FOREIGN KEY ("treated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_items" ADD CONSTRAINT "control_sheet_items_observations_updated_by_user_id_users_id_fk" FOREIGN KEY ("observations_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_observation_revisions" ADD CONSTRAINT "control_sheet_observation_revisions_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_observation_revisions" ADD CONSTRAINT "control_sheet_observation_revisions_item_row_id_control_sheet_items_id_fk" FOREIGN KEY ("item_row_id") REFERENCES "public"."control_sheet_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_observation_revisions" ADD CONSTRAINT "control_sheet_observation_revisions_amendment_row_id_control_sheet_amendments_id_fk" FOREIGN KEY ("amendment_row_id") REFERENCES "public"."control_sheet_amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_observation_revisions" ADD CONSTRAINT "control_sheet_observation_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sheet_observation_revisions" ADD CONSTRAINT "control_sheet_observation_revisions_impersonation_id_impersonations_id_fk" FOREIGN KEY ("impersonation_id") REFERENCES "public"."impersonations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "control_sheet_amendments_amendment_unique" ON "control_sheet_amendments" USING btree ("amendment_id");--> statement-breakpoint
CREATE INDEX "idx_control_sheet_amendments_assembly" ON "control_sheet_amendments" USING btree ("assembly_id");--> statement-breakpoint
CREATE UNIQUE INDEX "control_sheet_items_item_unique" ON "control_sheet_items" USING btree ("agenda_item_id");--> statement-breakpoint
CREATE INDEX "idx_control_sheet_items_assembly" ON "control_sheet_items" USING btree ("assembly_id");--> statement-breakpoint
CREATE INDEX "idx_control_sheet_revisions_item_row" ON "control_sheet_observation_revisions" USING btree ("item_row_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_control_sheet_revisions_amendment_row" ON "control_sheet_observation_revisions" USING btree ("amendment_row_id","created_at");