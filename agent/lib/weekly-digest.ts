// @ts-check
/**
 * Дайджест недели (§11.1; PHASE-3 §5.2) — единый источник данных о трендах
 * для трёх потребителей:
 *  - schedule `weekly-report` (digest-блок в промпте proactive-сессии),
 *  - динамическая инструкция `user-context.ts` (краткие тренды),
 *  - tool `render-chart` (серии для графиков).
 *
 * «Неделя» = 7 ЗАВЕРШЁННЫХ локальных дней (вчера и старше; текущий день не
 * входит — §12.3). Сон-тренд сравнивается с предыдущей неделей (чтение за 14
 * дней). Средние считаются ТОЛЬКО по дням с данными (пропуски не зануляются,
 * §12.2 «медианы по доступным дням»).
 *
 * Структура модуля: pure-суммаризаторы над PeriodResult/food-картами
 * (unit-тестируются без БД) + DB-обёртка `buildWeeklyDigest`.
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "./db/client";
import { goals, weightLog } from "./db/schema";
import { computeCaloriePlanForUser } from "./calories";
import { readPeriod, type PeriodResult } from "./daily-read";
import { readFoodDays, type FoodDaySummary } from "./food-read";
import { getUserTimezone } from "./tenant";
import { localDay, localDayRangeUtc } from "./time";

/** Окно недельного отчёта (§11.1). */
export const REPORT_WINDOW_DAYS = 7;
/** Порог полноты: <N дней с данными — отчёт с пометкой о неполноте (§11.1). */
export const MIN_DAYS_FOR_FULL_REPORT = 4;

const DAY_MS = 86_400_000;

/**
 * Последние `count` ЗАВЕРШЁННЫХ локальных дней (вчера и старше), старшие → младшие.
 * Текущий локальный день не входит (он ещё идёт, §12.3).
 */
