// @ts-check
/**
 * Юнит-тесты детектора аномалий (§11.5; PHASE-4 §5.4, DoD §7): каждый порог —
 * положительный/отрицательный кейс + guard'ы (минимум измерений, время суток,
 * «нет данных — не алертим»), оркестратор detectAnomalies, блок фактов.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  ANOMALY_TITLES,
  anomaliesPromptBlock,
  checkCaloriesOver,
  checkSleep,
  checkStepsLow,
  checkWeightJump,
  deriveWeightInput,
  detectAnomalies,
  isLateBedtime,
  type AnomalyInputs,
  type WeightRow,
} from "../agent/lib/anomalies";
import { clearSentKeysForTests } from "../agent/lib/alert-dedup";

beforeEach(() => clearSentKeysForTests());

// ── Сон ──────────────────────────────────────────────────────────────────────

describe("checkSleep: длительность < 5ч", () => {
  it("299 мин — алерт; 300 мин (ровно порог) — нет (строго <)", () => {
    expect(checkSleep({ totalMinutes: 299, bedtimeLocal: "23:00", wakeLocal: "04:00" }).map((a) => a.type)).toEqual([
      "sleep_duration",
    ]);
    expect(checkSleep({ totalMinutes: 300, bedtimeLocal: "23:00", wakeLocal: "05:00" })).toEqual([]);
  });

  it("нет данных (null) — не алертим (§12.2)", () => {
    expect(checkSleep(null)).toEqual([]);
  });
});

describe("isLateBedtime / checkSleep: отбой позже 02:00", () => {
  it("после полуночи: 02:10 — поздно; 01:50 и ровно 02:00 — нет", () => {
    expect(isLateBedtime("02:10")).toBe(true);
    expect(isLateBedtime("01:50")).toBe(false);
    expect(isLateBedtime("02:00")).toBe(false); // строго >
  });

  it("вечерний отбой — НЕ поздний (23:30 нормально); дневной (13:00) — не алертим", () => {
    expect(isLateBedtime("23:30")).toBe(false);
    expect(isLateBedtime("22:10")).toBe(false);
    expect(isLateBedtime("13:00")).toBe(false);
  });

  it("длительность нормальная, но отбой 02:30 — только bedtime-алерт", () => {
    const fired = checkSleep({ totalMinutes: 420, bedtimeLocal: "02:30", wakeLocal: "09:30" });
    expect(fired.map((a) => a.type)).toEqual(["sleep_bedtime"]);
  });

  it("мало сна И поздний отбой — оба алерта (250 мин сна, лёг в 03:00)", () => {
    const fired = checkSleep({ totalMinutes: 250, bedtimeLocal: "03:00", wakeLocal: "07:10" });
    expect(fired.map((a) => a.type)).toEqual(["sleep_duration", "sleep_bedtime"]);
  });
});

// ── Калории ──────────────────────────────────────────────────────────────────

describe("checkCaloriesOver: > 125% цели и день не окончен", () => {
  it("2650 из 2000 (порог 2500) — алерт; ровно 2500 — нет (строго >)", () => {
    expect(checkCaloriesOver(2650, 2000, false)?.type).toBe("calories_over");
    expect(checkCaloriesOver(2500, 2000, false)).toBeNull();
    expect(checkCaloriesOver(2400, 2000, false)).toBeNull();
  });

  it("guard: день окончен — не алертим", () => {
    expect(checkCaloriesOver(2650, 2000, true)).toBeNull();
  });

  it("нет записей еды / цель не посчитана — не алертим", () => {
    expect(checkCaloriesOver(null, 2000, false)).toBeNull();
    expect(checkCaloriesOver(2650, null, false)).toBeNull();
    expect(checkCaloriesOver(2650, 0, false)).toBeNull();
  });
});

// ── Активность ───────────────────────────────────────────────────────────────

describe("checkStepsLow: < 50% медианы 7 завершённых дней, после 18:00", () => {
  it("2000 vs медиана 8000 (порог 4000) в 19:00 — алерт", () => {
    expect(checkStepsLow(2000, 8000, 5, 19 * 60)?.type).toBe("steps_low");
  });

  it("ровно 50% медианы — нет (строго <); больше — нет", () => {
    expect(checkStepsLow(4000, 8000, 5, 19 * 60)).toBeNull();
    expect(checkStepsLow(4500, 8000, 5, 19 * 60)).toBeNull();
  });

  it("guard времени: до 18:00 — нет; ровно 18:00 — да (день в основном прожит)", () => {
    expect(checkStepsLow(2000, 8000, 5, 17 * 60 + 59)).toBeNull();
    expect(checkStepsLow(2000, 8000, 5, 18 * 60)?.type).toBe("steps_low");
  });

  it("guard базовой линии: < 3 дней с данными — нет", () => {
    expect(checkStepsLow(2000, 8000, 2, 19 * 60)).toBeNull();
    expect(checkStepsLow(2000, 8000, 3, 19 * 60)?.type).toBe("steps_low");
  });

  it("нет данных сегодня / нет медианы — не алертим", () => {
    expect(checkStepsLow(null, 8000, 5, 19 * 60)).toBeNull();
    expect(checkStepsLow(2000, null, 5, 19 * 60)).toBeNull();
    expect(checkStepsLow(2000, 0, 5, 19 * 60)).toBeNull();
  });
});

// ── Вес ──────────────────────────────────────────────────────────────────────

describe("checkWeightJump: ±2.5% или ±1 кг vs медиана предыдущих", () => {
  it("+1.5 кг (80.4 vs 78.9) — алерт по абсолютному порогу", () => {
    const a = checkWeightJump({ weightNowKg: 80.4, prevMedianKg: 78.9 });
    expect(a?.type).toBe("weight_jump");
    expect(a?.facts.some((f) => f.includes("информационно"))).toBe(true);
  });

  it("малый вес: +0.9 кг при 30 кг — алерт по относительному порогу (3%)", () => {
    expect(checkWeightJump({ weightNowKg: 30.9, prevMedianKg: 30.0 })?.type).toBe("weight_jump");
  });

  it("+0.1 кг (79.0 vs 78.9) — норма, без алерта", () => {
    expect(checkWeightJump({ weightNowKg: 79.0, prevMedianKg: 78.9 })).toBeNull();
  });

  it("−1.5 кг — тоже алерт (модуль)", () => {
    expect(checkWeightJump({ weightNowKg: 77.4, prevMedianKg: 78.9 })?.type).toBe("weight_jump");
  });

  it("нет свежего взвешивания / битая медиана — не алертим", () => {
    expect(checkWeightJump(null)).toBeNull();
    expect(checkWeightJump({ weightNowKg: 80, prevMedianKg: 0 })).toBeNull();
  });
});

describe("deriveWeightInput: свежесть по ЛОКАЛЬНОМУ дню + guard на базис (review P1)", () => {
  const TZ = "Europe/Moscow";
  const TODAY = "2026-08-15";
  // 05:00 UTC = 08:00 MSK.
  const today08 = new Date("2026-08-15T05:00:00Z");
  // Вчерашний вечер: 2026-08-14T20:00Z = 23:00 MSK 14-го (по абсолютному времени 19ч назад
  // при now=15T15:00Z, но локальный день — «вчера»).
  const yesterday23 = new Date("2026-08-14T20:00:00Z");
  // Позавчера — несвежее даже при богатом базисе.
  const twoDaysAgo = new Date("2026-08-13T05:00:00Z");

  function rows(w0At: Date, prev: number[]): WeightRow[] {
    // prev — базис (кг), каждый на день старше предыдущего.
    return [
      { weightKg: 80.4, measuredAt: w0At },
      ...prev.map((kg, i) => ({ weightKg: kg, measuredAt: new Date(twoDaysAgo.getTime() - i * 86_400_000) })),
    ];
  }

  it("вчерашнее взвешивание свежее по локальному дню (абсолютные 24ч не нужны)", () => {
    // now = 15T15:00Z; вчера 23:00 MSK — это 19ч назад (свежо и абсолютно),
    // а вот 08:00 MSK вчера было бы 31ч — тоже должно считаться «вчера».
    const morningYesterday = new Date("2026-08-14T05:00:00Z"); // 08:00 MSK 14-го, >24ч назад
    const input = deriveWeightInput(rows(morningYesterday, [78.9, 79.1, 78.8]), TZ, TODAY);
    expect(input).toEqual({ weightNowKg: 80.4, prevMedianKg: 78.9 });
  });

  it("сегодняшнее и вчерашнее-вечером взвешивания — свежие; позавчера — нет", () => {
    expect(deriveWeightInput(rows(today08, [78.9, 79.1, 78.8]), TZ, TODAY)).toEqual({
      weightNowKg: 80.4,
      prevMedianKg: 78.9,
    });
    expect(deriveWeightInput(rows(yesterday23, [78.9, 79.1, 78.8]), TZ, TODAY)).toEqual({
      weightNowKg: 80.4,
      prevMedianKg: 78.9,
    });
    expect(deriveWeightInput(rows(twoDaysAgo, [78.9, 79.1, 78.8]), TZ, TODAY)).toBeNull();
  });

  it("guard «минимум 3» — на БАЗИСЕ медианы: 3 строк total (w0 + 2) → null", () => {
    expect(deriveWeightInput(rows(today08, [78.9, 79.1]), TZ, TODAY)).toBeNull();
    expect(deriveWeightInput(rows(today08, [78.9, 79.1, 78.8]), TZ, TODAY)).not.toBeNull();
  });

  it("пустой список — null", () => {
    expect(deriveWeightInput([], TZ, TODAY)).toBeNull();
  });

  it("интеграция: deriveWeightInput → checkWeightJump", () => {
    const input = deriveWeightInput(rows(today08, [78.9, 79.1, 78.8]), TZ, TODAY);
    expect(checkWeightJump(input)?.type).toBe("weight_jump");
  });
});

// ── Оркестратор ──────────────────────────────────────────────────────────────

function inputs(over: Partial<AnomalyInputs> = {}): AnomalyInputs {
  return {
    tz: "Europe/Moscow",
    localDate: "2026-08-15",
    localMinutes: 19 * 60,
    dayEnded: false,
    sleep: { totalMinutes: 430, bedtimeLocal: "23:30", wakeLocal: "06:40" },
    kcalToday: 1800,
    kcalTarget: 2000,
    stepsToday: 6000,
    stepsMedian7: 8000,
    stepsBaselineDays: 6,
    weight: null,
    ...over,
  };
}

describe("detectAnomalies", () => {
  it("нормальный день — пусто", () => {
    expect(detectAnomalies(inputs())).toEqual([]);
  });

  it("полный шторм: 4 порога одновременно (сон-длительность, калории, шаги, вес)", () => {
    const fired = detectAnomalies(
      inputs({
        sleep: { totalMinutes: 250, bedtimeLocal: "03:00", wakeLocal: "07:10" },
        kcalToday: 2600,
        stepsToday: 2000,
        weight: { weightNowKg: 80.4, prevMedianKg: 78.9 },
      }),
    ).map((a) => a.type);
    expect(fired).toEqual([
      "sleep_duration",
      "sleep_bedtime",
      "calories_over",
      "steps_low",
      "weight_jump",
    ]);
  });

  it("нет данных вообще — пусто, не падает, не спамит «нет данных»", () => {
    expect(
      detectAnomalies(
        inputs({
          sleep: null,
          kcalToday: null,
          kcalTarget: null,
          stepsToday: null,
          stepsMedian7: null,
          stepsBaselineDays: 0,
          weight: null,
        }),
      ),
    ).toEqual([]);
  });
});

describe("anomaliesPromptBlock", () => {
  it("заголовки типов + факт-строки с числами", () => {
    const fired = detectAnomalies(inputs({ kcalToday: 2600 }));
    const block = anomaliesPromptBlock(fired);
    expect(block).toContain(ANOMALY_TITLES.calories_over);
    expect(block).toContain("съедено сегодня: 2600 ккал");
    expect(block).toContain("целевой калораж: 2000 ккал/день");
    expect(block).toContain("125% цели");
  });
});
