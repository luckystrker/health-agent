// @ts-check
/**
 * Postgres-клиент (drizzle-orm + postgres-js). Singleton (ESM module cache).
 * Connection string — из `DATABASE_URL` (§14).
 *
 * Схема импортируется целиком, чтобы db-запросы могли использовать
 * `db.query.*` (relational query API) и `db.select().from(table)`.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL;
// Build/static-analysis оценивает модули без env. postgres-js создаёт ленивый пул без
// подключения, поэтому placeholder валидного формата достаточен. В runtime реальный
// DATABASE_URL обязан быть задан — иначе первый запрос упадёт с connection error.
const queryClient = postgres(
  DATABASE_URL ?? "postgres://build:build@127.0.0.1:5432/build",
  {
    max: 10,
    onnotice: () => {},
  },
);

// postgres-js: пул соединений. max — небольшое (family-of-2 аудитория).
export const db = drizzle(queryClient, { schema });
export { schema };
