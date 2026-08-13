DROP INDEX "raw_samples_user_metric_recorded_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "raw_samples_user_metric_recorded_idx" ON "raw_samples" USING btree ("user_id","metric","recorded_at");