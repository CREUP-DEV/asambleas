CREATE TABLE "document_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"block_id" text,
	"start_offset" integer,
	"end_offset" integer,
	"quote" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_notes" ADD CONSTRAINT "document_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_notes" ADD CONSTRAINT "document_notes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_document_notes_user_document" ON "document_notes" USING btree ("user_id","document_id");--> statement-breakpoint
CREATE INDEX "idx_document_notes_document" ON "document_notes" USING btree ("document_id");