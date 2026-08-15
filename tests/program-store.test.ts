// @ts-check
/**
 * Юнит-тесты pure-хелперов program-store (§5.5–5.6, §11.4; PHASE-5 §5.2/5.4).
 *
 * DB-обёртки (saveProgramVersion и пр.) покрыты интеграционно — см. checklist
 * в STATUS.md; здесь — только детерминированная логика слотов и масштабирования.
 */
import { describe, expect, it } from "vitest";

import {
  dayOfWeekOf,
  defaultTimesForDays,
  isFutureLocalDay,
  mergeSlots,
  moveSlotsDay,
  normalizeSlots,
  pendingOriginFromNotes,
  scaleRepsText,
  scaleSets,
} from "../agent/lib/program-store";

describe("dayOfWeekOf", () => {
  it("2026-08-15 — суббота (6); нумерация 0=вс…6=сб", () => {
    expect(dayOfWeekOf("2026-08-15")).toBe(6);
    expect(dayOfWeekOf("2026-08-09")).toBe(0); // вс
    expect(dayOfWeekOf("2026-08-10")).toBe(1); // пн
  });
  it("невалидная строка — бросает", () => {
    expect(() => dayOfWeekOf("15.08.2026")).toThrow();
    expect(() => dayOfWeekOf("2026-8-15")).toThrow();
  });
});

describe("normalizeSlots", () => {
  it("валидация, дедуп по (day_of_week, local_time), сортировка", () => {
    expect(
      normalizeSlots([
        { day_of_week: 3, local_time: "19:00" },
        { day_of_week: 1, local_time: "08:30" },
        { day_of_week: 3, local_time: "19:00" }, // дубль
      ]),
    ).toEqual([
      { day_of_week: 1, local_time: "08:30" },
      { day_of_week: 3, local_time: "19:00" },
    ]);
  });
  it("битые элементы — бросают (невалидный день/время)", () => {
    expect(() => normalizeSlots([{ day_of_week: 7, local_time: "10:00" }])).toThrow();
    expect(() => normalizeSlots([{ day_of_week: 1, local_time: "24:00" }])).toThrow();
    expect(() => normalizeSlots([{ day_of_week: 1, local_time: "7:00" }])).toThrow();
  });
  it("не-массив → пусто", () => {
    expect(normalizeSlots(undefined)).toEqual([]);
    expect(normalizeSlots(null)).toEqual([]);
  });
});

describe("defaultTimesForDays", () => {
  it("дни программы → слоты на 18:00 (дедуп)", () => {
    expect(defaultTimesForDays([1, 3, 5])).toEqual([
      { day_of_week: 1, local_time: "18:00" },
      { day_of_week: 3, local_time: "18:00" },
      { day_of_week: 5, local_time: "18:00" },
    ]);
  });
});

describe("mergeSlots («Смешать»)", () => {
  it("объединение с удалением дублей по (day_of_week, local_time)", () => {
    expect(
      mergeSlots(
        [
          { day_of_week: 1, local_time: "08:00" },
          { day_of_week: 3, local_time: "19:00" },
        ],
        [
          { day_of_week: 3, local_time: "19:00" }, // совпадает
          { day_of_week: 5, local_time: "18:00" },
        ],
      ),
    ).toEqual([
      { day_of_week: 1, local_time: "08:00" },
      { day_of_week: 3, local_time: "19:00" },
      { day_of_week: 5, local_time: "18:00" },
    ]);
  });
});

describe("moveSlotsDay (регулярный перенос)", () => {
  it("слоты from_dow → to_dow, время сохраняется, дубли схлопываются", () => {
    expect(
      moveSlotsDay(
        [
          { day_of_week: 1, local_time: "08:00" },
          { day_of_week: 3, local_time: "19:00" },
          { day_of_week: 5, local_time: "19:00" }, // коллизия после переноса 3→5
        ],
        3,
        5,
      ),
    ).toEqual([
      { day_of_week: 1, local_time: "08:00" },
      { day_of_week: 5, local_time: "19:00" },
    ]);
  });
  it("слотов под from_dow не было → [] (вызывающий не трогает workout_times)", () => {
    expect(moveSlotsDay([{ day_of_week: 2, local_time: "07:00" }], 4, 5)).toEqual([]);
  });
});

describe("scaleSets / scaleRepsText (облегчение)", () => {
  it("scaleSets: округление, минимум 1, null остаётся null", () => {
    expect(scaleSets(4, 0.8)).toBe(3); // 3.2 → 3
    expect(scaleSets(3, 0.5)).toBe(2); // 1.5 → 2
    expect(scaleSets(2, 0.1)).toBe(1); // clamp
    expect(scaleSets(null, 0.8)).toBeNull();
  });

  it("scaleRepsText: диапазон '8-12' масштабируется целиком", () => {
    expect(scaleRepsText("8-12", 0.8)).toBe("6-10"); // 6.4→6, 9.6→10
    expect(scaleRepsText("10–15", 1.2)).toBe("12-18"); // en-dash тоже
    expect(scaleRepsText("8 - 12", 1)).toBe("8-12");
  });

  it("scaleRepsText: '30s'/'15 reps' — ведущее число с суффиксом", () => {
    expect(scaleRepsText("30s", 0.5)).toBe("15s");
    expect(scaleRepsText("12 reps", 0.75)).toBe("9 reps");
  });

  it("scaleRepsText: текст без чисел и null — без изменений", () => {
    expect(scaleRepsText("до отказа", 0.5)).toBe("до отказа");
    expect(scaleRepsText(null, 0.5)).toBeNull();
    expect(scaleRepsText("", 0.5)).toBeNull();
  });
});

describe("pendingOriginFromNotes / isFutureLocalDay (review P2)", () => {
  it("исходная дата достаётся из notes pending-строки (включая суффикс-примечание)", () => {
    expect(pendingOriginFromNotes("перенос с 2026-08-14")).toBe("2026-08-14");
    expect(pendingOriginFromNotes("перенос с 2026-08-14: заболел")).toBe("2026-08-14");
    expect(pendingOriginFromNotes("перенос с 2026-08")).toBeNull(); // неполная дата
    expect(pendingOriginFromNotes("перенесено на 2026-08-18")).toBeNull(); // чужой формат
    expect(pendingOriginFromNotes(null)).toBeNull();
  });

  it("isFutureLocalDay: строго позже сегодня (лексикографическое сравнение ISO)", () => {
    expect(isFutureLocalDay("2026-08-16", "2026-08-15")).toBe(true);
    expect(isFutureLocalDay("2026-08-15", "2026-08-15")).toBe(false); // сегодня — можно
    expect(isFutureLocalDay("2026-08-14", "2026-08-15")).toBe(false);
  });
});
