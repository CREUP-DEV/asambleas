CREATE TABLE "amendment_reads" (
	"user_id" text NOT NULL,
	"amendment_id" text NOT NULL,
	"revision" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amendment_reads_user_id_amendment_id_pk" PRIMARY KEY("user_id","amendment_id")
);
--> statement-breakpoint
CREATE TABLE "document_reads" (
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"revision" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_reads_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "amendment_reads" ADD CONSTRAINT "amendment_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_reads" ADD CONSTRAINT "amendment_reads_amendment_id_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reads" ADD CONSTRAINT "document_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reads" ADD CONSTRAINT "document_reads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_amendment_reads_amendment" ON "amendment_reads" USING btree ("amendment_id");--> statement-breakpoint
CREATE INDEX "idx_document_reads_document" ON "document_reads" USING btree ("document_id");