ALTER TABLE "document_form_corrections" ADD COLUMN "passage" jsonb;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "pending_passages" jsonb;