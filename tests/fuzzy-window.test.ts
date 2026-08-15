// @ts-check
/**
 * Юнит-тесты fuzzy-окна (§9; PHASE-4 §5.1, DoD §7): парсинг HH:MM, локальные
 * минуты/день недели, круговое сравнение (слоты через полночь), кейс DoD
 * «слот 18:15 не теряется между тиками 18:00/19:00», DST-переходы.
 */
import { describe, expect, it } from "vitest";

import {
  circularMinutesDiff,
  localDayOfWeek,
  localMinutesOfDay,
  normalizeHHMM,
  parseHHMMToMinutes,
  shouldFireSlot,
  withinFuzzyWindow,
} from "../agent/lib/fuzzy-window";

describe("parseHHMMToMinutes / normalizeHHMM", () => {
  it("парсит HH:MM и HH:MM:SS (формат колонки time в drizzle)", () => {
    expect(parseHHMMToMinutes("08:00")).toBe(480);
    expect(parseHHMMToMinutes("08:00:00")).toBe(480);
    expect(parseHHMMToMinutes("23:45")).toBe(1425);
    expect(parseHHMMToMinutes("00:00")).toBe(0);
  });

  it("отвергает невалидные форматы → null (слот молча пропускается)", () => {
    expect(parseHHMMToMinutes("8:00")).toBeNull(); // без ведущего нуля
    expect(parseHHMMToMinutes("24:00")).toBeNull();
    expect(parseHHMMToMinutes("12:60")).toBeNull();
    expect(parseHHMMToMinutes("08:00:99")).toBeNull(); // секунды > 59 (review P2)
    expect(parseHHMMToMinutes("ab:cd")).toBeNull();
    expect(parseHHMMToMinutes("")).toBeNull();
  });

  it("валидные секунды не влияют на минуту суток (review P2)", () => {
    expect(parseHHMMToMinutes("08:00:59")).toBe(480);
    expect(parseHHMMToMinutes("23:45:30")).toBe(1425);
  });

  it("normalizeHHMM обрезает секунды и валидирует", () => {
    expect(normalizeHHMM("08:00:00")).toBe("08:00");
    expect(normalizeHHMM("23:45")).toBe("23:45");
    expect(normalizeHHMM("99:00")).toBeNull();
    expect(normalizeHHMM("08:00:99")).toBeNull(); // секунды > 59 (review P2)
  });
});

describe("localMinutesOfDay / localDayOfWeek", () => {
  it("минуты локального времени по tz", () => {
    expect(localMinutesOfDay(new Date("2026-08-15T12:00:00Z"), "UTC")).toBe(720);
    expect(localMinutesOfDay(new Date("2026-08-15T12:00:00Z"), "Europe/Moscow")).toBe(900); // 15:00 MSK
  });

  it("день недели 0=вс…6=сб в локальном времени (2026-08-15 — суббота)", () => {
    expect(localDayOfWeek(new Date("2026-08-15T12:00:00Z"), "Europe/Moscow")).toBe(6);
    // В NY ещё пятница (UTC-4): 2026-08-15T02:30Z = пт 22:30.
    expect(localDayOfWeek(new Date("2026-08-15T02:30:00Z"), "America/New_York")).toBe(5);
    expect(localDayOfWeek(new Date("2026-08-16T12:00:00Z"), "UTC")).toBe(0); // воскресенье
  });
});

describe("withinFuzzyWindow (круговое сравнение)", () => {
  it("попадание и промах в пределах суток", () => {
    expect(withinFuzzyWindow(900, 915)).toBe(true); // 18:00 vs 18:15 — diff 15
    expect(withinFuzzyWindow(900, 930)).toBe(true); // граница ровно ±30 — включительно
    expect(withinFuzzyWindow(900, 870)).toBe(true); // граница с другой стороны
    expect(withinFuzzyWindow(900, 945)).toBe(false); // diff 45
    expect(withinFuzzyWindow(900, 900)).toBe(true); // точное попадание
  });

  it("слоты через полночь: сравнение по модулю суток", () => {
    expect(withinFuzzyWindow(5, 1425)).toBe(true); // 00:05 vs 23:45 — круговая дистанция 20
    expect(withinFuzzyWindow(0, 1430)).toBe(true); // 00:00 vs 23:50 — дистанция 10
    expect(withinFuzzyWindow(60, 1420)).toBe(false); // 01:00 vs 23:40 — дистанция 80
  });

  it("circularMinutesDiff — расстояние 0..720", () => {
    expect(circularMinutesDiff(0, 0)).toBe(0);
    expect(circularMinutesDiff(720, 0)).toBe(720);
    expect(circularMinutesDiff(0, 720)).toBe(720);
    expect(circularMinutesDiff(100, 1100)).toBe(440); // |100-1100|=1000 → 1440-1000=440
  });
});

describe("shouldFireSlot — DoD-кейсы", () => {
  it("слот 18:15 срабатывает на тике 18:00 (не теряется между тиками)", () => {
    // 2026-08-15T15:00Z = 18:00 MSK.
    expect(shouldFireSlot(new Date("2026-08-15T15:00:00Z"), "Europe/Moscow", "18:15")).toBe(true);
  });

  it("на тике 19:00 (diff 45) — не срабатывает", () => {
    expect(shouldFireSlot(new Date("2026-08-15T16:00:00Z"), "Europe/Moscow", "18:15")).toBe(false);
  });

  it("разовый UTC-тик не покрывает слоты в другом tz (почему джоб почасовой, §9)", () => {
    // 07:00 UTC = 10:00 MSK — слот 08:00 MSK не в окне.
    expect(shouldFireSlot(new Date("2026-08-15T07:00:00Z"), "Europe/Moscow", "08:00")).toBe(false);
    // А на тике 05:00 UTC (08:00 MSK) — точное попадание.
    expect(shouldFireSlot(new Date("2026-08-15T05:00:00Z"), "Europe/Moscow", "08:00")).toBe(true);
  });

  it("невалидный слот — не срабатывает", () => {
    expect(shouldFireSlot(new Date("2026-08-15T05:00:00Z"), "Europe/Moscow", "bad")).toBe(false);
  });
});

describe("DST-переходы (America/New_York)", () => {
  it("spring forward 2026-03-08: час 02:xx не существует, локальное время скачет", () => {
    // 07:00Z — момент перехода: локально уже 03:00 EDT (02:00 EST → 03:00).
    expect(localMinutesOfDay(new Date("2026-03-08T07:00:00Z"), "America/New_York")).toBe(180);
    expect(localMinutesOfDay(new Date("2026-03-08T07:30:00Z"), "America/New_York")).toBe(210); // 03:30
    // Несуществующий слот 02:30 корректно покрывается окном ближайшего тика
    // (03:00 − 30 мин = граница окна, включительно).
    expect(shouldFireSlot(new Date("2026-03-08T07:00:00Z"), "America/New_York", "02:30")).toBe(true);
  });

  it("fall back 2026-11-01: 01:30 существует дважды — оба раза это 90 минут", () => {
    expect(localMinutesOfDay(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe(90); // 01:30 EDT
    expect(localMinutesOfDay(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe(90); // 01:30 EST
    expect(shouldFireSlot(new Date("2026-11-01T05:30:00Z"), "America/New_York", "01:30")).toBe(true);
    expect(shouldFireSlot(new Date("2026-11-01T06:30:00Z"), "America/New_York", "01:30")).toBe(true);
  });
});
