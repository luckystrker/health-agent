// @ts-check
/**
 * Schedule `sync-fatsecret-diary` — ежедневная синхронизация дневника FatSecret
 * (§6.2, §9, §16; PHASE-2 §6.6). Cron `0 4 * * *` (UTC).
 *
 * Зачем: юзер может вносить еду напрямую в приложение FatSecret — без sync
 * калораж в отчётах врёт.
 *
 * Как: schedule ходит от appAuth, но OAuth 1.0a-запросы подписываются per-user
 * токеном из `fatsecret_tokens` (app-level fetch, principal не нужен — §9).
 *
 * Алгоритм (решение зафиксировано в STATUS.md):
 *  1. `food_entries.get_month` (месяц сегодня) → дни с записями + дневные итоги.
 *     ⚠️ get_month возвращает ТОЛЬКО дневные суммы — для построчного upsert по
 *     external_id дополнительно зовём `food_entries.get` по каждому целевому дню.
 *  2. Целевые дни = {вчера, сегодня} ∪ дни месяца с записями ∪ дни текущего
 *     месяца, где у нас уже есть fatsecret-строки (ловим правки/удаления).
 *  3. По каждому дню: upsert полученных записей по (user_id, external_id);
 *     наши fatsecret-строки этого дня с external_id вне ответа — удаляются
 *     (юзер удалил запись в приложении; §18.2 «новые + обновлённые + дубли»).
 *     manual/barcode_off-строки (external_id IS NULL) не трогаем никогда.
 *  4. Изоляция per-user и per-day: сбой одного юзера/дня не роняет джоб (§16).
 *  5. 401 → токен помечается отозванным (нужно переподключение; §7 PHASE-2).
 */
