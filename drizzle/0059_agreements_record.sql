CREATE TABLE "agreement_record_texts" (
	"assembly_id" text NOT NULL,
	"key" text NOT NULL,
	"text" text,
	"omitted" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agreement_record_texts_assembly_id_key_pk" PRIMARY KEY("assembly_id","key")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "generated" text;--> statement-breakpoint
ALTER TABLE "agreement_record_texts" ADD CONSTRAINT "agreement_record_texts_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_record_texts" ADD CONSTRAINT "agreement_record_texts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_generated_unique" ON "documents" USING btree ("assembly_id","generated") WHERE "documents"."generated" is not null;