export function completedDaysList(tz: string, count: number, now = new Date()): string[] {
  const t = new Date(`${localDay(now, tz)}T00:00:00Z`).getTime();
  const list: string[] = [];
  for (let i = count; i >= 1; i--) {
    list.push(new Date(t - i * DAY_MS).toISOString().slice(0, 10));
  }
  return list;
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы секций digest
// ─────────────────────────────────────────────────────────────────────────────

export interface SleepDay {
  day: string;
  minutes: number | null;
}
export interface StepsDay {
  day: string;
  steps: number | null;
}
export interface WorkoutsDay {
  day: string;
  count: number;
  minutes: number;
}
export interface FoodDayStat {
  day: string;
  kcal: number;
  entries: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
}
export interface WeightPoint {
  day: string;
  kg: number;
}

export interface WeekDigest {
  tz: string;
  /** Текущий локальный день (не входит в отчётное окно). */
  today: string;
  /** 7 завершённых дней, старшие → младшие. */
  days: string[];
  /** Дней окна с любыми данными (сон/шаги/активность/тренировки). */
  daysWithData: number;
  /** true — данных < MIN_DAYS_FOR_FULL_REPORT (отчёт с пометкой, §11.1). */
  incomplete: boolean;
  sleep: {
    perDay: SleepDay[];
    avgMinutes: number | null;
    /** Средняя за предыдущую неделю (для тренда); null — нет данных. */
    prevAvgMinutes: number | null;
    /** avg − prevAvg; null — любая из недель без данных. */
    trendMinutes: number | null;
  };
  steps: {
    perDay: StepsDay[];
    avg: number | null;
  };
  workouts: {
    perDay: WorkoutsDay[];
    total: { count: number; minutes: number };
  };
  food: {
    perDay: FoodDayStat[];
    /** Дней окна с хотя бы одной записью еды. */
    daysLogged: number;
    /** Средний ккал/день ПО дням с записями. */
    avgKcal: number | null;
    avgProteinG: number | null;
    avgFatG: number | null;
    avgCarbsG: number | null;
  };
  kcalTarget: number | null;
  factorSource: "computed" | "self_reported" | null;
  weight: {
    points: WeightPoint[];
    /** Последнее − первое измерение окна; null при <2 точках. */
    deltaKg: number | null;
  };
  goal: {
    kind: string;
    targetWeightKg: number | null;
    tempoKgPerWeek: number | null;
    targetDate: string | null;
  } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure-суммаризаторы (без БД — unit-тестируются)
// ─────────────────────────────────────────────────────────────────────────────

/** unknown → number|null (DailyValue хранит unknown). */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function avgOrNull(values: number[], roundDigits = 0): number | null {
  if (values.length === 0) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const m = 10 ** roundDigits;
  return Math.round(avg * m) / m;
}

function minutesOf(period: PeriodResult, day: string): number | null {
  return num(period.get(day)?.get("sleep")?.value.total_minutes);
}

function stepsOf(period: PeriodResult, day: string): number | null {
  return num(period.get(day)?.get("steps")?.value.total_steps);
}

/** Сон за неделю + тренд vs предыдущая неделя (окно 14 дней одним периодом). */
export function summarizeSleep(period: PeriodResult, thisWeek: string[], prevWeek: string[]): WeekDigest["sleep"] {
  const perDay = thisWeek.map((day) => ({ day, minutes: minutesOf(period, day) }));
  const avgMinutes = avgOrNull(
    perDay.filter((d) => d.minutes != null).map((d) => d.minutes as number),
  );
  const prevValues = prevWeek
    .map((day) => minutesOf(period, day))
    .filter((m): m is number => m != null);
  const prevAvgMinutes = avgOrNull(prevValues);
  return {
    perDay,
    avgMinutes,
    prevAvgMinutes,
    trendMinutes:
      avgMinutes != null && prevAvgMinutes != null
        ? Math.round(avgMinutes - prevAvgMinutes)
        : null,
  };
}

export function summarizeSteps(period: PeriodResult, dayList: string[]): WeekDigest["steps"] {
  const perDay = dayList.map((day) => ({ day, steps: stepsOf(period, day) }));
  return {
    perDay,
    avg: avgOrNull(
      perDay.filter((d) => d.steps != null).map((d) => d.steps as number),
    ),
  };
}

export function summarizeWorkouts(period: PeriodResult, dayList: string[]): WeekDigest["workouts"] {
  const perDay: WorkoutsDay[] = [];
  const total = { count: 0, minutes: 0 };
  for (const day of dayList) {
    const v = period.get(day)?.get("workouts")?.value ?? {};
    const count = num(v.count) ?? 0;
    const items = Array.isArray(v.items) ? v.items : [];
    let minutes = 0;
    for (const item of items) {
      minutes += num((item as Record<string, unknown>).duration_min) ?? 0;
    }
    perDay.push({ day, count, minutes });
    total.count += count;
    total.minutes += minutes;
  }
  return { perDay, total: { count: total.count, minutes: Math.round(total.minutes) } };
}

/**
 * Питание за окно. День без записей → kcal 0 в perDay (для графика), но в
 * средние/`daysLogged` не входит (не записывал ≠ не ел).
 */
export function summarizeFood(
  foodDays: Map<string, FoodDaySummary>,
  dayList: string[],
): WeekDigest["food"] {
  const perDay: FoodDayStat[] = [];
  const loggedKcal: number[] = [];
  const loggedP: number[] = [];
  const loggedF: number[] = [];
  const loggedC: number[] = [];
  for (const day of dayList) {
    const d = foodDays.get(day);
    const entries = d?.entries.length ?? 0;
    const kcal = entries > 0 ? d!.totals.kcal : 0;
    perDay.push({
      day,
      kcal,
      entries,
      protein_g: entries > 0 ? d!.totals.protein_g : 0,
      fat_g: entries > 0 ? d!.totals.fat_g : 0,
      carbs_g: entries > 0 ? d!.totals.carbs_g : 0,
    });
    if (entries > 0) {
      loggedKcal.push(kcal);
      loggedP.push(d!.totals.protein_g);
      loggedF.push(d!.totals.fat_g);
      loggedC.push(d!.totals.carbs_g);
    }
  }
  return {
    perDay,
    daysLogged: loggedKcal.length,
    avgKcal: avgOrNull(loggedKcal),
    avgProteinG: avgOrNull(loggedP, 1),
    avgFatG: avgOrNull(loggedF, 1),
    avgCarbsG: avgOrNull(loggedC, 1),
  };
}

/** Дельта веса: последнее − первое измерение окна; null при <2 точках. */
export function summarizeWeight(points: WeightPoint[]): WeekDigest["weight"] {
  const delta =
    points.length >= 2
      ? Math.round((points[points.length - 1].kg - points[0].kg) * 100) / 100
      : null;
  return { points, deltaKg: delta };
}

/** Дней окна с любыми данными часов (сон/шаги/активность/тренировки). */
export function countDaysWithData(period: PeriodResult, dayList: string[]): number {
  let n = 0;
  for (const day of dayList) {
    const m = period.get(day);
    if (!m) continue;
    const has =
      minutesOf(period, day) != null ||
      stepsOf(period, day) != null ||
      num(m.get("activity")?.value.active_calories_kcal) != null ||
      num(m.get("activity")?.value.active_minutes) != null ||
      (num(m.get("workouts")?.value.count) ?? 0) > 0;
    if (has) n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Форматирование (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** 434 → «7.2» (часы с одним знаком). */
export function minutesToHoursStr(minutes: number): string {
  return (Math.round((minutes / 60) * 10) / 10).toFixed(1);
}

function signed(n: number, digits = 0): string {
  const m = 10 ** digits;
  const v = Math.round(n * m) / m;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

/**
 * Краткие тренд-строки для динамической инструкции user-context (§4):
 * только секции с данными, одной строкой на метрику.
 */
export function buildDigestTrendLines(d: WeekDigest): string[] {
  const lines: string[] = [];
  if (d.sleep.avgMinutes != null) {
    const parts = [`- сон (7 дн): в среднем ${minutesToHoursStr(d.sleep.avgMinutes)} ч/ночь`];
    if (d.sleep.trendMinutes != null) {
      const t = d.sleep.trendMinutes / 60;
      parts.push(`(${signed(t, 1)} ч vs предыдущая неделя)`);
    }
    lines.push(parts.join(" "));
  }
  if (d.steps.avg != null) lines.push(`- шаги: в среднем ${d.steps.avg}/день`);
  if (d.weight.deltaKg != null) {
    lines.push(`- вес: ${signed(d.weight.deltaKg, 1)} кг за неделю (${d.weight.points[d.weight.points.length - 1].kg} кг)`);
  }
  if (d.food.avgKcal != null) {
    const target = d.kcalTarget != null ? ` при цели ${d.kcalTarget}` : "";
    lines.push(`- калории: в среднем ${Math.round(d.food.avgKcal)} ккал/день${target} (записей ${d.food.daysLogged}/7 дней)`);
  }
  if (d.workouts.total.count > 0) {
    lines.push(`- тренировки: ${d.workouts.total.count} за неделю (${d.workouts.total.minutes} мин)`);
  }
  if (d.daysWithData < d.days.length) {
    lines.push(`- ⚠ данных часов: ${d.daysWithData}/${d.days.length} дней недели`);
  }
  return lines;
}

/**
 * Данные недели для промпта proactive-сессии weekly-report: все числа отчёта —
 * из этого блока (модель не транскрибирует данные из tools).
 */
export function digestPromptBlock(d: WeekDigest): string {
  const lines: string[] = [];
  lines.push(`### Данные недели (${d.days[0]} … ${d.days[d.days.length - 1]}, локальные дни ${d.tz})`);
  lines.push(`- дней с данными часов: ${d.daysWithData}/7`);

  lines.push("");
  lines.push("**Сон** (минуты по ночам):");
  for (const s of d.sleep.perDay) {
    lines.push(`- ${s.day}: ${s.minutes != null ? `${s.minutes} мин (${minutesToHoursStr(s.minutes)} ч)` : "нет данных"}`);
  }
  if (d.sleep.avgMinutes != null) lines.push(`- средняя длительность: ${d.sleep.avgMinutes} мин (${minutesToHoursStr(d.sleep.avgMinutes)} ч)`);
  if (d.sleep.prevAvgMinutes != null) lines.push(`- предыдущая неделя: ${d.sleep.prevAvgMinutes} мин`);
  if (d.sleep.trendMinutes != null) {
    lines.push(`- тренд vs предыдущая неделя: ${signed(d.sleep.trendMinutes)} мин`);
  }

  lines.push("");
  lines.push("**Шаги**:");
  for (const s of d.steps.perDay) {
    lines.push(`- ${s.day}: ${s.steps != null ? s.steps : "нет данных"}`);
  }
  if (d.steps.avg != null) lines.push(`- среднее: ${d.steps.avg}/день`);

  lines.push("");
  lines.push("**Вес**:");
  if (d.weight.points.length === 0) {
    lines.push("- взвешиваний за неделю нет");
  } else {
    for (const p of d.weight.points) lines.push(`- ${p.day}: ${p.kg} кг`);
    lines.push(
      d.weight.deltaKg != null
        ? `- дельта за неделю: ${signed(d.weight.deltaKg, 2)} кг`
        : "- дельта: недостаточно точек (одно взвешивание)",
    );
  }

  lines.push("");
  lines.push("**Калории**:");
  if (d.food.daysLogged === 0) {
    lines.push("- записей питания за неделю нет");
  } else {
    for (const f of d.food.perDay) {
      lines.push(
        `- ${f.day}: ${f.entries > 0 ? `${Math.round(f.kcal)} ккал (${f.entries} записей)` : "не записывал"}`,
      );
    }
    lines.push(`- дней с записями: ${d.food.daysLogged}/7`);
    lines.push(
      `- среднее по дням с записями: ${d.food.avgKcal != null ? Math.round(d.food.avgKcal) : "—"} ккал` +
        (d.food.avgProteinG != null ? ` (Б ${d.food.avgProteinG} / Ж ${d.food.avgFatG} / У ${d.food.avgCarbsG} г)` : ""),
    );
  }
  lines.push(
    d.kcalTarget != null
      ? `- целевой калораж: ${d.kcalTarget} ккал/день (метод: ${d.factorSource === "computed" ? "по реальным данным часов" : "по заявленному уровню активности, cold-start"})`
      : "- целевой калораж: не посчитан (профиль не заполнен)",
  );

  lines.push("");
  lines.push("**Тренировки**:");
  if (d.workouts.total.count === 0) {
    lines.push("- за неделю не зафиксировано");
  } else {
    lines.push(`- всего: ${d.workouts.total.count} шт, ${d.workouts.total.minutes} мин`);
    for (const w of d.workouts.perDay) {
      if (w.count > 0) lines.push(`- ${w.day}: ${w.count} шт, ${w.minutes} мин`);
    }
  }

  if (d.goal) {
    const g = d.goal;
    const parts = [g.kind];
    if (g.targetWeightKg != null) parts.push(`цель ${g.targetWeightKg} кг`);
    if (g.tempoKgPerWeek != null) parts.push(`темп ${g.tempoKgPerWeek} кг/нед`);
    if (g.targetDate != null) parts.push(`дедлайн ${g.targetDate}`);
    lines.push("");
    lines.push(`**Цель пользователя**: ${parts.join(", ")}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-обёртка
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Собрать дайджест недели юзера (7 завершённых локальных дней).
 * Цель по калориям — из lib/calories (единый источник с фазой 2); профиль не
 * заполнен → kcalTarget=null (не бросаем — остальной отчёт строится).
 */
export async function buildWeeklyDigest(userId: string): Promise<WeekDigest> {
  const tz = await getUserTimezone(userId);
  const now = new Date();
  const today = localDay(now, tz);

  const days14 = completedDaysList(tz, REPORT_WINDOW_DAYS * 2, now);
  const days = days14.slice(REPORT_WINDOW_DAYS); // последние 7 завершённых
  const prevWeek = days14.slice(0, REPORT_WINDOW_DAYS);

  const [period, foodDays, goalRow, caloriePlan] = await Promise.all([
    readPeriod(userId, tz, days14, ["sleep", "steps", "activity", "workouts"]),
    readFoodDays(userId, days),
    db.query.goals.findFirst({ where: and(eq(goals.userId, userId), eq(goals.active, true)) }),
    computeCaloriePlanForUser(userId).catch(() => null),
  ]);

  // Взвешивания окна недели (локальные дни; measured_at в [start окна, сейчас)).
  const windowStart = localDayRangeUtc(days[0], tz).start;
  const weightRows = await db
    .select({ weightKg: weightLog.weightKg, measuredAt: weightLog.measuredAt })
    .from(weightLog)
    .where(
      and(eq(weightLog.userId, userId), gte(weightLog.measuredAt, windowStart), lt(weightLog.measuredAt, now)),
    )
    .orderBy(desc(weightLog.measuredAt))
    .limit(60);
  // asc для дельты (первое → последнее измерение)
  const points: WeightPoint[] = weightRows
    .map((r) => ({ day: localDay(r.measuredAt, tz), kg: r.weightKg }))
    .reverse();

  const daysWithData = countDaysWithData(period, days);

  return {
    tz,
    today,
    days,
    daysWithData,
    incomplete: daysWithData < MIN_DAYS_FOR_FULL_REPORT,
    sleep: summarizeSleep(period, days, prevWeek),
    steps: summarizeSteps(period, days),
    workouts: summarizeWorkouts(period, days),
    food: summarizeFood(foodDays, days),
    kcalTarget: caloriePlan?.plan.targetKcal ?? null,
    factorSource: caloriePlan?.plan.factorSource ?? null,
    weight: summarizeWeight(points),
    goal: goalRow
      ? {
          kind: goalRow.kind,
          targetWeightKg: goalRow.targetWeightKg ?? null,
          tempoKgPerWeek: goalRow.tempoKgPerWeek ?? null,
          targetDate: goalRow.targetDate ? goalRow.targetDate.toISOString().slice(0, 10) : null,
        }
      : null,
  };
}
