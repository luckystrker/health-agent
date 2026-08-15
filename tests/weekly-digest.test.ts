// @ts-check
/**
 * Юнит-тесты weekly-digest.ts (фаза 3, §18.1): завершённые локальные дни,
 * суммаризаторы (средние только по дням с данными), тренд сна vs предыдущая
 * неделя, дельта веса, порог полноты N=4, тренд-строки user-context и
 * digest-блок промпта. Pure-функции — без БД; периоды строятся вручную.
 */
import { describe, expect, it } from "vitest";

import type { AggregateMetric, DailyValue } from "../agent/lib/aggregates";
import type { PeriodResult } from "../agent/lib/daily-read";
import type { FoodDaySummary } from "../agent/lib/food-read";
import {
  MIN_DAYS_FOR_FULL_REPORT,
  buildDigestTrendLines,
  completedDaysList,
  countDaysWithData,
  digestPromptBlock,
  minutesToHoursStr,
  summarizeFood,
  summarizeSleep,
  summarizeSteps,
  summarizeWeight,
  summarizeWorkouts,
  type WeekDigest,
} from "../agent/lib/weekly-digest";

// ───────────────────────────── helpers ─────────────────────────────

function buildPeriod(
  entries: Record<string, Partial<Record<AggregateMetric, DailyValue>>>,
): PeriodResult {
  const map: PeriodResult = new Map();
  for (const [day, metrics] of Object.entries(entries)) {
    const m = new Map<AggregateMetric, { day: string; value: DailyValue; source: "aggregate" }>();
    for (const [metric, value] of Object.entries(metrics) as [AggregateMetric, DailyValue][]) {
      m.set(metric, { day, value, source: "aggregate" });
    }
    map.set(day, m);
  }
  return map;
}

function foodDay(kcal: number, entries: number, p = 100, f = 50, c = 200): FoodDaySummary {
  return {
    day: "",
    entries: Array.from({ length: entries }, () => ({
      consumed_at: "2026-08-10T09:00:00.000Z",
      description: "x",
      kcal: kcal / Math.max(entries, 1),
      protein_g: p / Math.max(entries, 1),
      fat_g: f / Math.max(entries, 1),
      carbs_g: c / Math.max(entries, 1),
      source: "fatsecret",
    })),
    totals: { kcal, protein_g: p, fat_g: f, carbs_g: c },
  };
}

const DAYS7 = [
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
  "2026-08-08",
  "2026-08-09",
  "2026-08-10",
];
const PREV7 = [
  "2026-07-28",
  "2026-07-29",
  "2026-07-30",
  "2026-07-31",
  "2026-08-01",
  "2026-08-02",
  "2026-08-03",
];

function digest(overrides: Partial<WeekDigest> = {}): WeekDigest {
  return {
    tz: "Europe/Moscow",
    today: "2026-08-11",
    days: DAYS7,
    daysWithData: 7,
    incomplete: false,
    sleep: { perDay: [], avgMinutes: 430, prevAvgMinutes: 400, trendMinutes: 30 },
    steps: { perDay: [], avg: 8100 },
    workouts: { perDay: [], total: { count: 2, minutes: 95 } },
    food: { perDay: [], daysLogged: 5, avgKcal: 1950, avgProteinG: 100, avgFatG: 60, avgCarbsG: 210 },
    kcalTarget: 2000,
    factorSource: "computed",
    weight: { points: [{ day: "2026-08-05", kg: 78.5 }, { day: "2026-08-10", kg: 78.0 }], deltaKg: -0.5 },
    goal: { kind: "weight_loss", targetWeightKg: 72, tempoKgPerWeek: 0.5, targetDate: null },
    ...overrides,
  };
}

// ───────────────────────── completedDaysList ─────────────────────────

describe("completedDaysList", () => {
  it("Europe/Moscow: вчера и старше, сегодня не входит", () => {
    // 11 августа 12:00 MSK (09:00Z) → завершённые дни 04..10 августа
    const days = completedDaysList("Europe/Moscow", 7, new Date("2026-08-11T09:00:00Z"));
    expect(days).toEqual(DAYS7);
  });

  it("отрицательный offset: локальная дата может быть меньше UTC", () => {
    // 2026-08-11T02:00Z = 2026-08-10 22:00 в Нью-Йорке (EDT, UTC−4) →
    // локальный день 10.08, «вчера» = 09.08; завершённые дни 07..09 августа
    const days = completedDaysList("America/New_York", 3, new Date("2026-08-11T02:00:00Z"));
    expect(days).toEqual(["2026-08-07", "2026-08-08", "2026-08-09"]);
  });

  it("положительный offset: локальная дата больше UTC", () => {
    // 2026-08-10T20:00Z = 2026-08-11 03:00 во Владивостоке → «вчера» = 10.08
    const days = completedDaysList("Asia/Vladivostok", 2, new Date("2026-08-10T20:00:00Z"));
    expect(days).toEqual(["2026-08-09", "2026-08-10"]);
  });
});

