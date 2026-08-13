// @ts-check
/**
 * Schedule `aggregate-raw` — сырые сэмплы → daily_aggregates (§9, §12.3, PHASE-1 §5.3).
 *
 * Cron `0 3 * * *` (UTC). Прямой DB-доступ (без agent-сессии): `requireUser` не нужен,
 * schedule работает от appAuth, но читает/пишет БД напрямую.
 *
 * Алгоритм (без потерь при гонках, со свежими днями — источник правды §12.3):
 *  1. `now0 = now()` — snapshot-момент.
 *  2. Агрегация: для каждого онборженного не-blocked юзера — сгруппировать его сырые
 *     сэмплы по (локальный день, metric); для ЗАВЕРШЁННЫХ дней (day < текущий локальный
 *     день; для сна — wake_at < now0, т.е. сессия закончилась) вычислить агрегат и
 *     upsert в daily_aggregates. Текущий день НЕ агрегируется (он ещё идёт), кроме сна.
 *     Оптимизация: пропускать день, если все его сэмплы пришли раньше существующего
 *     computed_at (stable-день не пересчитывается).
 *  3. Удаление сырых (отдельный шаг, после агрегации): `received_at < now0 − 30 дней`.
 *     По received_at (время приёма), не recorded_at — поздние сэмплы успевают попасть
 *     в агрегацию.
 *  4. Изоляция: сбой одного (user, день, metric) не роняет джоб (try/catch per group).
 *
 * Примечание о масштабе: fetch всех raw_samples юзера раз в сутки ок для family-of-2.
 * При росте (или minutely-HR) — см. §20.5 (динамический schedule-store).
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { defineSchedule } from "eve/schedules";

import { db } from "../lib/db/client";
import { dailyAggregates, rawSamples, users } from "../lib/db/schema";
import {
  aggregateForDay,
  aggregateMetricName,
  computeLocalDayForMetric,
  type RawMetric,
  type RawSample,
} from "../lib/aggregates";
import { log } from "../lib/log";
import { localDay } from "../lib/time";

const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" → Date (UTC полночь) для колонки day (DATE). */
function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

interface UserAggResult {
  daysAggregated: number;
  groupsSkipped: number;
}

/** Агрегация завершённых дней одного юзера (шаг 2). */
async function aggregateForUser(userId: string, tz: string, now0: Date): Promise<UserAggResult> {
  const currentLocalDay = localDay(now0, tz);

  const [raw, existingAggs] = await Promise.all([
    db.select().from(rawSamples).where(eq(rawSamples.userId, userId)),
    db.select().from(dailyAggregates).where(eq(dailyAggregates.userId, userId)),
  ]);

  // Существующие агрегаты по `${day}:${aggMetric}` → computed_at (для оптимизации).
  const existingComputedAt = new Map<string, Date>();
  for (const a of existingAggs) {
    existingComputedAt.set(`${a.day.toISOString().slice(0, 10)}:${a.metric}`, a.computedAt);
  }

  // Группировка сырых по (локальный день, raw metric).
  interface Group {
    day: string;
    rawMetric: string;
    samples: RawSample[];
    maxReceived: Date;
    maxWake: number; // ms, для сна — признак завершённости
  }
  const groups = new Map<string, Group>();
  for (const r of raw) {
    const payload = r.payload as Record<string, unknown>;
    const day = computeLocalDayForMetric(r.metric, r.recordedAt, payload, tz);
    const key = `${day}:${r.metric}`;
    let g = groups.get(key);
    if (!g) {
      g = { day, rawMetric: r.metric, samples: [], maxReceived: new Date(0), maxWake: -Infinity };
      groups.set(key, g);
    }
    g.samples.push({ recordedAt: r.recordedAt, payload });
    if (r.receivedAt.getTime() > g.maxReceived.getTime()) g.maxReceived = r.receivedAt;
    if (r.metric === "sleep_session") {
      const wakeMs = new Date(payload.wake_at as string).getTime();
      if (wakeMs > g.maxWake) g.maxWake = wakeMs;
    }
  }

  let daysAggregated = 0;
  let groupsSkipped = 0;
  for (const g of groups.values()) {
    const aggMetric = aggregateMetricName(g.rawMetric);
    if (!aggMetric) continue;

    // Завершённость дня (§12.3): sleep — wake_at < now0; остальные — day < текущий.
    if (g.rawMetric === "sleep_session") {
      if (g.maxWake >= now0.getTime()) {
        groupsSkipped++; // незавершённая сессия (ещё спит) — ждёт следующего прогона
        continue;
      }
    } else if (g.day >= currentLocalDay) {
      groupsSkipped++; // текущий день — не агрегируется
      continue;
    }

    // Оптимизация: stable-день (все сэмплы пришли раньше computed_at) — пропускаем.
    const existing = existingComputedAt.get(`${g.day}:${aggMetric}`);
    if (existing && g.maxReceived.getTime() <= existing.getTime()) {
      groupsSkipped++;
      continue;
    }

    const value = aggregateForDay(g.rawMetric as RawMetric, g.samples, tz);
    // upsert; сбой изолирован per (user, day, metric) — try/catch.
    try {
      await db
        .insert(dailyAggregates)
        .values({
          userId,
          day: dayToDate(g.day),
          metric: aggMetric,
          value,
          computedAt: now0,
        })
        .onConflictDoUpdate({
          target: [dailyAggregates.userId, dailyAggregates.day, dailyAggregates.metric],
          set: { value, computedAt: now0 },
        });
      daysAggregated++;
    } catch (e) {
      log("schedule", "aggregate-raw-group-error", "error", {
        user_id: userId,
        day: g.day,
        metric: aggMetric,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { daysAggregated, groupsSkipped };
}

export default defineSchedule({
  cron: "0 3 * * *",
  async run() {
    const startedAt = Date.now();
    const now0 = new Date();
    log("schedule", "aggregate-raw-start", "info", { now0: now0.toISOString() });

    let usersProcessed = 0;
    let daysAggregated = 0;
    let userErrors = 0;

    try {
      const userList = await db
        .select({ id: users.id, timezone: users.timezone })
        .from(users)
        .where(and(isNotNull(users.onboardedAt), eq(users.blocked, false)));

      for (const u of userList) {
        // Изоляция per-user: сбой одного юзера не роняет обработку остальных (§16).
        try {
          const r = await aggregateForUser(u.id, u.timezone, now0);
          usersProcessed++;
          daysAggregated += r.daysAggregated;
        } catch (e) {
          userErrors++;
          log("schedule", "aggregate-raw-user-error", "error", {
            user_id: u.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Шаг 3: удаление сырых старше 30 дней по received_at (отдельная операция).
      const cutoff = new Date(now0.getTime() - RETENTION_DAYS * DAY_MS);
      const deleteResult = (await db.delete(rawSamples).where(lt(rawSamples.receivedAt, cutoff))) as {
        rowCount?: number;
        count?: number;
      } | undefined;
      const deleted = deleteResult?.rowCount ?? deleteResult?.count ?? null;
      log("schedule", "aggregate-raw-delete", "info", {
        cutoff: cutoff.toISOString(),
        deleted,
      });

      log("schedule", "aggregate-raw-done", "info", {
        usersProcessed,
        daysAggregated,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      // Фатальный сбой джоба — не роняет процесс ( Nitro cron изолирует тик ).
      log("schedule", "aggregate-raw-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
