CREATE TABLE "passage_wordings" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"passage_key" text NOT NULL,
	"amendment_ids" text[] NOT NULL,
	"block_ids" text[] NOT NULL,
	"ops" jsonb NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passage_wordings" ADD CONSTRAINT "passage_wordings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passage_wordings" ADD CONSTRAINT "passage_wordings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passage_wordings" ADD CONSTRAINT "passage_wordings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "passage_wordings_passage" ON "passage_wordings" USING btree ("document_id","passage_key");