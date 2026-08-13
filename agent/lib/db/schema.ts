// @ts-check
/**
 * drizzle-схема ВСЕХ таблиц проекта (единый артефакт).
 * Источник: docs/SPECIFICATION.md §5. Миграции генерируются в `drizzle/`.
 *
 * На фазе 0 активно используются: users, profiles, weight_log, goals,
 * reminder_settings. Остальные таблицы создаются миграцией, но наполняются
 * в фазах 1–5.
 *
 * Замечания/решения (см. docs/STATUS.md):
 *  - `goals` — спека §5.2 не declares PK; добавлен surrogate `id bigint identity`.
 *  - `daily_aggregates.value.workouts.calories_kgl` → `calories_kcal` (опечатка §5.3).
 *  - `uuid().defaultRandom()` → `DEFAULT gen_random_uuid()` (на PG16 встроено; pgcrypto
 *    создаётся для совместимости/будущих нужд — см. drizzle/ и docker/postgres-init.sql).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// §5.1  Профили и настройки
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  telegramChatId: bigint("telegram_chat_id", { mode: "bigint" }).notNull().unique(),
  timezone: text("timezone").notNull(),
  // Когда юзер явно выбрал tz через set-tz / шаг 3 онбординга. null при создании
  // (tz=Europe/Moscow по умолчанию) — маркер того, что шаг 3 онбординга пройден.
  timezoneSetAt: timestamp("timezone_set_at", { withTimezone: true, mode: "date" }),
  tonePreset: text("tone_preset").notNull().default("supportive"),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true, mode: "date" }),
  // true = юзер заблокировал бота (Telegram 403); schedules его пропускают (§16).
  blocked: boolean("blocked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .notNull()
    .references(() => users.id),
  sex: text("sex").notNull(), // 'male' | 'female'
  birthDate: date("birth_date", { mode: "date" }).notNull(),
  heightCm: integer("height_cm").notNull(),
  currentWeightKg: numeric("current_weight_kg", { precision: 5, scale: 2, mode: "number" }),
  // 'sedentary' | 'light' | 'moderate' | 'active' — cold-start fallback (§11.2).
  selfReportedActivityLevel: text("self_reported_activity_level").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const weightLog = pgTable(
  "weight_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    weightKg: numeric("weight_kg", { precision: 5, scale: 2, mode: "number" }).notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true, mode: "date" }).notNull(),
    source: text("source").notNull().default("manual"), // 'manual' (умные весы — отдельной фазой)
  },
  (t) => [uniqueIndex("weight_log_user_measured_at_idx").on(t.userId, t.measuredAt)],
);

export const phoneHubTokens = pgTable(
  "phone_hub_tokens",
  {
    // SHA-256(salt + token), salt в env PHONE_HUB_TOKEN_SALT (фаза 1).
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    deviceLabel: text("device_label").notNull(), // 'amazfit', 'huawei' и т.д.
    platform: text("platform").notNull(), // 'ios' | 'android'
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    rotatedFrom: text("rotated_from"), // token_hash предыдущего токена (при ротации)
  },
  (t) => [uniqueIndex("phone_hub_tokens_user_platform_label_idx").on(t.userId, t.platform, t.deviceLabel)],
);

// ─────────────────────────────────────────────────────────────────────────────
// §5.2  Цели
// ─────────────────────────────────────────────────────────────────────────────

export const goals = pgTable("goals", {
  // Спека §5.2 не declares PK — добавлен surrogate id (см. STATUS.md).
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull(), // 'weight_loss' | 'maintenance' | 'muscle_gain'
  targetWeightKg: numeric("target_weight_kg", { precision: 5, scale: 2, mode: "number" }),
  targetDate: date("target_date", { mode: "date" }),
  tempoKgPerWeek: numeric("tempo_kg_per_week", { precision: 4, scale: 2, mode: "number" }),
  calorieSource: text("calorie_source").notNull().default("hybrid"), // 'hybrid' | 'device' | 'manual'
  manualTargetKcal: integer("manual_target_kcal"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  active: boolean("active").notNull().default(true),
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.3  Данные с часов
// ─────────────────────────────────────────────────────────────────────────────

export const rawSamples = pgTable(
  "raw_samples",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // 'sleep_session' | 'steps' | 'heart_rate' | 'active_calories' | 'workout'
    metric: text("metric").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("raw_samples_user_metric_recorded_idx").on(t.userId, t.metric, t.recordedAt),
    index("raw_samples_received_idx").on(t.receivedAt), // для очистки по TTL 30 дней
  ],
);

export const dailyAggregates = pgTable(
  "daily_aggregates",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // ЛОКАЛЬНАЯ дата юзера (по timezone).
    day: date("day", { mode: "date" }).notNull(),
    // 'sleep' | 'steps' | 'heart_rate' | 'activity' | 'workouts'
    metric: text("metric").notNull(),
    // Форматы value см. §5.3 (sleep/steps/heart_rate/activity/workouts).
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day, t.metric] })],
);

// ─────────────────────────────────────────────────────────────────────────────
// §5.4  Питание
// ─────────────────────────────────────────────────────────────────────────────

export const foodEntries = pgTable(
  "food_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    externalId: text("external_id"), // FatSecret food_entry_id; для dedup при sync
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }).notNull(),
    day: date("day", { mode: "date" }).notNull(), // локальный день юзера
    description: text("description").notNull(),
    foodId: text("food_id"), // FatSecret food_id
    servings: numeric("servings", { precision: 6, scale: 2, mode: "number" }),
    kcal: numeric("kcal", { precision: 7, scale: 1, mode: "number" }).notNull(),
    proteinG: numeric("protein_g", { precision: 6, scale: 1, mode: "number" }),
    fatG: numeric("fat_g", { precision: 6, scale: 1, mode: "number" }),
    carbsG: numeric("carbs_g", { precision: 6, scale: 1, mode: "number" }),
    source: text("source").notNull().default("fatsecret"), // 'fatsecret' | 'manual' | 'barcode_off'
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // Один импорт на FatSecret-запись (partial unique — только для строк с external_id).
    uniqueIndex("food_entries_user_external_idx")
      .on(t.userId, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index("food_entries_user_day_idx").on(t.userId, t.day),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// §5.5  Тренировки
// ─────────────────────────────────────────────────────────────────────────────

export const workoutPrograms = pgTable(
  "workout_programs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    version: integer("version").notNull(),
    goalKind: text("goal_kind").notNull(),
    frequencyPerWeek: integer("frequency_per_week").notNull(),
    equipment: text("equipment").array(), // ['home'] | ['gym'] | ['outdoor'] | combo
    sessionDurationMin: integer("session_duration_min"),
    constraints: text("constraints"), // травмы/ограничения (свободный текст)
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.version] })],
);

export const programSessions = pgTable(
  "program_sessions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    programVersion: integer("program_version").notNull(),
    dayOfWeek: smallint("day_of_week").notNull(), // 0=вс ... 6=сб
    wgerExerciseId: integer("wger_exercise_id").notNull(),
    exerciseNameEn: text("exercise_name_en").notNull(), // кэш имени (wger отдаёт EN)
    sets: integer("sets"),
    reps: text("reps"), // '8-12' / '30s' и т.п.
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    // Композитный FK → workout_programs(user_id, version).
    foreignKey({
      columns: [t.userId, t.programVersion],
      foreignColumns: [workoutPrograms.userId, workoutPrograms.version],
      name: "program_sessions_program_fk",
    }),
    index("program_sessions_order_idx").on(t.userId, t.programVersion, t.dayOfWeek, t.sortOrder),
  ],
);

export const workoutLogs = pgTable("workout_logs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  programVersion: integer("program_version"),
  scheduledDay: date("scheduled_day", { mode: "date" }),
  performedAt: timestamp("performed_at", { withTimezone: true, mode: "date" }),
  status: text("status").notNull(), // 'completed' | 'skipped' | 'rescheduled' | 'partial'
  notes: text("notes"),
  source: text("source").notNull().default("manual"),
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.6  Напоминания
// ─────────────────────────────────────────────────────────────────────────────

/** Элемент workout_times: день недели + локальное время. day_of_week: 0=вс…6=сб. */
export type WorkoutTimeSlot = { day_of_week: number; local_time: string };

export const reminderSettings = pgTable("reminder_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .notNull()
    .references(() => users.id),
  morningLocal: time("morning_local", { precision: 0 }), // время в tz юзера
  middayLocal: time("midday_local", { precision: 0 }),
  eveningLocal: time("evening_local", { precision: 0 }),
  // [{day_of_week, local_time}] под программу (day_of_week: 0=вс…6=сб, local_time: "HH:MM").
  workoutTimes: jsonb("workout_times").$type<WorkoutTimeSlot[]>(),
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.7  FatSecret (per-user access-токены, OAuth 1.0a)
// ─────────────────────────────────────────────────────────────────────────────

export const fatsecretTokens = pgTable("fatsecret_tokens", {
  userId: uuid("user_id")
    .primaryKey()
    .notNull()
    .references(() => users.id),
  accessToken: text("access_token").notNull(),
  accessTokenSecret: text("access_token_secret").notNull(), // OAuth 1.0a: token + secret
  connectedAt: timestamp("connected_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
});
