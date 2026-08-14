// @ts-check
/**
 * Расчёт калорий — гибрид, вариант C (§11.2; PHASE-2 §6.5).
 *
 * Чистое ядро (unit-тестируемое) + DB-обёртка, собирающая входы для юзера.
 * Этим же модулем пользуется anomaly-check (фаза 4) — цель по калориям НЕ через
 * LLM-tool, а напрямую из кода (§11.5).
 *
 * Формула фактора активности (квантификация §11.2 — зафиксирована здесь и в
 * STATUS.md, спека формулу не задавала):
 *  - холодный старт (<14 дней истории): sedentary 1.2 / light 1.375 /
 *    moderate 1.55 / active 1.725 (`profiles.self_reported_activity_level`);
 *  - при ≥14 днях: базовые пороги по средним шагам/день
 *      <5000 → 1.2 · <7500 → 1.375 · <10000 → 1.55 · ≥10000 → 1.725,
 *    плюс active_minutes (≥30 мин → +0.05, ≥60 → +0.1) и слабый HR-модификатор
 *    (медиана resting_bpm ≥ 85 → +0.025); итог зажимается в [1.2, 1.9].
 *  - TDEE_бот = BMR × фактор; TDEE_часы = BMR + средние active_calories (§11.2).
 *  - Цель = TDEE ± (tempo_kg_per_week × 7700 / 7); пол — 1200 (жен) / 1500 (муж)
 *    ккал/день (стандартный guardrail; применение флагается).
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "./db/client";
import { goals, profiles, weightLog } from "./db/schema";
import { readPeriod, type PeriodResult } from "./daily-read";
import { getUserTimezone } from "./tenant";
import { localDay } from "./time";

/** ~7700 ккал на кг жира (§11.2). */
export const KCAL_PER_KG_FAT = 7700;

/** Окно истории для вычисленного фактора активности (§11.2 «последние 14 дней»). */
export const HISTORY_WINDOW_DAYS = 14;

/** Максимальный безопасный дефицит/профицит (ккал/день), независимо от темпа. */
const MAX_DAILY_ADJUSTMENT = 1100; // ~1 кг/нед — медициной не рекомендуется больше

/** Минимальный целевой калораж (guardrail). */
export function calorieFloor(sex: string): number {
  return sex === "male" ? 1500 : 1200;
}

export type ActivityLevel = "sedentary" | "light" | "moderate" | "active";
export type GoalKind = "weight_loss" | "maintenance" | "muscle_gain";
export type CalorieSource = "hybrid" | "device" | "manual";

/** Факторы cold-start (§11.2). */
export const SELF_REPORTED_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
};

export function isActivityLevel(v: string): v is ActivityLevel {
  return v === "sedentary" || v === "light" || v === "moderate" || v === "active";
}

/** BMR по Mifflin-St Jeor (§11.2). */
export function bmrMifflinStJeor(sex: string, weightKg: number, heightCm: number, ageYears: number): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return Math.round(sex === "male" ? base + 5 : base - 161);
}

/** Возраст (полных лет) из даты рождения (UTC-компоненты, date-режим drizzle). */
export function ageFromBirthDate(birthDate: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const m = now.getUTCMonth() - birthDate.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birthDate.getUTCDate())) age--;
  return age;
}

/** Агрегаты активности за окно истории (из daily-данных, §11.2). */
export interface ActivityHistory {
  /** Дней (из окна 14) с любыми данными (шаги/активность). */
  daysWithData: number;
  avgSteps: number | null;
  avgActiveMinutes: number | null;
  /** Медиана resting_bpm по дням, где он есть. */
  medianRestingBpm: number | null;
  /** Средние active_calories/день — для TDEE_по_часам. */
  avgActiveCalories: number | null;
}

/**
 * Фактор активности из истории (≥14 дней). null → недостаточно сигнала
 * (вызывающий откатывается на self_reported). Формула — см. шапку модуля.
 */
