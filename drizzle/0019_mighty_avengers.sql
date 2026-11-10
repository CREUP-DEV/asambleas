ALTER TABLE "agenda_items" ADD COLUMN "hidden_with_document_id" text;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD COLUMN "title_withheld" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_hidden_with_document_id_documents_id_fk" FOREIGN KEY ("hidden_with_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agenda_items_hidden_with" ON "agenda_items" USING btree ("hidden_with_document_id");