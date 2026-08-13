// @ts-check
/**
 * Нормализация входящего payload phone-hub (§6.1, откр. вопрос §20.1).
 *
 * Контракт: webhook ожидает КАНОНИЧЕСКИЙ формат payload по `metric`. Forwarder'ы
 * (mcnaveen/health-connect-webhook для Android, «Health Webhook» для iOS) могут
 * слать свои имена полей — для них есть слой вариантного маппинга по `platform`.
 *
 * Архитектура (Canonical + variant-mapping, подтверждено в STATUS.md):
 *  - `metricPayloadSchemas` — единый канонический формат-источник для каждого metric.
 *  - `variantMappers` — реестр `(platform, metric) → (raw) => canonicalRaw`; пока
 *    identity (forwarder/shim шлёт канонический вид). Реальные маппинги добавляются
 *    при подключении устройства — имена полей уточняются по реальному выводу (§20.1).
 *  - `normalizeInbound` — применить маппер → валидировать канонической схемой →
 *    вычислить канонический `recorded_at` (время события, §5.3).
 *
 * `recorded_at` (колонка, UTC timestamptz) = время события/измерения:
 *  - sleep_session → wake_at (дата пробуждения, §12.1);
 *  - workout → start_at;
 *  - steps / heart_rate / active_calories → bucket/sample-время (из тела, обязательно).
 *
 * Timestamp'ы в payload хранятся как ISO-UTC строки (jsonb). Строки БЕЗ offset/Z
 * отвергаются — иначе `new Date()` парсит их как local (машинный tz) → тихий баг.
 */
import { z } from "zod";

export type Metric =
  | "sleep_session"
  | "steps"
  | "heart_rate"
  | "active_calories"
  | "workout";

export const METRICS: readonly Metric[] = [
  "sleep_session",
  "steps",
  "heart_rate",
  "active_calories",
  "workout",
];

/** Принять ISO-строку (с offset/Z) | epoch ms | epoch s | Date → канонический ISO-UTC. */
function toIso(value: unknown): string {
  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    // epoch секунд (< 1e12) → ms; иначе уже ms
    d = new Date(value < 1e12 ? value * 1000 : value);
  } else if (typeof value === "string") {
    // Требуем явный offset/Z — без него new Date() трактует как local (небезопасно).
    if (!/\d{4}-\d{2}-\d{2}T.*([Zz]|[+-]\d{2}:?\d{2})$/.test(value.trim())) {
      throw new Error(`timestamp требует offset/Z: «${value}»`);
    }
    d = new Date(value);
  } else {
    throw new Error(`timestamp ожидает ISO-строку/epoch/Date: «${String(value)}»`);
  }
  const t = d.getTime();
  if (!Number.isFinite(t)) throw new Error(`невалидный timestamp: «${String(value)}»`);
  return new Date(t).toISOString();
}

const tsField = z.union([z.string(), z.number(), z.date()]).transform(toIso);
const positiveInt = z.number().int().nonnegative();
const nonNegNumber = z.number().min(0);

// ── Канонические схемы payload ────────────────────────────────────────────────

const sleepPayloadSchema = z.object({
  bed_at: tsField,
  wake_at: tsField,
  total_minutes: positiveInt.optional(),
  deep_min: nonNegNumber.optional(),
  light_min: nonNegNumber.optional(),
  rem_min: nonNegNumber.optional(),
  awake_min: nonNegNumber.optional(),
  efficiency_pct: z.number().min(0).max(100).optional(),
  source: z.string().trim().max(64).optional(),
});

const stepsPayloadSchema = z.object({
  steps: positiveInt,
  // Информационная метка бакета (напр. "2026-03-15 22:00"); для дедупа достаточно
  // recorded_at (§12.4) — bucket избыточен, но хранится для читаемости.
  bucket: z.string().trim().max(32).optional(),
});

const heartRatePayloadSchema = z.object({
  bpm: positiveInt,
  kind: z.enum(["resting", "sample"]).optional(),
});

const activeCaloriesPayloadSchema = z.object({
  active_kcal: nonNegNumber,
  total_kcal: nonNegNumber.optional(),
  active_min: nonNegNumber.optional(),
});

const workoutPayloadSchema = z.object({
  type: z.string().trim().min(1).max(64),
  start_at: tsField,
  duration_min: positiveInt,
  calories_kcal: nonNegNumber.optional(),
  end_at: tsField.optional(),
});