export function activityFactorFromHistory(h: ActivityHistory): number | null {
  if (h.avgSteps == null) return null;
  let factor: number;
  if (h.avgSteps < 5000) factor = 1.2;
  else if (h.avgSteps < 7500) factor = 1.375;
  else if (h.avgSteps < 10000) factor = 1.55;
  else factor = 1.725;

  if (h.avgActiveMinutes != null) {
    if (h.avgActiveMinutes >= 60) factor += 0.1;
    else if (h.avgActiveMinutes >= 30) factor += 0.05;
  }
  // Слабый HR-модификатор (высокая медиана resting HR → чуть выше нагрузка
  // метаболизма; индивидуальная вариативность RHR велика — вклад минимален).
  if (h.medianRestingBpm != null && h.medianRestingBpm >= 85) factor += 0.025;

  // Округление до 3 знаков — убирает float-пыль от сложения бампов (1.6500000000000001).
  return Math.round(Math.min(1.9, Math.max(1.2, factor)) * 1000) / 1000;
}

export interface CalorieGoalInput {
  kind: GoalKind;
  targetWeightKg: number | null;
  targetDate: string | null; // "YYYY-MM-DD" (локальный)
  tempoKgPerWeek: number | null;
  calorieSource: CalorieSource;
  manualTargetKcal: number | null;
}

export interface CalorieInputs {
  sex: string; // 'male' | 'female'
  ageYears: number;
  heightCm: number;
  weightKg: number;
  selfReportedLevel: ActivityLevel;
  history: ActivityHistory;
  goal: CalorieGoalInput | null; // null → maintenance (по умолчанию)
  today: string; // локальный день юзера ("YYYY-MM-DD")
}

export interface CaloriePlan {
  bmr: number;
  activityFactor: number; // округлён до 3 знаков
  factorSource: "computed" | "self_reported";
  daysOfHistory: number;
  historyWindowDays: number; // = HISTORY_WINDOW_DAYS (для объяснения юзеру)
  tdeeBot: number; // «по боту» (§11.2)
  tdeeDevice: number | null; // «по часам» — для справки
  targetKcal: number;
  calorieSource: CalorieSource;
  dailyAdjustmentKcal: number; // дефицит (−) / профицит (+) под цель
  tempoKgPerWeek: number; // использованный темп (может быть выведен из deadline)
  floorApplied: boolean;
  notes: string[]; // пояснения для модели/юзера
}

/** Темп (кг/нед) под цель: явный tempo, либо выведенный из target_date. */
function resolveTempo(inputs: CalorieInputs): { tempo: number; note: string | null } {
  const goal = inputs.goal;
  if (!goal || goal.kind === "maintenance") return { tempo: 0, note: null };
  if (goal.tempoKgPerWeek != null && goal.tempoKgPerWeek > 0) {
    return { tempo: goal.tempoKgPerWeek, note: null };
  }
  if (goal.targetWeightKg != null && goal.targetDate != null) {
    const daysLeft = Math.round(
      (new Date(`${goal.targetDate}T00:00:00Z`).getTime() - new Date(`${inputs.today}T00:00:00Z`).getTime()) /
        86_400_000,
    );
    if (daysLeft <= 0) return { tempo: 0, note: "дедлайн цели уже прошёл — обнови цель" };
    const deltaKg = Math.abs(inputs.weightKg - goal.targetWeightKg);
    const weeks = Math.max(daysLeft / 7, 0.25);
    const tempo = deltaKg / weeks;
    if (tempo === 0) return { tempo: 0, note: "текущий вес уже равен целевому" };
    return { tempo, note: null };
  }
  return { tempo: 0, note: "у цели не задан ни темп, ни дедлайн — считаю поддержку веса" };
}

