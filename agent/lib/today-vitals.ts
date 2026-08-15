// @ts-check
/**
 * Снимок ТЕКУЩЕГО локального дня для proactive-сообщений фазы 4 (§12.3
 * «Свежесть для anomaly-check / evening-сводки»; PHASE-4 §4, §5.2, §5.4).
 *
 * Агрегат текущего дня НЕ существует (aggregate-raw агрегирует только
 * завершённые дни) — поэтому шаги/сон/активность читаются через `readPeriod`
 * (prefers daily_aggregates → on-the-fly из raw_samples), еда — из
 * `food_entries`, цель по калориям — из `lib/calories` (не LLM-tools, §11.5).
 *
 * Сон «за прошлую ночь» = агрегат сна на сегодняшнюю дату (сон относится к дате
 * пробуждения, §12.1): либо готовый агрегат (если aggregate-raw уже прогнал),
 * либо raw-сессия с wake_at (ingestion гарантирует валидные bed_at/wake_at).
 */
import { and, eq, gte } from "drizzle-orm";

import { computeCaloriePlanForUser } from "./calories";
import { db } from "./db/client";
import { weightLog } from "./db/schema";
import { hhmmInTz } from "./aggregates";
import { readPeriod } from "./daily-read";
import { localMinutesOfDay } from "./fuzzy-window";
import { readFoodDays } from "./food-read";
import { getUserTimezone } from "./tenant";
import { localDay, localDayRangeUtc, previousDay } from "./time";

/** Сон за прошлую ночь (завершённая сессия, дата пробуждения = сегодня). */
export interface LastNightSleep {
  totalMinutes: number;
  bedtimeLocal: string; // "HH:MM" в tz юзера
  wakeLocal: string; // "HH:MM" в tz юзера
}

export interface TodayVitals {
  tz: string;
  /** Текущий локальный день "YYYY-MM-DD". */
  today: string;
  /** Текущее локальное время в минутах от полуночи. */
  localMinutes: number;
  /** Шаги сегодня (sum по raw-бакетам); null — данных нет. */
  steps: number | null;
  /** Активные калории сегодня; null — данных нет. */
  activeKcal: number | null;
  /** Съедено сегодня (food_entries); null — записей нет («не записывал» ≠ 0). */
  kcalEaten: number | null;
  /** Кол-во записей еды сегодня. */
  foodEntries: number;
  /** Целевой калораж (lib/calories); null — профиль не заполнен. */
  kcalTarget: number | null;
  /** Сон за прошлую ночь; null — завершённой сессии нет. */
  sleep: LastNightSleep | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Сон за прошлую ночь из PeriodValue метрики sleep (aggregate|raw — не важно). */
function sleepFromValue(value: Record<string, unknown>): LastNightSleep | null {
  const total = num(value.total_minutes);
  if (total == null || typeof value.bedtime_local !== "string") return null;
  return {
    totalMinutes: total,
    bedtimeLocal: value.bedtime_local,
    wakeLocal: typeof value.wake_local === "string" ? value.wake_local : "",
  };
}

/**
 * Сон за прошлую ночь одним запросом (aggregate → raw on-the-fly). Отдельный
 * лёгкий путь для `buildMorningFacts` — без расчёта калорий/шагов (review P2).
 */
export async function readLastNightSleep(
  userId: string,
  tz: string,
  today: string,
): Promise<LastNightSleep | null> {
  const period = await readPeriod(userId, tz, [today], ["sleep"]);
  return sleepFromValue(period.get(today)?.get("sleep")?.value ?? {});
}

/** Снимок текущего локального дня юзера (шаги/активность/еда/цель/сон). */
export async function buildTodayVitals(userId: string, now = new Date()): Promise<TodayVitals> {
  const tz = await getUserTimezone(userId);
  const today = localDay(now, tz);

  const [period, foodDays, plan] = await Promise.all([
    readPeriod(userId, tz, [today], ["sleep", "steps", "activity"]),
    readFoodDays(userId, [today]),
    computeCaloriePlanForUser(userId).catch(() => null),
  ]);

  const m = period.get(today);
  const food = foodDays.get(today);

  return {
    tz,
    today,
    localMinutes: localMinutesOfDay(now, tz),
    steps: num(m?.get("steps")?.value.total_steps),
    activeKcal: num(m?.get("activity")?.value.active_calories_kcal),
    kcalEaten: food && food.entries.length > 0 ? Math.round(food.totals.kcal) : null,
    foodEntries: food?.entries.length ?? 0,
    kcalTarget: plan?.plan.targetKcal ?? null,
    sleep: sleepFromValue(m?.get("sleep")?.value ?? {}),
  };
}

/** Факты для утренней напоминалки «внести ужин/взвеситься» (PHASE-4 §5.2). */
export interface MorningFacts {
  /** Сон за прошлую ночь (если есть — модель может поприветствовать им). */
  sleep: LastNightSleep | null;
  /** Записан ли вчерашний ужин (запись еды с локальным временем ≥ 17:00). */
  dinnerLoggedYesterday: boolean;
  /** Было ли взвешивание с начала вчерашнего локального дня. */
  weighedRecently: boolean;
}

/**
 * Собрать факты утра: если ужин записан и вес есть — напоминалка превращается в
 * короткое «доброе утро» вместо бессмысленного напоминания (решение фазы 4,
 * зафиксировано в STATUS.md).
 */
export async function buildMorningFacts(userId: string, now = new Date()): Promise<MorningFacts> {
  const tz = await getUserTimezone(userId);
  const today = localDay(now, tz);
  const yesterday = previousDay(today);

  const [sleep, foodDays, weightRows] = await Promise.all([
    readLastNightSleep(userId, tz, today),
    readFoodDays(userId, [yesterday]),
    db
      .select({ measuredAt: weightLog.measuredAt })
      .from(weightLog)
      .where(
        and(eq(weightLog.userId, userId), gte(weightLog.measuredAt, localDayRangeUtc(yesterday, tz).start)),
      )
      .limit(1),
  ]);

  // «Ужин» = запись еды вчера с локальным временем приёма ≥ 17:00.
  let dinnerLogged = false;
  for (const e of foodDays.get(yesterday)?.entries ?? []) {
    const hour = Number(hhmmInTz(new Date(e.consumed_at), tz).slice(0, 2));
    if (hour >= 17) {
      dinnerLogged = true;
      break;
    }
  }

  return {
    sleep,
    dinnerLoggedYesterday: dinnerLogged,
    weighedRecently: weightRows.length > 0,
  };
}
