ALTER TABLE "agenda_items" ADD COLUMN "submission_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD COLUMN "generated_for_document_id" text;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD COLUMN "title_custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_generated_for_document_id_documents_id_fk" FOREIGN KEY ("generated_for_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agenda_items_generated_for" ON "agenda_items" USING btree ("generated_for_document_id");