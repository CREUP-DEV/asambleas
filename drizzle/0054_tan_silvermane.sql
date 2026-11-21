CREATE TYPE "public"."form_correction_status" AS ENUM('pending', 'applied', 'rejected', 'withdrawn', 'void');--> statement-breakpoint
CREATE TABLE "document_form_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"document_id" text NOT NULL,
	"from_version_id" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"reason" text NOT NULL,
	"status" "form_correction_status" DEFAULT 'pending' NOT NULL,
	"made_as" text NOT NULL,
	"proposed_by_user_id" text,
	"result_version_id" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "replaces_version_id" text;--> statement-breakpoint
ALTER TABLE "document_form_corrections" ADD CONSTRAINT "document_form_corrections_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_form_corrections" ADD CONSTRAINT "document_form_corrections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_form_corrections" ADD CONSTRAINT "document_form_corrections_from_version_id_document_versions_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_form_corrections" ADD CONSTRAINT "document_form_corrections_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_form_corrections" ADD CONSTRAINT "document_form_corrections_result_version_id_document_versions_id_fk" FOREIGN KEY ("result_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_form_corrections" ADD CONSTRAINT "document_form_corrections_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_form_corrections_document_idx" ON "document_form_corrections" USING btree ("document_id","created_at");--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_replaces_version_id_document_versions_id_fk" FOREIGN KEY ("replaces_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;