/** Канонические схемы payload по metric. Выход — plain-объект (ISO-строки в payload). */
export const metricPayloadSchemas = {
  sleep_session: sleepPayloadSchema,
  steps: stepsPayloadSchema,
  heart_rate: heartRatePayloadSchema,
  active_calories: activeCaloriesPayloadSchema,
  workout: workoutPayloadSchema,
} as const;

export type CanonicalPayload = Record<string, unknown>;

// ── Слой вариантного маппинга (§20.1) ─────────────────────────────────────────

type RawPayload = Record<string, unknown>;
/** Маппер переводит «родной» формат forwarder'а в канонический raw-объект. */
type VariantMapper = (raw: RawPayload) => RawPayload;

/**
 * Реестр мапперов по `${platform}:${metric}`. По умолчанию — identity: считается,
 * что forwarder (или тонкий shim перед ним) уже шлёт канонический вид.
 *
 * Реальные маппинги добавляются при подключении конкретного устройства — имена полей
 * берутся из реального вывода forwarder'а. Пример (НЕ угадываем заранее):
 *   "android:sleep_session": (r) => ({ bed_at: r.startTime, wake_at: r.endTime, ... })
 */
const variantMappers: Record<string, VariantMapper> = {};

function lookupMapper(platform: string, metric: string): VariantMapper {
  return variantMappers[`${platform}:${metric}`] ?? ((r) => r);
}

/**
 * Зарегистрировать маппер «родной» формат forwarder'а → канонический (§20.1).
 * Точка расширения: реальные маппинги добавляются при подключении конкретного устройства
 * (имена полей берутся из реального вывода forwarder'а). Используется также в тестах.
 */
export function registerVariantMapper(
  platform: string,
  metric: Metric,
  fn: VariantMapper,
): void {
  variantMappers[`${platform}:${metric}`] = fn;
}

/** Очистить реестр мапперов (для тестов). */
export function clearVariantMappers(): void {
  for (const k of Object.keys(variantMappers)) delete variantMappers[k];
}

// ── Нормализация ──────────────────────────────────────────────────────────────

export interface NormalizeInput {
  platform: string;
  metric: string;
  recordedAt?: unknown; // из тела; для bucket-метрик — обязательно
  payload: unknown;
}

export interface NormalizedSample {
  metric: Metric;
  payload: CanonicalPayload;
  recordedAt: Date;
}

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

/** Канонический recorded_at по metric (§5.3). */
function deriveRecordedAt(metric: Metric, payload: CanonicalPayload, fallback?: unknown): Date {
  if (metric === "sleep_session") {
    return new Date(toIso(payload.wake_at));
  }
  if (metric === "workout") {
    return new Date(toIso(payload.start_at));
  }
  // bucket-метрики: recorded_at обязателен в теле (время сэмпла/бакета).
  if (fallback === undefined) {
    throw new PayloadError(`recorded_at обязателен для metric="${metric}"`);
  }
  return new Date(toIso(fallback));
}

/**
 * Нормализовать входящий сэмпл в канонический вид. Бросает `PayloadError` при
 * невалидном payload (webhook вернёт 400). Возвращает канонический `payload` и
 * авторитетный `recordedAt` (UTC Date) для колонки raw_samples.
 */
export function normalizeInbound(input: NormalizeInput): NormalizedSample {
  if (!METRICS.includes(input.metric as Metric)) {
    throw new PayloadError(`неизвестный metric: «${input.metric}»`);
  }
  const metric = input.metric as Metric;

  if (input.payload === null || typeof input.payload !== "object") {
    throw new PayloadError("payload должен быть объектом");
  }

  const mapped = lookupMapper(input.platform, metric)(input.payload as RawPayload);
  const schema = metricPayloadSchemas[metric];
  const parsed = schema.safeParse(mapped);
  if (!parsed.success) {
    throw new PayloadError(`невалидный payload (${metric}): ${parsed.error.message}`);
  }
  const payload = parsed.data as CanonicalPayload;

  let recordedAt: Date;
  try {
    recordedAt = deriveRecordedAt(metric, payload, input.recordedAt);
  } catch (e) {
    throw new PayloadError(e instanceof Error ? e.message : "невалидный recorded_at");
  }

  // Согласованность: bed_at должно быть раньше wake_at.
  if (metric === "sleep_session") {
    const bed = new Date(payload.bed_at as string).getTime();
    const wake = new Date(payload.wake_at as string).getTime();
    if (wake <= bed) throw new PayloadError("wake_at должен быть позже bed_at");
  }

  return { metric, payload, recordedAt };
}
