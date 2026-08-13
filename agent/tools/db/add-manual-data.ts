// @ts-check
import { defineTool } from "eve/tools";
import { z } from "zod";

import { ingestSample } from "../../lib/dedup";
import { normalizeInbound } from "../../lib/normalize";
import { requireUser } from "../../lib/tenant";

/**
 * Timestamp-строка ISO 8601 с offset/Z (напр. 2026-03-15T06:30:00+03:00 или ...Z).
 * Без offset отвергается (иначе парсинг как local — небезопасно). Время — UTC или
 * локальное с offset; модель строит его, зная tz юзера из контекста.
 */
const ts = z
  .string()
  .min(1)
  .describe("ISO 8601 с offset/Z, напр. 2026-03-15T06:30:00+03:00");

// Дискриминированный вход по metric — модель заполняет типизированные поля,
// парся свободный текст юзера («спал 6ч, лёг 00:30, встал 06:30»).
const inputSchema = z.discriminatedUnion("metric", [
  z.object({
    metric: z.literal("sleep_session"),
    bed_at: ts.describe("Когда лёг (ISO с offset)."),
    wake_at: ts.describe("Когда встал (ISO с offset) — определяет дату сна."),
    total_minutes: z.number().optional(),
    deep_min: z.number().optional(),
    light_min: z.number().optional(),
    rem_min: z.number().optional(),
    awake_min: z.number().optional(),
    efficiency_pct: z.number().min(0).max(100).optional(),
  }),
  z.object({
    metric: z.literal("steps"),
    recorded_at: ts.describe("Время/старт бакета шагов (ISO с offset)."),
    steps: z.number().int().nonnegative(),
    bucket: z.string().optional(),
  }),
  z.object({
    metric: z.literal("heart_rate"),
    recorded_at: ts.describe("Время замера пульса (ISO с offset)."),
    bpm: z.number().int().nonnegative(),
    kind: z.enum(["resting", "sample"]).optional(),
  }),
  z.object({
    metric: z.literal("active_calories"),
    recorded_at: ts.describe("Время/старт бакета калорий (ISO с offset)."),
    active_kcal: z.number().min(0),
    total_kcal: z.number().min(0).optional(),
    active_min: z.number().min(0).optional(),
  }),
  z.object({
    metric: z.literal("workout"),
    start_at: ts.describe("Старт тренировки (ISO с offset) — определяет её дату."),
    type: z.string().min(1).max(64),
    duration_min: z.number().int().nonnegative(),
    calories_kcal: z.number().min(0).optional(),
    end_at: ts.optional(),
  }),
]);

export default defineTool({
  description:
    "Записать данные вручную (когда часов нет под рукой или пользователь внёс " +
    "вручную): сон/шаги/пульс/калории/тренировку. Пиши в canonical-формате — " +
    "инструмент сам валидирует и положит как manual-запись (source='manual'). " +
    "Парси свободный текст юзера в поля: «спал 6ч, лёг 00:30, встал 06:30» → " +
    "metric=sleep_session + bed_at/wake_at. Назначение manual — ЗАПОЛНЯТЬ пробелы " +
    "(когда данных с часов нет). Поведение при совпадении с автоматическими данными: " +
    "один сэмпл на (metric, recorded_at) — last-write-wins; обычно синхронизация часов " +
    "приходит позже и перезаписывает manual-placeholder (устройство авторитетно). Для " +
    "bucket-метрик не суммируется с device — выбирается одно значение (§12.2, STATUS.md).",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);

    const metric = input.metric;
    const recordedAt = "recorded_at" in input ? input.recorded_at : undefined;
    // payload = всё, кроме metric и recorded_at (recorded_at живёт в колонке, не в payload).
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (k !== "metric" && k !== "recorded_at") payload[k] = v;
    }
    let sample;
    try {
      sample = normalizeInbound({
        platform: "manual",
        metric,
        recordedAt,
        payload,
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "невалидные данные" };
    }
    // Помечаем manual-источник — единый путь через aggregate-raw (§5.5, STATUS.md).
    sample.payload = { ...sample.payload, source: "manual" };

    const outcome = await ingestSample(userId, sample);
    return {
      ok: true,
      metric: sample.metric,
      recorded_at: sample.recordedAt.toISOString(),
      outcome: outcome.reason,
    };
  },
});
