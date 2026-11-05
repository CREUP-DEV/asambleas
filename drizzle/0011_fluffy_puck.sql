CREATE INDEX "idx_events_created" ON "events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "idx_events_type_created" ON "events" USING btree ("type","created_at");