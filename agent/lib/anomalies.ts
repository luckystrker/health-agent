// @ts-check
/**
 * Детектор аномалий (§11.5 — источник правды; PHASE-4 §5.4).
 *
 * Четыре порога: сон (<5ч / отбой после 02:00), калории (>125% цели при
 * незаконченном дне), активность (шаги <50% 7-дневной медианы после 18:00),
 * вес (±2.5% или ±1 кг vs медиана предыдущих измерений — информационно).
 * Все — с guard'ами на минимальное число измерений; «нет данных» НЕ алертим
 * (§12.2).
 *
 * Источники (§11.5, §12.3): текущий день — raw_samples через `readPeriod`
 * (агрегата текущего дня не существует), базовая линия — завершённые дни из
 * daily_aggregates, вес — weight_log, цель — `lib/calories` (чистый код,
 * НЕ LLM-tools). Пороги — константы ниже (настраиваются в коде, §11.5).
 *
 * Структура: pure-проверки (unit-тестируются) + `collectAnomalyInputs`
 * (DB-обёртка) + `detectAnomalies` (оркестратор) + `anomaliesPromptBlock`
 * (факты для промпта — модель делает выводы и тон, числа не транскрибируются).
 */
import { and, desc, eq, gte } from "drizzle-orm";

import { db } from "./db/client";
import { weightLog } from "./db/schema";
import { computeCaloriePlanForUser } from "./calories";
import { readPeriod } from "./daily-read";
import { localMinutesOfDay } from "./fuzzy-window";
import { readFoodDays } from "./food-read";
import { getUserTimezone } from "./tenant";
import { localDay, previousDay } from "./time";
import { completedDaysList, minutesToHoursStr } from "./weekly-digest";
import type { LastNightSleep } from "./today-vitals";

// ── Пороги (§11.5 «дефолты, настраиваются в коде») ───────────────────────────

/** Сон: тревога при длительности < 5 часов. */
export const SLEEP_MIN_MINUTES = 5 * 60;
/** Сон: отбой позже 02:00 локального времени (утренние часы после полуночи). */
export const LATE_BEDTIME_MINUTES = 2 * 60;
/** Верхняя граница «позднего отбоя»: дневные ложились спать (12:00+) — не алертим. */
const LATE_BEDTIME_MAX_MINUTES = 12 * 60;

/** Калории: перебор при > 125% цели (и день не окончен). */
export const CALORIE_OVER_FACTOR = 1.25;

/** Активность: шаги < 50% медианы. */
export const STEPS_LOW_FRACTION = 0.5;
/** Активность: алерт только после 18:00 локального времени. */
export const STEPS_ALERT_AFTER_MINUTES = 18 * 60;
/** Активность: минимум дней в базовой линии (7-дневное окно). */
export const STEPS_BASELINE_MIN_DAYS = 3;
/** Активность: окно базовой линии (завершённые дни). */
export const STEPS_BASELINE_WINDOW_DAYS = 7;

/** Вес: относительный порог ±2.5%. */
export const WEIGHT_REL_THRESHOLD = 0.025;
/** Вес: абсолютный порог ±1 кг (при малом весе). */
export const WEIGHT_ABS_KG = 1.0;
/** Вес: минимум измерений в БАЗИСЕ медианы (не считая свежего), guard §11.5. */
export const WEIGHT_MIN_MEASUREMENTS = 3;
/** Вес: окно истории измерений (дней). */
export const WEIGHT_WINDOW_DAYS = 30;
/** Вес: медиана предыдущих измерений (сколько брать). */
export const WEIGHT_MEDIAN_WINDOW = 7;

// ── Типы ─────────────────────────────────────────────────────────────────────

export type AnomalyType =
  | "sleep_duration"
  | "sleep_bedtime"
  | "calories_over"
  | "steps_low"
  | "weight_jump";

export const ANOMALY_TITLES: Record<AnomalyType, string> = {
  sleep_duration: "Мало сна",
  sleep_bedtime: "Поздний отбой",
  calories_over: "Перебор калорий",
  steps_low: "Низкая активность",
  weight_jump: "Скачок веса (информационно)",
};