import { and, eq, gte, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import { defineSchedule } from "eve/schedules";

import { db } from "../lib/db/client";
import { fatsecretTokens, foodEntries, users } from "../lib/db/schema";
import {
  getDayEntries,
  getMonthDays,
  FsApiError,
  mealDefaultLocalTime,
  type FsFoodEntry,
} from "../lib/fatsecret-api";
import { log } from "../lib/log";
import { localDay, localTimeToUtc } from "../lib/time";

/** FsFoodEntry → строка food_entries (чистое отображение — unit-тестируется). */
export function entryToRowValues(
  userId: string,
  entry: FsFoodEntry,
  tz: string,
): {
  userId: string;
  externalId: string;
  consumedAt: Date;
  day: Date;
  description: string;
  foodId: string | null;
  servings: number;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  source: string;
} {
  // FatSecret не отдаёт время приёма — каноническое время по meal (см. lib/time).
  const consumedAt = localTimeToUtc(entry.day, mealDefaultLocalTime(entry.meal), tz);
  return {
    userId,
    externalId: entry.foodEntryId,
    consumedAt,
    day: new Date(`${entry.day}T00:00:00.000Z`),
    description: entry.name,
    foodId: entry.foodId,
    servings: entry.units,
    kcal: entry.kcal,
    proteinG: entry.proteinG,
    fatG: entry.fatG,
    carbsG: entry.carbsG,
    source: "fatsecret",
  };
}

/** Все дни текущего (по localDay `today`) месяца, где есть наши fatsecret-строки. */
async function ourFatsecretDays(userId: string, today: string): Promise<Set<string>> {
  const monthStart = `${today.slice(0, 7)}-01`;
  const t = new Date(`${monthStart}T00:00:00.000Z`).getTime();
  const monthEnd = new Date(new Date(t).setUTCMonth(new Date(t).getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);

  const rows = await db
    .select({ day: foodEntries.day })
    .from(foodEntries)
    .where(
      and(
        eq(foodEntries.userId, userId),
        isNotNull(foodEntries.externalId),
        gte(foodEntries.day, new Date(`${monthStart}T00:00:00.000Z`)),
        lte(foodEntries.day, new Date(`${monthEnd}T00:00:00.000Z`)),
      ),
    );
  return new Set(rows.map((r) => r.day.toISOString().slice(0, 10)));
}

interface DaySyncResult {
  upserted: number;
  deleted: number;
}

/** Sync одного дня: upsert записей + удаление исчезнувших (шаг 3). */
async function syncDay(
  userId: string,
  tz: string,
  day: string,
  entries: FsFoodEntry[],
): Promise<DaySyncResult> {
  let upserted = 0;
  for (const entry of entries) {
    const values = entryToRowValues(userId, entry, tz);
    await db
      .insert(foodEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [foodEntries.userId, foodEntries.externalId],
        targetWhere: sql`external_id IS NOT NULL`,
        set: {
          consumedAt: values.consumedAt,
          day: values.day,
          description: values.description,
          foodId: values.foodId,
          servings: values.servings,
          kcal: values.kcal,
          proteinG: values.proteinG,
          fatG: values.fatG,
          carbsG: values.carbsG,
        },
      });
    upserted++;
  }

  // Удаление: наши fatsecret-строки дня, которых больше нет в ответе.
  let deleted = 0;
  const keptIds = entries.map((e) => e.foodEntryId);
  const staleWhere =
    keptIds.length > 0
      ? and(
          eq(foodEntries.userId, userId),
          eq(foodEntries.day, new Date(`${day}T00:00:00.000Z`)),
          isNotNull(foodEntries.externalId),
          notInArray(foodEntries.externalId, keptIds),
        )
      : and(
          eq(foodEntries.userId, userId),
          eq(foodEntries.day, new Date(`${day}T00:00:00.000Z`)),
          isNotNull(foodEntries.externalId),
        );
  const res = (await db.delete(foodEntries).where(staleWhere)) as {
    rowCount?: number;
    count?: number;
  } | undefined;
  deleted = res?.rowCount ?? res?.count ?? 0;
  return { upserted, deleted };
}

/** Sync одного юзера (шаги 1–3). Бросает наружу только FsApiError('unauthorized'). */
async function syncUser(
  userId: string,
  tz: string,
  token: { accessToken: string; accessTokenSecret: string },
): Promise<{ upserted: number; deleted: number; daysFetched: number }> {
  const today = localDay(new Date(), tz);
  const yesterday = new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Шаг 1: дни месяца с записями (итоги) — плюс Наши дни для reconciliation.
  const monthDays = await getMonthDays(token, today);
  const fsDays = new Set(monthDays.map((d) => d.day));
  const ourDays = await ourFatsecretDays(userId, today);

  // Шаг 2: целевые дни. Защитный cap — 40 (месяц + вчерашний день другой месяц).
  const targetDays = [...new Set([yesterday, today, ...fsDays, ...ourDays])]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .slice(0, 40);

  let upserted = 0;
  let deleted = 0;
  let daysFetched = 0;
  for (const day of targetDays) {
    const entries = await getDayEntries(token, day);
    daysFetched++;
    const r = await syncDay(userId, tz, day, entries);
    upserted += r.upserted;
    deleted += r.deleted;
  }
  return { upserted, deleted, daysFetched };
}

export default defineSchedule({
  cron: "0 4 * * *",
  async run() {
    const startedAt = Date.now();
    log("schedule", "sync-fatsecret-diary-start", "info", {});

    let usersProcessed = 0;
    let entriesUpserted = 0;
    let entriesDeleted = 0;
    let userErrors = 0;

    try {
      const userList = await db
        .select({ id: users.id, timezone: users.timezone, accessToken: fatsecretTokens.accessToken, accessTokenSecret: fatsecretTokens.accessTokenSecret })
        .from(users)
        .innerJoin(fatsecretTokens, eq(fatsecretTokens.userId, users.id))
        .where(and(isNotNull(users.onboardedAt), eq(users.blocked, false), isNull(fatsecretTokens.revokedAt)));

      for (const u of userList) {
        try {
          const r = await syncUser(u.id, u.timezone, {
            accessToken: u.accessToken,
            accessTokenSecret: u.accessTokenSecret,
          });
          usersProcessed++;
          entriesUpserted += r.upserted;
          entriesDeleted += r.deleted;
        } catch (e) {
          userErrors++;
          if (e instanceof FsApiError && e.kind === "unauthorized") {
            // Токен отозван юзером — помечаем, нужен перепуск PIN-flow (§7).
            await db
              .update(fatsecretTokens)
              .set({ revokedAt: new Date() })
              .where(eq(fatsecretTokens.userId, u.id));
            log("schedule", "sync-fatsecret-diary-revoked", "warn", { user_id: u.id });
          } else {
            log("schedule", "sync-fatsecret-diary-user-error", "error", {
              user_id: u.id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      log("schedule", "sync-fatsecret-diary-done", "info", {
        usersProcessed,
        entriesUpserted,
        entriesDeleted,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      log("schedule", "sync-fatsecret-diary-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
