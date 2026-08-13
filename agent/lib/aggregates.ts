// @ts-check
/**
 * Логика схлопывания сырых сэмплов в дневные агрегаты (§5.3, §12.1, §12.3).
 *
 * Чистые функции от массива `RawSample` одного (user, локальный день, metric) →
 * `value`-объект дневного агрегата. Не трогают БД — unit-тестируемые (§18.1).
 *
 * Ключевые правила:
 *  - Сон через полночь относится к дате пробуждения (§12.1): длительность считается
 *    по абсолютным timestamp'ам (DST-safe), bedtime/wake — "HH:MM" в tz юзера.
 *  - raw metric → agg metric: sleep_session→sleep, active_calories→activity и т.д.
 *  - `workouts.calories_kgl` → `calories_kcal` (опечатка §5.3, фикс в STATUS.md).
 */
import { localDay, sleepWakeDay } from "./time";

export type RawMetric =
  | "sleep_session"
  | "steps"
  | "heart_rate"
  | "active_calories"
  | "workout";

export type AggregateMetric = "sleep" | "steps" | "heart_rate" | "activity" | "workouts";

/** Минимальный вид сырого сэмпла для агрегации. */
export interface RawSample {
  recordedAt: Date;
  payload: Record<string, unknown>;
}

export interface DailyValue {
  [key: string]: unknown;
}

/** raw metric → aggregate metric (§5.3). */
export function aggregateMetricName(rawMetric: string): AggregateMetric | null {
  switch (rawMetric) {
    case "sleep_session":
      return "sleep";
    case "steps":
      return "steps";
    case "heart_rate":
      return "heart_rate";
    case "active_calories":
      return "activity";
    case "workout":
      return "workouts";
    default:
      return null;
  }
}

/**
 * Локальный день, к которому относится сэмпл (§12.1). Для сна — дата пробуждения;
 * для остальных — локальный день recorded_at.
 */
export function computeLocalDayForMetric(
  metric: string,
  recordedAt: Date,
  payload: Record<string, unknown>,
  tz: string,
): string {
  if (metric === "sleep_session") {
    const bedAt = new Date(payload.bed_at as string);
    const wakeAt = new Date(payload.wake_at as string);
    return sleepWakeDay(bedAt, wakeAt, tz);
  }
  return localDay(recordedAt, tz);
}

// ── Временные хелперы (Intl, 0 зависимостей) ──────────────────────────────────

function localHourAndMinute(date: Date, tz: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return { hour, minute };
}

/** "HH:MM" в tz юзера для данного UTC-момента. */
export function hhmmInTz(date: Date, tz: string): string {
  const { hour, minute } = localHourAndMinute(date, tz);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ── Агрегация по metric ───────────────────────────────────────────────────────

/**
 * Сон за день. Берём сессию с самым поздним wake_at (последняя запись выигрывает,
 * §12.4). Длительность — по абсолютным ts (DST-safe, §12.1).
 */
export function aggregateSleep(samples: RawSample[], tz: string): DailyValue {
  if (samples.length === 0) return {};
  const latest = [...samples].sort((a, b) => {
    const aw = new Date(a.payload.wake_at as string).getTime();
    const bw = new Date(b.payload.wake_at as string).getTime();
    return aw - bw;
  })[samples.length - 1];
  const p = latest.payload;

  const bedAt = new Date(p.bed_at as string);
  const wakeAt = new Date(p.wake_at as string);
  const totalMinutes = Math.round((wakeAt.getTime() - bedAt.getTime()) / 60_000);
  const awakeMin = num(p.awake_min) ?? 0;
  const efficiency =
    num(p.efficiency_pct) ??
    (totalMinutes > 0 ? Math.round(((totalMinutes - awakeMin) / totalMinutes) * 100) : undefined);

  return {
    total_minutes: totalMinutes,
    bedtime_local: hhmmInTz(bedAt, tz),
    wake_local: hhmmInTz(wakeAt, tz),
    efficiency_pct: efficiency,
    deep_min: num(p.deep_min),
    light_min: num(p.light_min),
    rem_min: num(p.rem_min),
    awake_min: num(p.awake_min) ?? 0,
    source: typeof p.source === "string" ? p.source : undefined,
  };
}

/** Шаги за день: сумма + по часам (локальный час recorded_at). */
export function aggregateSteps(samples: RawSample[], tz: string): DailyValue {
  const byHour = new Array(24).fill(0) as number[];
  let total = 0;
  for (const s of samples) {
    const steps = num(s.payload.steps) ?? 0;
    total += steps;
    const { hour } = localHourAndMinute(s.recordedAt, tz);
    byHour[hour] += steps;
  }
  return { total_steps: total, by_hour: byHour };
}

/** Пульс за день: avg/min/max; resting — min из kind="resting" (иначе дневной min). */
export function aggregateHeartRate(samples: RawSample[]): DailyValue {
  if (samples.length === 0) return {};
  let sum = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let resting: number | undefined;
  for (const s of samples) {
    const bpm = num(s.payload.bpm);
    if (bpm === undefined) continue;
    sum += bpm;
    count += 1;
    if (bpm < min) min = bpm;
    if (bpm > max) max = bpm;
    if (s.payload.kind === "resting" && (resting === undefined || bpm < resting)) resting = bpm;
  }
  if (count === 0) return {};
  return {
    resting_bpm: resting ?? min, // нет явного resting — суточный min как прокси
    avg_bpm: Math.round(sum / count),
    min_bpm: min,
    max_bpm: max,
  };
}

/** Активность за день: суммы active/total калорий и active минут. */
export function aggregateActivity(samples: RawSample[]): DailyValue {
  let activeKcal = 0;
  let totalKcal = 0;
  let hasTotal = false;
  let activeMin = 0;
  let hasActiveMin = false;
  for (const s of samples) {
    activeKcal += num(s.payload.active_kcal) ?? 0;
    const t = num(s.payload.total_kcal);
    if (t !== undefined) {
      totalKcal += t;
      hasTotal = true;
    }
    const m = num(s.payload.active_min);
    if (m !== undefined) {
      activeMin += m;
      hasActiveMin = true;
    }
  }
  return {
    active_calories_kcal: round1(activeKcal),
    total_calories_kcal: hasTotal ? round1(totalKcal) : undefined,
    active_minutes: hasActiveMin ? Math.round(activeMin) : undefined,
  };
}

/** Тренировки за день: count + items[]. */
export function aggregateWorkouts(samples: RawSample[], tz: string): DailyValue {
  const items = samples.map((s) => {
    const startAt = new Date(s.payload.start_at as string);
    return {
      type: String(s.payload.type ?? "unknown"),
      duration_min: num(s.payload.duration_min) ?? 0,
      calories_kcal: num(s.payload.calories_kcal),
      start_local: hhmmInTz(startAt, tz),
    };
  });
  return { count: items.length, items };
}

/**
 * Диспетчер агрегации: выбрать функцию по raw metric и прогнать на сэмплах ОДНОГО
 * локального дня. Возвращает `value` (может быть пустым, если данных нет).
 */
export function aggregateForDay(
  rawMetric: RawMetric,
  samples: RawSample[],
  tz: string,
): DailyValue {
  switch (rawMetric) {
    case "sleep_session":
      return aggregateSleep(samples, tz);
    case "steps":
      return aggregateSteps(samples, tz);
    case "heart_rate":
      return aggregateHeartRate(samples);
    case "active_calories":
      return aggregateActivity(samples);
    case "workout":
      return aggregateWorkouts(samples, tz);
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
