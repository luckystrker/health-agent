// @ts-check
/**
 * Юнит-тесты dedup.ts: стабильная сериализация + payload-hash (§12.4, §18.1).
 * ingestSample (с БД) покрывается интеграционно (mock-forwarder + dev-БД, §18.2).
 */
import { describe, expect, it } from "vitest";

import { payloadHash, stableStringify } from "../agent/lib/dedup";

describe("stableStringify", () => {
  it("не зависит от порядка ключей", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("сортирует вложенные ключи", () => {
    expect(stableStringify({ outer: { z: 1, a: 2 } })).toBe(
      stableStringify({ outer: { a: 2, z: 1 } }),
    );
  });

  it("разный контент → разная строка", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it("массивы — порядок элементов важен", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe("payloadHash", () => {
  it("детерминирован (один payload → один хэш)", () => {
    const p = { steps: 1200, bucket: "2026-03-15 18:00" };
    expect(payloadHash(p)).toBe(payloadHash({ ...p }));
  });

  it("не зависит от порядка ключей", () => {
    expect(payloadHash({ a: 1, b: { x: 1, y: 2 } })).toBe(
      payloadHash({ b: { y: 2, x: 1 }, a: 1 }),
    );
  });

  it("разный payload → разный хэш (retry-dup detection)", () => {
    // sleep: уточнённые границы дают другой payload → другой хэш (upsert, не skip)
    const v1 = { bed_at: "2026-03-14T20:30:00Z", wake_at: "2026-03-15T04:00:00Z" };
    const v2 = { bed_at: "2026-03-14T20:45:00Z", wake_at: "2026-03-15T04:00:00Z" };
    expect(payloadHash(v1)).not.toBe(payloadHash(v2));
  });

  it("точный дубль → тот же хэш (retry skip)", () => {
    const v = { bed_at: "2026-03-14T20:30:00Z", wake_at: "2026-03-15T04:00:00Z" };
    expect(payloadHash(v)).toBe(payloadHash(JSON.parse(JSON.stringify(v))));
  });

  it("возвращает 64 hex-символа", () => {
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
