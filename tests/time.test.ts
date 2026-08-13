// @ts-check
/**
 * Юнит-тесты time.ts: локальный день ↔ UTC, DST-переходы, сон через полночь
 * (§12.1, §18.1, PHASE-0 §7/§8).
 *
 * Все проверки — на абсолютных UTC-моментах и календарных днях, результат не
 * зависит от tz машины, на которой гоняются тесты.
 */
import { describe, expect, it } from "vitest";

import {
  isValidTimezone,
  localDay,
  localDayRangeUtc,
  sleepWakeDay,
} from "../agent/lib/time";

describe("localDay", () => {
  it("Europe/Moscow (UTC+3): 20:00Z → 23:00 MSK того же дня", () => {
    expect(localDay(new Date("2026-03-15T20:00:00Z"), "Europe/Moscow")).toBe("2026-03-15");
  });

  it("Europe/Moscow: после 21:00Z дата переваливает на следующий день", () => {
    // 21:00Z = 00:00 MSK следующего дня
    expect(localDay(new Date("2026-03-15T21:00:00Z"), "Europe/Moscow")).toBe("2026-03-16");
  });

  it("Asia/Novosibirsk (UTC+7): 18:00Z → 01:00 следующего дня", () => {
    expect(localDay(new Date("2026-06-10T18:00:00Z"), "Asia/Novosibirsk")).toBe("2026-06-11");
  });
});

describe("localDayRangeUtc", () => {
  it("Europe/Moscow: обычный день ровно 24 часа (Russia без DST)", () => {
    const { start, end } = localDayRangeUtc("2026-03-08", "Europe/Moscow");
    // 00:00 MSK Mar 8 = 21:00Z Mar 7; 00:00 MSK Mar 9 = 21:00Z Mar 8
    expect(start.toISOString()).toBe("2026-03-07T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-08T21:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * 3600_000);
  });

  it("America/New_York: spring forward (Mar 8 2026) → день 23 часа", () => {
    const { start, end } = localDayRangeUtc("2026-03-08", "America/New_York");
    // 00:00 EST = 05:00Z Mar 8; 00:00 EDT (после перевода) = 04:00Z Mar 9
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * 3600_000);
  });

  it("America/New_York: fall back (Nov 1 2026) → день 25 часов", () => {
    const { start, end } = localDayRangeUtc("2026-11-01", "America/New_York");
    // 00:00 EDT = 04:00Z Nov 1; 00:00 EST (после перевода) = 05:00Z Nov 2
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * 3600_000);
  });

  it("бросает на невалидном формате дня", () => {
    expect(() => localDayRangeUtc("2026-3-8", "Europe/Moscow")).toThrow();
    expect(() => localDayRangeUtc("not-a-date", "Europe/Moscow")).toThrow();
  });
});

describe("sleepWakeDay", () => {
  it("сон через полночь относится к дате пробуждения (§12.1)", () => {
    // Лёг 23:30 MSK Mar 14 (20:30Z), встал 07:00 MSK Mar 15 (04:00Z Mar 15)
    const sleepStart = new Date("2026-03-14T20:30:00Z");
    const sleepEnd = new Date("2026-03-15T04:00:00Z");
    expect(sleepWakeDay(sleepStart, sleepEnd, "Europe/Moscow")).toBe("2026-03-15");
  });

  it("сон в пределах одного дня — дата пробуждения этого же дня", () => {
    const sleepStart = new Date("2026-03-15T22:00:00Z"); // 01:00 MSK Mar 16
    const sleepEnd = new Date("2026-03-16T05:00:00Z"); // 08:00 MSK Mar 16
    expect(sleepWakeDay(sleepStart, sleepEnd, "Europe/Moscow")).toBe("2026-03-16");
  });
});

describe("isValidTimezone", () => {
  it("принимает IANA-имена", () => {
    expect(isValidTimezone("Europe/Moscow")).toBe(true);
    expect(isValidTimezone("Asia/Yekaterinburg")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
  });

  it("отвергает мусор", () => {
    expect(isValidTimezone("Moscow")).toBe(false);
    expect(isValidTimezone("Fake/Zone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
