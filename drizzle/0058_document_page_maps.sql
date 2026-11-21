CREATE TABLE "document_page_maps" (
	"version_id" text NOT NULL,
	"locale" text NOT NULL,
	"layout_key" text NOT NULL,
	"total_pages" integer NOT NULL,
	"starts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_page_maps_version_id_locale_pk" PRIMARY KEY("version_id","locale")
);
--> statement-breakpoint
ALTER TABLE "document_page_maps" ADD CONSTRAINT "document_page_maps_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;