// ───────────────────────── summarizeSleep ─────────────────────────

describe("summarizeSleep", () => {
  it("среднее только по дням с данными + тренд vs предыдущая неделя", () => {
    const period = buildPeriod({
      "2026-08-04": { sleep: { total_minutes: 420 } },
      "2026-08-05": { sleep: { total_minutes: 440 } },
      "2026-08-07": { sleep: { total_minutes: 460 } },
      "2026-07-30": { sleep: { total_minutes: 400 } },
      "2026-08-01": { sleep: { total_minutes: 420 } },
    });
    const s = summarizeSleep(period, DAYS7, PREV7);
    // среднее текущей недели: (420+440+460)/3 = 440
    expect(s.avgMinutes).toBe(440);
    // предыдущая неделя: (400+420)/2 = 410
    expect(s.prevAvgMinutes).toBe(410);
    expect(s.trendMinutes).toBe(30);
    // дни без сна → null
    expect(s.perDay.map((d) => d.minutes)).toEqual([420, 440, null, 460, null, null, null]);
  });

  it("без данных — все null, тренда нет", () => {
    const s = summarizeSleep(buildPeriod({}), DAYS7, PREV7);
    expect(s.avgMinutes).toBeNull();
    expect(s.prevAvgMinutes).toBeNull();
    expect(s.trendMinutes).toBeNull();
  });
});

// ───────────────────────── summarizeSteps ─────────────────────────

describe("summarizeSteps", () => {
  it("среднее по дням с шагами", () => {
    const period = buildPeriod({
      "2026-08-04": { steps: { total_steps: 8000 } },
      "2026-08-05": { steps: { total_steps: 10000 } },
    });
    const s = summarizeSteps(period, DAYS7);
    expect(s.avg).toBe(9000);
    expect(s.perDay[2]?.steps).toBeNull();
  });
});

// ───────────────────────── summarizeWorkouts ─────────────────────────

describe("summarizeWorkouts", () => {
  it("суммарные счётчики и минуты по items.duration_min", () => {
    const period = buildPeriod({
      "2026-08-05": {
        workouts: {
          count: 2,
          items: [{ type: "run", duration_min: 40 }, { type: "gym", duration_min: 35 }],
        },
      },
      "2026-08-08": { workouts: { count: 1, items: [{ type: "walk", duration_min: 20 }] } },
    });
    const w = summarizeWorkouts(period, DAYS7);
    expect(w.total).toEqual({ count: 3, minutes: 95 });
    expect(w.perDay.find((d) => d.day === "2026-08-05")).toEqual({ day: "2026-08-05", count: 2, minutes: 75 });
  });
});

// ───────────────────────── summarizeFood ─────────────────────────

describe("summarizeFood", () => {
  it("дни без записей не зануляют среднее (не записывал ≠ 0 ккал)", () => {
    const food = new Map<string, FoodDaySummary>([
      ["2026-08-04", foodDay(2000, 3)],
      ["2026-08-06", foodDay(1800, 2)],
    ]);
    const f = summarizeFood(food, DAYS7);
    expect(f.daysLogged).toBe(2);
    expect(f.avgKcal).toBe(1900);
    // kcal=0 у дней без записей (для графиков), entries=0
    expect(f.perDay[1]).toMatchObject({ day: "2026-08-05", kcal: 0, entries: 0 });
  });
});

// ───────────────────────── summarizeWeight ─────────────────────────

describe("summarizeWeight", () => {
  it("дельта = последнее − первое", () => {
    const w = summarizeWeight([
      { day: "2026-08-05", kg: 78.5 },
      { day: "2026-08-08", kg: 78.2 },
      { day: "2026-08-10", kg: 78.0 },
    ]);
    expect(w.deltaKg).toBe(-0.5);
  });

  it("меньше 2 точек → дельты нет", () => {
    expect(summarizeWeight([{ day: "2026-08-05", kg: 78.5 }]).deltaKg).toBeNull();
    expect(summarizeWeight([]).deltaKg).toBeNull();
  });
});

// ───────────────────────── countDaysWithData ─────────────────────────

