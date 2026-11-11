CREATE TABLE "document_files" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"stored_name" text NOT NULL,
	"file_name" text NOT NULL,
	"uploaded_by_user_id" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone,
	"replaced_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_replaced_by_user_id_users_id_fk" FOREIGN KEY ("replaced_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_files_stored_name_unique" ON "document_files" USING btree ("stored_name");--> statement-breakpoint
CREATE INDEX "idx_document_files_document" ON "document_files" USING btree ("document_id");--> statement-breakpoint
-- Every PDF a document points to now, uploaded by whoever did it last.
INSERT INTO "document_files" ("id", "document_id", "stored_name", "file_name", "uploaded_by_user_id", "uploaded_at")
SELECT 'f' || substr(md5(random()::text || clock_timestamp()::text || d."id"), 1, 23),
  d."id",
  substring(d."file_url" from 24),
  COALESCE(NULLIF(d."file_name", ''), 'documento.pdf'),
  u."actor_user_id",
  COALESCE(u."created_at", d."updated_at")
FROM "documents" d
LEFT JOIN LATERAL (
  SELECT e."actor_user_id", e."created_at" FROM "events" e
  WHERE e."entity_type" = 'document' AND e."entity_id" = d."id" AND e."type" = 'document_file_uploaded'
  ORDER BY e."created_at" DESC LIMIT 1
) u ON true
WHERE d."file_url" ~ '^/api/uploads/documents/[a-f0-9-]+\.pdf$'
ON CONFLICT ("stored_name") DO NOTHING;--> statement-breakpoint
-- The PDFs replaced after publication, kept on disk and named in their event;
-- each was uploaded by the upload event before it.
INSERT INTO "document_files" ("id", "document_id", "stored_name", "file_name", "uploaded_by_user_id", "uploaded_at", "replaced_at", "replaced_by_user_id")
SELECT 'f' || substr(md5(random()::text || clock_timestamp()::text || e."id"), 1, 23),
  e."entity_id",
  substring(e."payload"->>'previousFileUrl' from 24),
  COALESCE(NULLIF(e."payload"->>'previousFileName', ''), 'documento.pdf'),
  e."previous_actor",
  COALESCE(e."previous_at", e."created_at"),
  e."created_at",
  e."actor_user_id"
FROM (
  SELECT ev."id", ev."entity_id", ev."payload", ev."actor_user_id", ev."created_at",
    lag(ev."actor_user_id") OVER w AS "previous_actor",
    lag(ev."created_at") OVER w AS "previous_at"
  FROM "events" ev
  WHERE ev."entity_type" = 'document' AND ev."type" = 'document_file_uploaded'
  WINDOW w AS (PARTITION BY ev."entity_id" ORDER BY ev."created_at")
) e
JOIN "documents" d ON d."id" = e."entity_id"
WHERE e."payload"->>'previousFileUrl' ~ '^/api/uploads/documents/[a-f0-9-]+\.pdf$'
ON CONFLICT ("stored_name") DO NOTHING;
