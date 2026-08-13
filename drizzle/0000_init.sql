-- pgcrypto: для gen_random_uuid() (и будущих нужд). На PG16 gen_random_uuid()
-- встроено в core, но расширение создаётся явно (§14). Для локального dev также
-- монтируется docker/postgres-init.sql.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE "daily_aggregates" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"value" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_aggregates_user_id_day_metric_pk" PRIMARY KEY("user_id","day","metric")
);
--> statement-breakpoint
CREATE TABLE "fatsecret_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"access_token_secret" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "food_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "food_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"external_id" text,
	"consumed_at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"description" text NOT NULL,
	"food_id" text,
	"servings" numeric(6, 2),
	"kcal" numeric(7, 1) NOT NULL,
	"protein_g" numeric(6, 1),
	"fat_g" numeric(6, 1),
	"carbs_g" numeric(6, 1),
	"source" text DEFAULT 'fatsecret' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "goals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_weight_kg" numeric(5, 2),
	"target_date" date,
	"tempo_kg_per_week" numeric(4, 2),
	"calorie_source" text DEFAULT 'hybrid' NOT NULL,
	"manual_target_kcal" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_hub_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_label" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_from" text
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sex" text NOT NULL,
	"birth_date" date NOT NULL,
	"height_cm" integer NOT NULL,
	"current_weight_kg" numeric(5, 2),
	"self_reported_activity_level" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "program_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"program_version" integer NOT NULL,
	"day_of_week" smallint NOT NULL,
	"wger_exercise_id" integer NOT NULL,
	"exercise_name_en" text NOT NULL,
	"sets" integer,
	"reps" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_samples" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "raw_samples_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"morning_local" time(0),
	"midday_local" time(0),
	"evening_local" time(0),
	"workout_times" jsonb
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"timezone" text NOT NULL,
	"tone_preset" text DEFAULT 'supportive' NOT NULL,
	"onboarded_at" timestamp with time zone,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_chat_id_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "weight_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"weight_kg" numeric(5, 2) NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workout_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"program_version" integer,
	"scheduled_day" date,
	"performed_at" timestamp with time zone,
	"status" text NOT NULL,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_programs" (
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"goal_kind" text NOT NULL,
	"frequency_per_week" integer NOT NULL,
	"equipment" text[],
	"session_duration_min" integer,
	"constraints" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "workout_programs_user_id_version_pk" PRIMARY KEY("user_id","version")
);
--> statement-breakpoint
ALTER TABLE "daily_aggregates" ADD CONSTRAINT "daily_aggregates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fatsecret_tokens" ADD CONSTRAINT "fatsecret_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_entries" ADD CONSTRAINT "food_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_hub_tokens" ADD CONSTRAINT "phone_hub_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_program_fk" FOREIGN KEY ("user_id","program_version") REFERENCES "public"."workout_programs"("user_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_samples" ADD CONSTRAINT "raw_samples_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_settings" ADD CONSTRAINT "reminder_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_log" ADD CONSTRAINT "weight_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_logs" ADD CONSTRAINT "workout_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_programs" ADD CONSTRAINT "workout_programs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "food_entries_user_external_idx" ON "food_entries" USING btree ("user_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "food_entries_user_day_idx" ON "food_entries" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_hub_tokens_user_platform_label_idx" ON "phone_hub_tokens" USING btree ("user_id","platform","device_label");--> statement-breakpoint
CREATE INDEX "program_sessions_order_idx" ON "program_sessions" USING btree ("user_id","program_version","day_of_week","sort_order");--> statement-breakpoint
CREATE INDEX "raw_samples_user_metric_recorded_idx" ON "raw_samples" USING btree ("user_id","metric","recorded_at");--> statement-breakpoint
CREATE INDEX "raw_samples_received_idx" ON "raw_samples" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "weight_log_user_measured_at_idx" ON "weight_log" USING btree ("user_id","measured_at");