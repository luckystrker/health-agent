// @ts-check
/**
 * Юнит-тесты aggregates.ts: raw → daily для каждого metric (§5.3, §12.1, §18.1, PHASE-1 §7).
 *
 * На абсолютных UTC-моментах; результат не зависит от tz машины. Сон через полночь —
 * к дате пробуждения; DST не ломает длительность (считаем по абсолютным ts).
 */
import { describe, expect, it } from "vitest";

import {
  aggregateActivity,
  aggregateForDay,
  aggregateHeartRate,
  aggregateMetricName,
  aggregateSleep,
  aggregateSteps,
  aggregateWorkouts,
  computeLocalDayForMetric,
  hhmmInTz,
  type RawSample,
} from "../agent/lib/aggregates";

const MSK = "Europe/Moscow";
const NYC = "America/New_York";

function sample(recordedAt: string, payload: Record<string, unknown>): RawSample {
  return { recordedAt: new Date(recordedAt), payload };
}

describe("aggregateMetricName", () => {
  it("маппит raw → agg metric (§5.3)", () => {
    expect(aggregateMetricName("sleep_session")).toBe("sleep");
    expect(aggregateMetricName("active_calories")).toBe("activity");
    expect(aggregateMetricName("workout")).toBe("workouts");
    expect(aggregateMetricName("unknown")).toBeNull();
  });
});

describe("computeLocalDayForMetric", () => {
  it("сон → дата пробуждения (через полночь)", () => {
    const day = computeLocalDayForMetric(
      "sleep_session",
      new Date("2026-03-15T04:00:00Z"),
      { bed_at: "2026-03-14T20:30:00Z", wake_at: "2026-03-15T04:00:00Z" },
      MSK,
    );
    expect(day).toBe("2026-03-15");
  });

  it("шаги → локальный день recorded_at", () => {
    const day = computeLocalDayForMetric(
      "steps",
      new Date("2026-03-15T18:00:00Z"),
      { steps: 10 },
      MSK,
    );
    expect(day).toBe("2026-03-15");
  });
});

describe("aggregateSleep", () => {
  const night: RawSample[] = [
    sample("2026-03-15T04:00:00Z", {
      bed_at: "2026-03-14T20:30:00Z", // 23:30 MSK
      wake_at: "2026-03-15T04:00:00Z", // 07:00 MSK
      deep_min: 90,
      light_min: 200,
      rem_min: 80,
      awake_min: 20,
      source: "amazfit",
    }),
  ];

  it("длительность по абсолютным ts (через полночь, 7.5ч = 450 мин)", () => {
    const v = aggregateSleep(night, MSK);
    expect(v.total_minutes).toBe(450);
  });

  it("bedtime/wake_local — «HH:MM» в tz юзера", () => {
    const v = aggregateSleep(night, MSK);
    expect(v.bedtime_local).toBe("23:30");
    expect(v.wake_local).toBe("07:00");
  });

  it("пробрасывает стадии + source", () => {
    const v = aggregateSleep(night, MSK);
    expect(v.deep_min).toBe(90);
    expect(v.rem_min).toBe(80);
    expect(v.source).toBe("amazfit");
  });

  it("считает efficiency, если не задано: (total-awake)/total", () => {
    const v = aggregateSleep(night, MSK);
    // (450-20)/450 ≈ 95.56 → 96
    expect(v.efficiency_pct).toBe(96);
  });

  it("последняя версия границ выигрывает (upsert-семантика)", () => {
    const updated = [
      sample("2026-03-15T04:30:00Z", {
        bed_at: "2026-03-14T20:30:00Z",
        wake_at: "2026-03-15T04:30:00Z", // встал на 30 мин позже
      }),
      ...night,
    ];
    // latest wake_at = 04:30Z (первый элемент) → берётся он
    const v = aggregateSleep(updated, MSK);
    expect(v.total_minutes).toBe(480);
  });

  it("DST spring-forward не ломает длительность (NYC, ночь через перевод)", () => {
    // Лёг 23:00 EST Mar 7 (= 04:00Z Mar 8), встал 07:00 EDT Mar 8 (= 11:00Z, после 02→03).
    const dst: RawSample[] = [
      sample("2026-03-08T11:00:00Z", {
        bed_at: "2026-03-08T04:00:00Z",
        wake_at: "2026-03-08T11:00:00Z",
      }),
    ];
    const v = aggregateSleep(dst, NYC);
    expect(v.total_minutes).toBe(7 * 60); // 7ч по абсолютным ts
    expect(v.bedtime_local).toBe("23:00");
    expect(v.wake_local).toBe("07:00");
  });
});