/** Одна сработавшая аномалия: тип + факт-строки для промпта (готовые числа). */
export interface Anomaly {
  type: AnomalyType;
  facts: string[];
}

// ── Pure-проверки порогов (§18.1) ────────────────────────────────────────────

/**
 * «Поздний отбой»: bedtime после 02:00. bedtime_local может быть и вечерним
 * (22:00–23:59 — нормально), и за полночь (01:50 — ещё не «после двух»);
 * поздним считается интервал (02:00, 12:00) — спать днём означает выброс/некорректную
 * сессию, а не поздний отбой (без ложных алертов).
 */
export function isLateBedtime(bedtimeLocal: string): boolean {
  const m = /^(\d{2}):(\d{2})/.exec(bedtimeLocal);
  if (!m) return false;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes > LATE_BEDTIME_MINUTES && minutes < LATE_BEDTIME_MAX_MINUTES;
}

/**
 * Сон за прошлую ночь: <5ч ИЛИ отбой позже 02:00 (§11.5). null / нет данных —
 * не алертим (guard «только валидная завершённая сессия»).
 */
export function checkSleep(sleep: LastNightSleep | null): Anomaly[] {
  if (!sleep) return [];
  const out: Anomaly[] = [];
  if (sleep.totalMinutes < SLEEP_MIN_MINUTES) {
    out.push({
      type: "sleep_duration",
      facts: [
        `длительность последнего сна: ${sleep.totalMinutes} мин (${minutesToHoursStr(sleep.totalMinutes)} ч)`,
        `порог: меньше ${minutesToHoursStr(SLEEP_MIN_MINUTES)} ч`,
      ],
    });
  }
  if (isLateBedtime(sleep.bedtimeLocal)) {
    out.push({
      type: "sleep_bedtime",
      facts: [
        `лёг спать в ${sleep.bedtimeLocal}, встал в ${sleep.wakeLocal || "—"}`,
        `порог: отбой позже 02:00`,
      ],
    });
  }
  return out;
}

/**
 * Калории: съедено сегодня > target × 1.25 И день не окончен (§11.5). null по
 * любому входу (нет записей еды / цель не посчитана) — не алертим.
 */
export function checkCaloriesOver(
  kcalToday: number | null,
  kcalTarget: number | null,
  dayEnded: boolean,
): Anomaly | null {
  if (kcalToday == null || kcalTarget == null || kcalTarget <= 0) return null;
  if (dayEnded) return null;
  const threshold = kcalTarget * CALORIE_OVER_FACTOR;
  if (kcalToday <= threshold) return null;
  return {
    type: "calories_over",
    facts: [
      `съедено сегодня: ${Math.round(kcalToday)} ккал`,
      `целевой калораж: ${kcalTarget} ккал/день`,
      `порог: больше ${Math.round(threshold)} ккал (${CALORIE_OVER_FACTOR * 100}% цели), день ещё не окончен`,
    ],
  };
}

/**
 * Активность: шаги сегодня < 50% медианы за 7 завершённых дней (§11.5).
 * Guard'ы: только после 18:00 локального времени (день в основном прожит) и
 * ≥3 дней в базовой линии. null по данным — не алертим.
 */
export function checkStepsLow(
  stepsToday: number | null,
  baselineMedian: number | null,
  baselineDays: number,
  localMinutes: number,
): Anomaly | null {
  if (stepsToday == null || baselineMedian == null || baselineMedian <= 0) return null;
  if (baselineDays < STEPS_BASELINE_MIN_DAYS) return null;
  if (localMinutes < STEPS_ALERT_AFTER_MINUTES) return null;
  const threshold = baselineMedian * STEPS_LOW_FRACTION;
  if (stepsToday >= threshold) return null;
  return {
    type: "steps_low",
    facts: [
      `шагов сегодня: ${stepsToday}`,
      `медиана за ${baselineDays} завершённых дней: ${Math.round(baselineMedian)}/день`,
      `порог: меньше ${Math.round(threshold)} шагов (${STEPS_LOW_FRACTION * 100}% медианы), проверка после 18:00`,
    ],
  };
}