describe("countDaysWithData", () => {
  it("считает дни с любыми данными часов (сон/шаги/активность/тренировки)", () => {
    const period = buildPeriod({
      "2026-08-04": { sleep: { total_minutes: 400 } },
      "2026-08-05": { steps: { total_steps: 5000 } },
      "2026-08-06": { activity: { active_minutes: 30 } },
      "2026-08-07": { workouts: { count: 1 } },
      "2026-08-08": { heart_rate: { resting_bpm: 60 } }, // только HR — не считается
    });
    expect(countDaysWithData(period, DAYS7)).toBe(4);
  });
});

// ───────────────────────── форматирование ─────────────────────────

describe("minutesToHoursStr", () => {
  it("434 мин → 7.2 ч", () => {
    expect(minutesToHoursStr(434)).toBe("7.2");
  });
  it("420 мин → 7.0 ч", () => {
    expect(minutesToHoursStr(420)).toBe("7.0");
  });
});

// ───────────────────────── buildDigestTrendLines ─────────────────────────

describe("buildDigestTrendLines", () => {
  it("полный digest — все строки трендов", () => {
    const lines = buildDigestTrendLines(digest());
    expect(lines.some((l) => l.includes("сон (7 дн)") && l.includes("7.2 ч"))).toBe(true);
    expect(lines.some((l) => l.includes("+0.5 ч"))).toBe(true);
    expect(lines.some((l) => l.includes("шаги") && l.includes("8100"))).toBe(true);
    expect(lines.some((l) => l.includes("вес") && l.includes("-0.5 кг"))).toBe(true);
    expect(lines.some((l) => l.includes("калории") && l.includes("1950") && l.includes("2000"))).toBe(true);
    expect(lines.some((l) => l.includes("тренировки") && l.includes("2"))).toBe(true);
    // полная неделя — предупреждения о неполноте нет
    expect(lines.some((l) => l.includes("⚠"))).toBe(false);
  });

  it("пустой digest — только предупреждение о данных", () => {
    const lines = buildDigestTrendLines(
      digest({
        daysWithData: 0,
        incomplete: true,
        sleep: { perDay: [], avgMinutes: null, prevAvgMinutes: null, trendMinutes: null },
        steps: { perDay: [], avg: null },
        workouts: { perDay: [], total: { count: 0, minutes: 0 } },
        food: { perDay: [], daysLogged: 0, avgKcal: null, avgProteinG: null, avgFatG: null, avgCarbsG: null },
        kcalTarget: null,
        factorSource: null,
        weight: { points: [], deltaKg: null },
        goal: null,
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("0/7");
  });
});

// ───────────────────────── digestPromptBlock ─────────────────────────

describe("digestPromptBlock", () => {
  it("содержит окно, все секции и цель", () => {
    const block = digestPromptBlock(digest());
    expect(block).toContain("2026-08-04 … 2026-08-10");
    expect(block).toContain("дней с данными часов: 7/7");
    expect(block).toContain("**Сон**");
    expect(block).toContain("тренд vs предыдущая неделя: +30 мин");
    expect(block).toContain("**Вес**");
    expect(block).toContain("-0.50 кг");
    expect(block).toContain("**Калории**");
    expect(block).toContain("целевой калораж: 2000 ккал/день");
    expect(block).toContain("**Тренировки**");
    expect(block).toContain("**Цель пользователя**: weight_loss");
  });

  it("пустые секции — корректные «нет данных» без чисел", () => {
    const block = digestPromptBlock(
      digest({
        daysWithData: 0,
        incomplete: true,
        sleep: { perDay: [], avgMinutes: null, prevAvgMinutes: null, trendMinutes: null },
        steps: { perDay: [], avg: null },
        workouts: { perDay: [], total: { count: 0, minutes: 0 } },
        food: { perDay: [], daysLogged: 0, avgKcal: null, avgProteinG: null, avgFatG: null, avgCarbsG: null },
        kcalTarget: null,
        factorSource: null,
        weight: { points: [], deltaKg: null },
        goal: null,
      }),
    );
    expect(block).toContain("взвешиваний за неделю нет");
    expect(block).toContain("записей питания за неделю нет");
    expect(block).toContain("за неделю не зафиксировано");
    expect(block).toContain("не посчитан");
  });
});

// ───────────────────────── порог полноты ─────────────────────────

describe("порог полноты N=4", () => {
  it("MIN_DAYS_FOR_FULL_REPORT = 4 (§11.1)", () => {
    expect(MIN_DAYS_FOR_FULL_REPORT).toBe(4);
  });
});