describe("aggregateSteps", () => {
  it("сумма + по часам (локальный час)", () => {
    const samples: RawSample[] = [
      sample("2026-03-15T18:00:00Z", { steps: 1200 }), // 21:00 MSK
      sample("2026-03-15T16:00:00Z", { steps: 800 }), // 19:00 MSK
    ];
    const v = aggregateSteps(samples, MSK);
    expect(v.total_steps).toBe(2000);
    const byHour = v.by_hour as number[];
    expect(byHour[21]).toBe(1200);
    expect(byHour[19]).toBe(800);
    expect(byHour.length).toBe(24);
  });
});

describe("aggregateHeartRate", () => {
  it("avg/min/max; resting из kind=resting", () => {
    const samples: RawSample[] = [
      sample("2026-03-15T08:00:00Z", { bpm: 60, kind: "resting" }),
      sample("2026-03-15T09:00:00Z", { bpm: 70 }),
      sample("2026-03-15T10:00:00Z", { bpm: 80 }),
      sample("2026-03-15T11:00:00Z", { bpm: 100 }),
    ];
    const v = aggregateHeartRate(samples);
    expect(v.min_bpm).toBe(60);
    expect(v.max_bpm).toBe(100);
    expect(v.avg_bpm).toBe(78); // (60+70+80+100)/4 = 77.5 → 78
    expect(v.resting_bpm).toBe(60);
  });

  it("без явного resting — суточный min как прокси", () => {
    const samples: RawSample[] = [
      sample("2026-03-15T09:00:00Z", { bpm: 70 }),
      sample("2026-03-15T10:00:00Z", { bpm: 90 }),
    ];
    const v = aggregateHeartRate(samples);
    expect(v.resting_bpm).toBe(70);
    expect(v.min_bpm).toBe(70);
  });
});

describe("aggregateActivity", () => {
  it("суммы active/total калорий и active минут", () => {
    const samples: RawSample[] = [
      sample("2026-03-15T10:00:00Z", { active_kcal: 100, total_kcal: 1000, active_min: 10 }),
      sample("2026-03-15T11:00:00Z", { active_kcal: 200, total_kcal: 1500, active_min: 20 }),
    ];
    const v = aggregateActivity(samples);
    expect(v.active_calories_kcal).toBe(300);
    expect(v.total_calories_kcal).toBe(2500);
    expect(v.active_minutes).toBe(30);
  });

  it("total_calories undefined, если ни один сэмпл его не дал", () => {
    const v = aggregateActivity([sample("2026-03-15T10:00:00Z", { active_kcal: 100 })]);
    expect(v.total_calories_kcal).toBeUndefined();
  });
});

describe("aggregateWorkouts", () => {
  it("count + items (type/duration/calories/start_local)", () => {
    const samples: RawSample[] = [
      sample("2026-03-15T17:00:00Z", {
        type: "running",
        start_at: "2026-03-15T17:00:00Z", // 20:00 MSK
        duration_min: 45,
        calories_kcal: 400,
      }),
    ];
    const v = aggregateWorkouts(samples, MSK);
    expect(v.count).toBe(1);
    const items = v.items as Array<Record<string, unknown>>;
    expect(items[0].type).toBe("running");
    expect(items[0].duration_min).toBe(45);
    expect(items[0].calories_kcal).toBe(400);
    expect(items[0].start_local).toBe("20:00");
  });
});

describe("aggregateForDay (dispatch)", () => {
  it("выбирает функцию по raw metric", () => {
    const v = aggregateForDay("steps", [sample("2026-03-15T18:00:00Z", { steps: 5 })], MSK);
    expect(v.total_steps).toBe(5);
  });

  it("пустой массив сэмплов → пустой value", () => {
    expect(aggregateForDay("heart_rate", [], MSK)).toEqual({});
  });
});

describe("hhmmInTz", () => {
  it("корректное «HH:MM» для UTC-момента", () => {
    expect(hhmmInTz(new Date("2026-03-15T18:00:00Z"), MSK)).toBe("21:00");
  });
});