export interface WeightAnomalyInput {
  /** Последнее взвешивание (сегодня/вчера). */
  weightNowKg: number;
  /** Медиана предыдущих измерений (до WEIGHT_MEDIAN_WINDOW). */
  prevMedianKg: number;
}

/**
 * Вес: |Δ| / prev > 2.5% ИЛИ |Δ| > 1 кг (§11.5). Guard на минимум измерений —
 * на стороне сбора данных (collectAnomalyInputs); здесь — арифметика.
 * Информационный характер подчёркивается в промпте.
 */
export function checkWeightJump(w: WeightAnomalyInput | null): Anomaly | null {
  if (!w || w.prevMedianKg <= 0) return null;
  const delta = w.weightNowKg - w.prevMedianKg;
  const rel = Math.abs(delta) / w.prevMedianKg;
  if (rel <= WEIGHT_REL_THRESHOLD && Math.abs(delta) <= WEIGHT_ABS_KG) return null;
  const sign = delta > 0 ? "+" : "";
  return {
    type: "weight_jump",
    facts: [
      `последнее взвешивание: ${w.weightNowKg} кг (сегодня/вчера)`,
      `медиана предыдущих измерений: ${Math.round(w.prevMedianKg * 100) / 100} кг`,
      `изменение: ${sign}${Math.round(delta * 100) / 100} кг (${sign}${(Math.round(rel * 1000) / 10).toFixed(1)}%)`,
      `порог: больше ${WEIGHT_REL_THRESHOLD * 100}% или ${WEIGHT_ABS_KG} кг — информационно, не тревожно`,
    ],
  };
}

// ── Входы и оркестратор ──────────────────────────────────────────────────────

export interface AnomalyInputs {
  tz: string;
  /** Текущий локальный день (все «сегодня»-данные относятся к нему). */
  localDate: string;
  /** Локальное время в минутах от полуночи (guard активности). */
  localMinutes: number;
  /** Текущий день окончен — структурно всегда false (проверяем только текущий
   *  день); поле сохранено для контракта §11.5 и тестов. */
  dayEnded: boolean;
  sleep: LastNightSleep | null;
  kcalToday: number | null;
  kcalTarget: number | null;
  stepsToday: number | null;
  /** Медиана шагов за 7 завершённых дней (по дням с данными). */
  stepsMedian7: number | null;
  /** Дней в базовой линии с данными по шагам. */
  stepsBaselineDays: number;
  /** Свежее взвешивание (сегодня/вчера) + медиана предыдущих; null — guard. */
  weight: WeightAnomalyInput | null;
}

