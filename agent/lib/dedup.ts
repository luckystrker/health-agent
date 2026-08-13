// @ts-check
/**
 * Дедупликация phone-hub payload по типу метрики (§12.4).
 *
 * Дедуп-ключ для ВСЕХ metric — `(user_id, metric, recorded_at)` (unique-индекс
 * `raw_samples_user_metric_recorded_idx`, миграция 0002):
 *  - `sleep_session`/`workout`: одна запись на событие; поздняя версия границ
 *    выигрывает (upsert) — `recorded_at` = wake_at / start_at уникален для события.
 *  - bucket-метрики (steps/heart_rate/active_calories): `recorded_at` = время
 *    бакета/сэмпла и уникально его идентифицирует (payload.bucket избыточен, хранится
 *    для читаемости — фиксация в STATUS.md, разрешает напряжённость §12.4).
 *
 * Реализация — один atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING`:
 * unique-индекс гарантирует единственную строку на событие/бакет (нет двойного счёта
 * при гонке ретраев forwarder'а). WHERE `payload IS DISTINCT FROM EXCLUDED.payload`
 * пропускает байт-в-байт дубли ретраев (RETURNING пуст → retry-dup, лог «dedup-hit»,
 * §15). `xmax` отличает INSERT (новое) от UPDATE (upsert).
 *
 * `payloadHash` (стабильная сериализация) возвращается для логирования/корреляции.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "./db/client";
import { rawSamples } from "./db/schema";
import type { NormalizedSample } from "./normalize";

/**
 * Стабильная JSON-строка (ключи отсортированы рекурсивно). Нужна, чтобы одинаковые
 * payload'ы давали одинаковый хэш независимо от порядка ключей.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex от стабильной сериализации payload (нормализованного). */
export function payloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export type IngestOutcome = {
  inserted: boolean;
  reason: "new" | "upsert" | "retry-dup";
  /** Короткий payload-hash (для логирования/корреляции дедуп-событий, §15). */
  hash: string;
};

/**
 * Записать сэмпл в `raw_samples` с дедупликацией (§12.4). Один atomic upsert:
 *  - точный дубль (тот же payload) → RETURNING пуст → retry-dup (skip, без churn);
 *  - изменённая версия того же события → UPDATE → upsert;
 *  - новое событие → INSERT → new.
 * Гонка безопасна: unique-индекс не даст двух строк на один (user, metric, recorded_at).
 */
export async function ingestSample(userId: string, sample: NormalizedSample): Promise<IngestOutcome> {
  const hash = payloadHash(sample.payload);

  const rows = await db
    .insert(rawSamples)
    .values({
      userId,
      metric: sample.metric,
      recordedAt: sample.recordedAt,
      payload: sample.payload,
    })
    .onConflictDoUpdate({
      target: [rawSamples.userId, rawSamples.metric, rawSamples.recordedAt],
      set: { payload: sample.payload, receivedAt: new Date() },
      // Пропустить no-op: если payload байт-в-байт тот же (точный ретрай forwarder'а) —
      // UPDATE не выполняется, RETURNING пуст.
      where: sql`${rawSamples.payload} IS DISTINCT FROM EXCLUDED.payload`,
    })
    // xmax = 0 ⟺ выполнен INSERT (новое); xmax ≠ 0 ⟺ UPDATE (upsert).
    .returning({ xmax: sql<number>`xmax` });

  if (rows.length === 0) return { inserted: false, reason: "retry-dup", hash };
  return { inserted: true, reason: Number(rows[0].xmax) === 0 ? "new" : "upsert", hash };
}

