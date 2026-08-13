// @ts-check
/**
 * Юнит-тесты normalize.ts: канонические схемы + recorded_at + вариантный маппинг (§6.1, §20.1, §18.1).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  PayloadError,
  clearVariantMappers,
  normalizeInbound,
  registerVariantMapper,
} from "../agent/lib/normalize";

afterEach(() => clearVariantMappers());

const sleepBody = {
  platform: "android",
  metric: "sleep_session",
  payload: {
    bed_at: "2026-03-14T20:30:00Z", // 23:30 MSK
    wake_at: "2026-03-15T04:00:00Z", // 07:00 MSK
    deep_min: 90,
    source: "amazfit",
  },
};

describe("normalizeInbound — sleep_session", () => {
  it("recorded_at = wake_at (дата пробуждения, §12.1)", () => {
    const s = normalizeInbound(sleepBody);
    expect(s.metric).toBe("sleep_session");
    expect(s.recordedAt.toISOString()).toBe("2026-03-15T04:00:00.000Z");
    expect(s.payload.bed_at).toBe("2026-03-14T20:30:00.000Z");
    expect(s.payload.wake_at).toBe("2026-03-15T04:00:00.000Z");
    expect(s.payload.deep_min).toBe(90);
  });

  it("wake_at раньше bed_at → PayloadError", () => {
    expect(() =>
      normalizeInbound({
        platform: "android",
        metric: "sleep_session",
        payload: { bed_at: "2026-03-15T04:00:00Z", wake_at: "2026-03-14T20:30:00Z" },
      }),
    ).toThrow(PayloadError);
  });
});

describe("normalizeInbound — bucket-метрики требуют recorded_at", () => {
  it("steps: recorded_at из тела", () => {
    const s = normalizeInbound({
      platform: "android",
      metric: "steps",
      recordedAt: "2026-03-15T18:00:00Z",
      payload: { steps: 1200 },
    });
    expect(s.recordedAt.toISOString()).toBe("2026-03-15T18:00:00.000Z");
    expect(s.payload.steps).toBe(1200);
  });

  it("steps без recorded_at → PayloadError", () => {
    expect(() =>
      normalizeInbound({ platform: "android", metric: "steps", payload: { steps: 1 } }),
    ).toThrow(PayloadError);
  });

  it("heart_rate: recorded_at обязателен", () => {
    const s = normalizeInbound({
      platform: "ios",
      metric: "heart_rate",
      recordedAt: "2026-03-15T18:00:00Z",
      payload: { bpm: 60, kind: "resting" },
    });
    expect(s.payload.bpm).toBe(60);
  });

  it("active_calories: recorded_at обязателен", () => {
    const s = normalizeInbound({
      platform: "android",
      metric: "active_calories",
      recordedAt: "2026-03-15T18:00:00Z",
      payload: { active_kcal: 250, total_kcal: 2600 },
    });
    expect(s.payload.active_kcal).toBe(250);
  });
});

describe("normalizeInbound — workout", () => {
  it("recorded_at = start_at", () => {
    const s = normalizeInbound({
      platform: "android",
      metric: "workout",
      payload: {
        type: "running",
        start_at: "2026-03-15T17:00:00Z",
        duration_min: 45,
        calories_kcal: 400,
      },
    });
    expect(s.recordedAt.toISOString()).toBe("2026-03-15T17:00:00.000Z");
    expect(s.payload.type).toBe("running");
    expect(s.payload.duration_min).toBe(45);
  });
});

describe("normalizeInbound — форматы timestamp", () => {
  it("ISO с offset принимается", () => {
    const s = normalizeInbound({
      platform: "android",
      metric: "steps",
      recordedAt: "2026-03-15T18:00:00+03:00",
      payload: { steps: 1 },
    });
    expect(s.recordedAt.toISOString()).toBe("2026-03-15T15:00:00.000Z");
  });

  it("epoch ms принимается", () => {
    const s = normalizeInbound({
      platform: "android",
      metric: "steps",
      recordedAt: 1773573600000, // 2026-03-13T... 
      payload: { steps: 1 },
    });
    expect(s.recordedAt.getTime()).toBe(1773573600000);
  });

  it("ISO БЕЗ offset/Z → PayloadError (защита от local-парсинга)", () => {
    expect(() =>
      normalizeInbound({
        platform: "android",
        metric: "steps",
        recordedAt: "2026-03-15T18:00:00",
        payload: { steps: 1 },
      }),
    ).toThrow(PayloadError);
  });
});

describe("normalizeInbound — ошибки", () => {
  it("неизвестный metric → PayloadError", () => {
    expect(() =>
      normalizeInbound({ platform: "android", metric: "glucose", payload: {} }),
    ).toThrow(PayloadError);
  });

  it("payload не объект → PayloadError", () => {
    expect(() =>
      normalizeInbound({ platform: "android", metric: "steps", payload: "x" }),
    ).toThrow(PayloadError);
  });
});

describe("variant mapping (§20.1)", () => {
  it("маппер переводит родные поля forwarder'а в канонические", () => {
    registerVariantMapper("android", "sleep_session", (r) => ({
      bed_at: r.startTime,
      wake_at: r.endTime,
      deep_min: r.deep,
    }));
    const s = normalizeInbound({
      platform: "android",
      metric: "sleep_session",
      payload: { startTime: "2026-03-14T20:30:00Z", endTime: "2026-03-15T04:00:00Z", deep: 80 },
    });
    expect(s.payload.bed_at).toBe("2026-03-14T20:30:00.000Z");
    expect(s.payload.deep_min).toBe(80);
  });

  it("без маппера — identity (канонические поля напрямую)", () => {
    const s = normalizeInbound(sleepBody);
    expect(s.payload.bed_at).toBe("2026-03-14T20:30:00.000Z");
  });
});
