CREATE TABLE "agreement_record_signings" (
	"document_id" text PRIMARY KEY NOT NULL,
	"version_id" text,
	"prepared_file" text,
	"prepared_at" timestamp with time zone,
	"prepared_by_user_id" text,
	"prepared_with_image" boolean DEFAULT false NOT NULL,
	"signed_file_url" text,
	"signed_file_name" text,
	"signed_version_id" text,
	"signed_at" timestamp with time zone,
	"signed_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_record_signings" ADD CONSTRAINT "agreement_record_signings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_record_signings" ADD CONSTRAINT "agreement_record_signings_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_record_signings" ADD CONSTRAINT "agreement_record_signings_prepared_by_user_id_users_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_record_signings" ADD CONSTRAINT "agreement_record_signings_signed_version_id_document_versions_id_fk" FOREIGN KEY ("signed_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_record_signings" ADD CONSTRAINT "agreement_record_signings_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;