/** Прогнать все 4 порога по входам (pure). */
export function detectAnomalies(x: AnomalyInputs): Anomaly[] {
  return [
    ...checkSleep(x.sleep),
    checkCaloriesOver(x.kcalToday, x.kcalTarget, x.dayEnded),
    checkStepsLow(x.stepsToday, x.stepsMedian7, x.stepsBaselineDays, x.localMinutes),
    checkWeightJump(x.weight),
  ].filter((a): a is Anomaly => a !== null);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Измерение веса за окном истории (для `deriveWeightInput`). */
export interface WeightRow {
  weightKg: number;
  measuredAt: Date;
}

/**
 * Вход порога веса из измерений за окно (§11.5; pure — unit-тестируется).
 * `rows` — новые сверху (desc по measuredAt).
 *
 *  - «свежесть» — по ЛОКАЛЬНОМУ дню юзера (§12.1): последнее взвешивание должно
 *    приходиться на сегодня или вчера; абсолютные 24ч от now неверны (вчерашнее
 *    утреннее взвешивание в 25+ часов старины — всё ещё «вчера»);
 *  - guard «минимум 3» относится к БАЗИСУ медианы (prev, §11.5: «медиана
 *    последних 7 измерений (минимум 3)»), не считая свежего измерения.
 */
export function deriveWeightInput(
  rows: WeightRow[],
  tz: string,
  today: string,
): WeightAnomalyInput | null {
  if (rows.length === 0) return null;
  const w0 = rows[0];
  const w0Day = localDay(w0.measuredAt, tz);
  if (w0Day !== today && w0Day !== previousDay(today)) return null; // несвежее — не алертим
  const prevRows = rows.slice(1, 1 + WEIGHT_MEDIAN_WINDOW);
  if (prevRows.length < WEIGHT_MIN_MEASUREMENTS) return null; // базис без минимума
  const prev = median(prevRows.map((r) => r.weightKg));
  if (prev == null) return null;
  return { weightNowKg: w0.weightKg, prevMedianKg: prev };
}

/**
 * Собрать входы детектора из БД (DB-обёртка; источник — §11.5/§12.3).
 * Считает за один прогон: текущий день (readPeriod: raw on-the-fly), базовую
 * линию (7 завершённых дней, prefers daily_aggregates), еду (food_entries),
 * цель (lib/calories), вес (weight_log за 30 дней).
 */
export async function collectAnomalyInputs(userId: string, now = new Date()): Promise<AnomalyInputs> {
  const tz = await getUserTimezone(userId);
  const today = localDay(now, tz);
  const baselineDays = completedDaysList(tz, STEPS_BASELINE_WINDOW_DAYS, now);

  const [todayPeriod, baselinePeriod, foodDays, plan] = await Promise.all([
    readPeriod(userId, tz, [today], ["sleep", "steps"]),
    readPeriod(userId, tz, baselineDays, ["steps"]),
    readFoodDays(userId, [today]),
    computeCaloriePlanForUser(userId).catch(() => null),
  ]);

  // Шаги сегодня.
  const stepsToday = num(todayPeriod.get(today)?.get("steps")?.value.total_steps);

  // Базовая линия шагов: медиана по дням с данными.
  const stepsValues: number[] = [];
  for (const day of baselineDays) {
    const s = num(baselinePeriod.get(day)?.get("steps")?.value.total_steps);
    if (s != null) stepsValues.push(s);
  }

  // Сон за прошлую ночь (агрегат на дату пробуждения = сегодня).
  const sleepVal = todayPeriod.get(today)?.get("sleep")?.value ?? {};
  const sleepTotal = num(sleepVal.total_minutes);
  const sleep: LastNightSleep | null =
    sleepTotal != null && typeof sleepVal.bedtime_local === "string"
      ? {
          totalMinutes: sleepTotal,
          bedtimeLocal: sleepVal.bedtime_local,
          wakeLocal: typeof sleepVal.wake_local === "string" ? sleepVal.wake_local : "",
        }
      : null;

  // Вес за 30 дней (новые сверху) → вход порога (fresh — локальный день, базис ≥3).
  const weightSince = new Date(now.getTime() - WEIGHT_WINDOW_DAYS * 86_400_000);
  const weightRows: WeightRow[] = await db
    .select({ weightKg: weightLog.weightKg, measuredAt: weightLog.measuredAt })
    .from(weightLog)
    .where(and(eq(weightLog.userId, userId), gte(weightLog.measuredAt, weightSince)))
    .orderBy(desc(weightLog.measuredAt))
    .limit(WEIGHT_MEDIAN_WINDOW + 1);
  const weight = deriveWeightInput(weightRows, tz, today);

  const food = foodDays.get(today);
  return {
    tz,
    localDate: today,
    localMinutes: localMinutesOfDay(now, tz),
    dayEnded: false, // анализируем всегда текущий (идущий) локальный день
    sleep,
    kcalToday: food && food.entries.length > 0 ? Math.round(food.totals.kcal) : null,
    kcalTarget: plan?.plan.targetKcal ?? null,
    stepsToday,
    stepsMedian7: median(stepsValues),
    stepsBaselineDays: stepsValues.length,
    weight,
  };
}

// ── Факты для промпта ────────────────────────────────────────────────────────

/**
 * Блок фактов для proactive-сессии anomaly-check: тип + заголовок + готовые
 * числа (модель не пересчитывает и не выдумывает данные).
 */
export function anomaliesPromptBlock(anomalies: Anomaly[]): string {
  const lines: string[] = [];
  for (const a of anomalies) {
    lines.push(`**${ANOMALY_TITLES[a.type]}** (${a.type}):`);
    for (const f of a.facts) lines.push(`- ${f}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
