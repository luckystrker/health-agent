import { defineConfig } from "drizzle-kit";

/**
 * Конфиг drizzle-kit.
 * - Схема — `agent/lib/db/schema.ts` (единый артефакт всех таблиц проекта).
 * - Миграции — в `drizzle/` (коммитятся, применяются `drizzle-kit migrate`).
 *
 * Запуск:
 *   npm run db:generate   # сгенерировать SQL по schema.ts
 *   npm run db:migrate    # применить миграции (нужен DATABASE_URL)
 */
export default defineConfig({
  schema: "./agent/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // url нужен только для `drizzle-kit migrate`/`push`; generate работает без него.
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
