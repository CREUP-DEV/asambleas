CREATE TYPE "public"."accepted_amendment_rule" AS ENUM('incorporate', 'vote');--> statement-breakpoint
CREATE TABLE "document_proponents" (
	"document_id" text NOT NULL,
	"member_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assemblies" ALTER COLUMN "settings" SET DEFAULT '{"positionVisibility":"session","tieRule":"rejected","denominator":"valid_votes"}'::jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "accepted_amendments" "accepted_amendment_rule" DEFAULT 'vote' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_proponents" ADD CONSTRAINT "document_proponents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_proponents" ADD CONSTRAINT "document_proponents_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_proponents_unique" ON "document_proponents" USING btree ("document_id","member_id");--> statement-breakpoint
CREATE INDEX "idx_document_proponents_member" ON "document_proponents" USING btree ("member_id");--> statement-breakpoint
-- Regulations incorporate the amendments their presenter accepts.
UPDATE "documents" SET "accepted_amendments" = 'incorporate' WHERE "kind" = 'regulation';
--> statement-breakpoint
-- Accepted amendments are a per-document rule now.
UPDATE "assemblies" SET "settings" = "settings" - 'acceptedAmendments';
