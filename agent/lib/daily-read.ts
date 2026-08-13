// @ts-check
/**
 * Чтение данных за период из `daily_aggregates` с фолбэком на `raw_samples` (§8, §12.3).
 *
 * `daily_aggregates` содержит завершённые дни (до вчерашнего); текущий день там
 * отсутствует (он ещё идёт). Поэтому для интерактивных tool'ов недостающие
 * (день, metric) вычисляются on-the-fly из сырых сэмплов через `aggregateForDay`.
 *
 * Возврат: Map<day, Map<metric, { value, source }>>. `source`:
 *  - "aggregate" — из daily_aggregates;
 *  - "raw"       — вычислено из raw_samples (текущий/недавний день);
 *  - "none"      — данных нет.
 *
 * Дата-сравнение намеренно без bound'а по дате (агрегаты малы на пользователя и
 * хранятся как calendar DATE); фильтрация по запрошенным дням — в JS, чтобы избежать
 * хрупкого date-сравнения в SQL.
 */
import { and, eq, inArray, lt, gte } from "drizzle-orm";

import { db } from "./db/client";
import { dailyAggregates, rawSamples } from "./db/schema";
import {
  aggregateForDay,
  aggregateMetricName,
  computeLocalDayForMetric,
  type AggregateMetric,
  type DailyValue,
  type RawMetric,
  type RawSample,
} from "./aggregates";
import { localDayRangeUtc } from "./time";

export interface PeriodValue {
  day: string;
  value: DailyValue;
  source: "aggregate" | "raw" | "none";
}

/** Убрать ключи со значением undefined — чистый JSON для вывода инструментом. */
export function cleanValue(value: DailyValue): DailyValue {
  const out: DailyValue = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Комбинированный источник данных по нескольким метрикам одного дня
 * (для get-activity, где шаги/калории/пульс могут приходить из разных мест):
 * aggregate > raw > none. Берём старший по приоритету среди присутствующих.
 */
export function combinedSource(sources: PeriodValue["source"][]): PeriodValue["source"] {
  if (sources.includes("aggregate")) return "aggregate";
  if (sources.includes("raw")) return "raw";
  return "none";
}

export type PeriodResult = Map<string, Map<AggregateMetric, PeriodValue>>;

/** Последние `days` локальных дней включая сегодня (самый свежий — последним). */
export function recentDays(today: string, days: number): string[] {
  const list: string[] = [];
  const t = new Date(today + "T00:00:00Z").getTime();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(t - i * 86_400_000);
    list.push(d.toISOString().slice(0, 10));
  }
  return list;
}

/**
 * Прочитать значения `metrics` за `dayList` (локальные дни, ISO-строки).
 * Prefers daily_aggregates; для отсутствующих (день,metric) агрегирует raw on-the-fly.
 */
export async function readPeriod(
  userId: string,
  tz: string,
  dayList: string[],
  metrics: AggregateMetric[],
): Promise<PeriodResult> {
  const result: PeriodResult = new Map();
  for (const day of dayList) {
    const m = new Map<AggregateMetric, PeriodValue>();
    for (const met of metrics) m.set(met, { day, value: {}, source: "none" });
    result.set(day, m);
  }
  if (dayList.length === 0) return result;

  // 1) Готовые агрегаты (prefers).
  const aggRows = await db
    .select()
    .from(dailyAggregates)
    .where(
      and(eq(dailyAggregates.userId, userId), inArray(dailyAggregates.metric, metrics)),
    );
  const wanted = new Set(dayList);
  for (const a of aggRows) {
    const dayStr = a.day.toISOString().slice(0, 10);
    if (!wanted.has(dayStr)) continue;
    const met = a.metric as AggregateMetric;
    if (!metrics.includes(met)) continue;
    result.get(dayStr)!.set(met, { day: dayStr, value: a.value as DailyValue, source: "aggregate" });
  }

  // 2) Недостающие — из raw (текущий день / пробелы). Один запрос за весь диапазон.
  const hasMissing = [...result.values()].some((m) => [...m.values()].some((v) => v.source === "none"));
  if (hasMissing) {
    const start = localDayRangeUtc(dayList[0], tz).start;
    const lastDay = dayList[dayList.length - 1];
    const end = localDayRangeUtc(lastDay, tz).end;
    const raw = await db
      .select()
      .from(rawSamples)
      .where(
        and(
          eq(rawSamples.userId, userId),
          gte(rawSamples.recordedAt, start),
          lt(rawSamples.recordedAt, end),
        ),
      );

    // Группировка по (локальный день, raw metric).
    const buckets = new Map<string, Map<string, RawSample[]>>();
    for (const r of raw) {
      const aggMet = aggregateMetricName(r.metric);
      if (!aggMet || !metrics.includes(aggMet)) continue;
      const dayStr = computeLocalDayForMetric(r.metric, r.recordedAt, r.payload as Record<string, unknown>, tz);
      if (!wanted.has(dayStr)) continue;
      let dm = buckets.get(dayStr);
      if (!dm) {
        dm = new Map();
        buckets.set(dayStr, dm);
      }
      let arr = dm.get(r.metric);
      if (!arr) {
        arr = [];
        dm.set(r.metric, arr);
      }
      arr.push({ recordedAt: r.recordedAt, payload: r.payload as Record<string, unknown> });
    }

    for (const [day, dm] of buckets) {
      for (const [rawMetric, arr] of dm) {
        const met = aggregateMetricName(rawMetric)!;
        const cur = result.get(day)!.get(met);
        if (cur && cur.source === "none") {
          result
            .get(day)!
            .set(met, { day, value: aggregateForDay(rawMetric as RawMetric, arr, tz), source: "raw" });
        }
      }
    }
  }

  return result;
}
