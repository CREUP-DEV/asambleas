CREATE TABLE "amendment_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amendment_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "amendment_notes" ADD CONSTRAINT "amendment_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment_notes" ADD CONSTRAINT "amendment_notes_amendment_id_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_amendment_notes_user_amendment" ON "amendment_notes" USING btree ("user_id","amendment_id");--> statement-breakpoint
CREATE INDEX "idx_amendment_notes_amendment" ON "amendment_notes" USING btree ("amendment_id");