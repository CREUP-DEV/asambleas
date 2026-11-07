CREATE TABLE "calendar_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "assembly_type" NOT NULL,
	"rules" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_rules_type_unique" UNIQUE("type")
);