/** Ядро расчёта (чистая функция). */
export function computeCaloriePlan(inputs: CalorieInputs): CaloriePlan {
  const notes: string[] = [];
  const bmr = bmrMifflinStJeor(inputs.sex, inputs.weightKg, inputs.heightCm, inputs.ageYears);

  // Фактор активности: реальная история (≥14 дней) или cold-start fallback.
  const enoughHistory = inputs.history.daysWithData >= HISTORY_WINDOW_DAYS;
  let factor: number;
  let factorSource: "computed" | "self_reported";
  if (enoughHistory) {
    const computed = activityFactorFromHistory(inputs.history);
    if (computed != null) {
      factor = computed;
      factorSource = "computed";
    } else {
      factor = SELF_REPORTED_FACTORS[inputs.selfReportedLevel];
      factorSource = "self_reported";
      notes.push("история есть, но шаги не снимаются — фактор из self-reported уровня");
    }
  } else {
    factor = SELF_REPORTED_FACTORS[inputs.selfReportedLevel];
    factorSource = "self_reported";
    notes.push(
      `данных пока ${inputs.history.daysWithData}/${HISTORY_WINDOW_DAYS} дней — cold-start (self-reported уровень)`,
    );
  }

  const tdeeBot = Math.round(bmr * factor);
  const tdeeDevice =
    inputs.history.avgActiveCalories != null
      ? Math.round(bmr + inputs.history.avgActiveCalories)
      : null;

  const goal = inputs.goal;
  const calorieSource: CalorieSource = goal?.calorieSource ?? "hybrid";
  const { tempo, note: tempoNote } = resolveTempo(inputs);
  if (tempoNote) notes.push(tempoNote);

  // База для цели: hybrid → «по боту», device → «по часам» (fallback на бота).
  let baseTdee = tdeeBot;
  if (calorieSource === "device") {
    if (tdeeDevice != null) baseTdee = tdeeDevice;
    else notes.push("нет active_calories с часов — база по боту");
  }

  let adjustment = 0;
  if (goal && goal.kind !== "maintenance" && tempo > 0) {
    adjustment = (tempo * KCAL_PER_KG_FAT) / 7;
    if (Math.abs(adjustment) > MAX_DAILY_ADJUSTMENT) {
      notes.push(
        `темп ${tempo} кг/нед требует ${Math.round(adjustment)} ккал/день — зажимаю до ${MAX_DAILY_ADJUSTMENT}`,
      );
      adjustment = Math.sign(adjustment) * MAX_DAILY_ADJUSTMENT;
    }
    adjustment = goal.kind === "weight_loss" ? -adjustment : adjustment;
  }

  let targetKcal: number;
  if (calorieSource === "manual") {
    if (goal?.manualTargetKcal != null && goal.manualTargetKcal > 0) {
      targetKcal = Math.round(goal.manualTargetKcal);
    } else {
      targetKcal = baseTdee + Math.round(adjustment);
      notes.push("calorie_source=manual, но ручная норма не задана — считаю по боту");
    }
  } else {
    targetKcal = Math.round(baseTdee + adjustment);
  }

  const floor = calorieFloor(inputs.sex);
  let floorApplied = false;
  if (calorieSource !== "manual" && targetKcal < floor) {
    targetKcal = floor;
    floorApplied = true;
    notes.push(`цель ниже безопасного минимума (${floor} ккал) — поднята до минимума`);
  }

  return {
    bmr,
    activityFactor: Math.round(factor * 1000) / 1000,
    factorSource,
    daysOfHistory: inputs.history.daysWithData,
    historyWindowDays: HISTORY_WINDOW_DAYS,
    tdeeBot,
    tdeeDevice,
    targetKcal,
    calorieSource,
    dailyAdjustmentKcal: Math.round(adjustment),
    tempoKgPerWeek: Math.round(tempo * 100) / 100,
    floorApplied,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-обёртка: сбор входов для юзера
// ─────────────────────────────────────────────────────────────────────────────

/** Коэрсия unknown → number|null (DailyValue хранит unknown). */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** История активности за последние 14 ЗАВЕРШЁННЫХ локальных дней (без сегодня). */
export async function buildActivityHistory(userId: string, tz: string): Promise<ActivityHistory> {
  const today = localDay(new Date(), tz);
  const dayList: string[] = [];
  const t = new Date(`${today}T00:00:00Z`).getTime();
  for (let i = HISTORY_WINDOW_DAYS; i >= 1; i--) {
    dayList.push(new Date(t - i * 86_400_000).toISOString().slice(0, 10));
  }

  const period: PeriodResult = await readPeriod(userId, tz, dayList, ["steps", "activity", "heart_rate"]);

  let daysWithData = 0;
  const stepsArr: number[] = [];
  const activeMinArr: number[] = [];
  const activeKcalArr: number[] = [];
  const restingArr: number[] = [];
  for (const day of dayList) {
    const m = period.get(day);
    if (!m) continue;
    const steps = num(m.get("steps")?.value.total_steps);
    const activity = m.get("activity")?.value ?? {};
    const activeMin = num(activity.active_minutes);
    const activeKcal = num(activity.active_calories_kcal);
    const resting = num(m.get("heart_rate")?.value.resting_bpm);

    if (steps != null || activeMin != null || activeKcal != null) daysWithData++;
    if (steps != null) stepsArr.push(steps);
    if (activeMin != null) activeMinArr.push(activeMin);
    if (activeKcal != null) activeKcalArr.push(activeKcal);
    if (resting != null) restingArr.push(resting);
  }

  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  return {
    daysWithData,
    avgSteps: avg(stepsArr),
    avgActiveMinutes: avg(activeMinArr),
    medianRestingBpm: median(restingArr),
    avgActiveCalories: avg(activeKcalArr),
  };
}

/**
 * Полный расчёт для юзера: профиль + цель + история → план.
 * Плюс маркер `switched`: момент перехода cold-start → реальные данные, чтобы
 * модель сообщила «теперь считаю калории по твоим реальным данным» (§11.2).
 *
 * Маркер — in-memory (паттерн §9 fuzzy dedup): фиксирует только наблюдённый
 * переход; рестарт процесса сбрасывает тихо (повторных уведомлений нет, а
 * авторитетная проверка переедет в dispatcher фазы 4).
 */
const lastFactorSource = new Map<string, "computed" | "self_reported">();

export async function computeCaloriePlanForUser(
  userId: string,
): Promise<{ plan: CaloriePlan; switched: boolean }> {
  const [profile, goalRow, tz] = await Promise.all([
    db.query.profiles.findFirst({ where: eq(profiles.userId, userId) }),
    db.query.goals.findFirst({ where: and(eq(goals.userId, userId), eq(goals.active, true)) }),
    getUserTimezone(userId),
  ]);

  let weightKg = profile?.currentWeightKg ?? null;
  if (weightKg == null) {
    // Фолбэк: последнее взвешивание из weight_log (§11.5 «вес — из weight_log»).
    const w = await db
      .select({ weightKg: weightLog.weightKg })
      .from(weightLog)
      .where(eq(weightLog.userId, userId))
      .orderBy(desc(weightLog.measuredAt))
      .limit(1);
    weightKg = w[0]?.weightKg ?? null;
  }
  if (profile == null || weightKg == null) {
    throw new Error("профиль не заполнен (пол/возраст/рост/вес) — расчёт калорий невозможен");
  }

  const history = await buildActivityHistory(userId, tz);
  const inputs: CalorieInputs = {
    sex: profile.sex,
    ageYears: ageFromBirthDate(profile.birthDate),
    heightCm: profile.heightCm,
    weightKg,
    selfReportedLevel: isActivityLevel(profile.selfReportedActivityLevel)
      ? profile.selfReportedActivityLevel
      : "sedentary",
    history,
    goal: goalRow
      ? {
          kind: (["weight_loss", "maintenance", "muscle_gain"] as const).includes(
              goalRow.kind as GoalKind,
            )
            ? (goalRow.kind as GoalKind)
            : "maintenance",
          targetWeightKg: goalRow.targetWeightKg ?? null,
          targetDate: goalRow.targetDate ? goalRow.targetDate.toISOString().slice(0, 10) : null,
          tempoKgPerWeek: goalRow.tempoKgPerWeek ?? null,
          calorieSource: (["hybrid", "device", "manual"] as const).includes(
              goalRow.calorieSource as CalorieSource,
            )
            ? (goalRow.calorieSource as CalorieSource)
            : "hybrid",
          manualTargetKcal: goalRow.manualTargetKcal ?? null,
        }
      : null,
    today: localDay(new Date(), tz),
  };

  const plan = computeCaloriePlan(inputs);
  const switched =
    lastFactorSource.get(userId) === "self_reported" && plan.factorSource === "computed";
  lastFactorSource.set(userId, plan.factorSource);
  return { plan, switched };
}
