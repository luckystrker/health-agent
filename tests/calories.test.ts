// @ts-check
/**
 * Юнит-тесты calories.ts (§11.2, §18.1; PHASE-2 §8).
 *
 * BMR Mifflin-St Jeor, фактор активности (пороги шагов + бампы), cold-start
 * fallback (<14 дней → self_reported), целевой калораж под цель (7700 ккал/кг),
 * пол-минимум, calorie_source overrides, TDEE по часам.
 */
import { describe, expect, it } from "vitest";

import {
  activityFactorFromHistory,
  ageFromBirthDate,
  bmrMifflinStJeor,
  calorieFloor,
  computeCaloriePlan,
  type ActivityHistory,
  type CalorieInputs,
} from "../agent/lib/calories";

function history(over: Partial<ActivityHistory> = {}): ActivityHistory {
  return {
    daysWithData: 14,
    avgSteps: 8000,
    avgActiveMinutes: 20,
    medianRestingBpm: 60,
    avgActiveCalories: 400,
    ...over,
  };
}

function inputs(over: Partial<CalorieInputs> = {}): CalorieInputs {
  return {
    sex: "male",
    ageYears: 30,
    heightCm: 180,
    weightKg: 80,
    selfReportedLevel: "moderate",
    history: history(),
    goal: null, // maintenance по умолчанию
    today: "2026-08-14",
    ...over,
  };
}

describe("bmrMifflinStJeor", () => {
  it("мужчина 80кг/180см/30лет → 1780", () => {
    expect(bmrMifflinStJeor("male", 80, 180, 30)).toBe(1780);
  });

  it("женщина 60кг/165см/30лет → 1320 (округление)", () => {
    expect(bmrMifflinStJeor("female", 60, 165, 30)).toBe(1320);
  });
});

describe("ageFromBirthDate", () => {
  it("полных лет с учётом дня рождения", () => {
    expect(ageFromBirthDate(new Date("1996-02-29T00:00:00Z"), new Date("2026-02-28T00:00:00Z"))).toBe(29);
    expect(ageFromBirthDate(new Date("1996-02-29T00:00:00Z"), new Date("2026-03-01T00:00:00Z"))).toBe(30);
  });
});

describe("activityFactorFromHistory", () => {
  it("пороги по средним шагам", () => {
    expect(activityFactorFromHistory(history({ avgSteps: 4999 }))).toBe(1.2);
    expect(activityFactorFromHistory(history({ avgSteps: 5000 }))).toBe(1.375);
    expect(activityFactorFromHistory(history({ avgSteps: 7499 }))).toBe(1.375);
    expect(activityFactorFromHistory(history({ avgSteps: 7500 }))).toBe(1.55);
    expect(activityFactorFromHistory(history({ avgSteps: 9999 }))).toBe(1.55);
    expect(activityFactorFromHistory(history({ avgSteps: 10000 }))).toBe(1.725);
  });

  it("бампы за active_minutes (30→+0.05, 60→+0.1) и RHR ≥85 (+0.025)", () => {
    expect(activityFactorFromHistory(history({ avgActiveMinutes: 30 }))).toBe(1.6);
    expect(activityFactorFromHistory(history({ avgActiveMinutes: 60 }))).toBe(1.65);
    expect(activityFactorFromHistory(history({ avgActiveMinutes: 60, medianRestingBpm: 90 }))).toBe(1.675);
  });

  it("максимальный достижимый фактор — 1.85 (потолок 1.9 — страховой)", () => {
    // 1.725 (≥10k шагов) + 0.1 (≥60 активных минут) + 0.025 (RHR ≥85).
    expect(
      activityFactorFromHistory(history({ avgSteps: 15000, avgActiveMinutes: 120, medianRestingBpm: 95 })),
    ).toBe(1.85);
  });

  it("нет шагов → null (вызывающий откатится на self-reported)", () => {
    expect(activityFactorFromHistory(history({ avgSteps: null }))).toBeNull();
  });
});

describe("computeCaloriePlan — cold-start", () => {
  it("<14 дней → self_reported фактор", () => {
    const plan = computeCaloriePlan(
      inputs({ history: history({ daysWithData: 5 }) }),
    );
    expect(plan.factorSource).toBe("self_reported");
    expect(plan.activityFactor).toBe(1.55); // moderate
    expect(plan.tdeeBot).toBe(Math.round(1780 * 1.55)); // 2759
    expect(plan.notes.join(" ")).toContain("cold-start");
  });

  it("≥14 дней без шагов → тоже self_reported (с пометкой)", () => {
    const plan = computeCaloriePlan(inputs({ history: history({ avgSteps: null }) }));
    expect(plan.factorSource).toBe("self_reported");
    expect(plan.daysOfHistory).toBe(14);
  });
});

describe("computeCaloriePlan — computed фактор", () => {
  it("≥14 дней → computed", () => {
    const plan = computeCaloriePlan(inputs());
    expect(plan.factorSource).toBe("computed");
    expect(plan.activityFactor).toBe(1.55);
    expect(plan.tdeeDevice).toBe(1780 + 400); // BMR + средние active_calories
  });

  it("maintenance: цель = TDEE_бот", () => {
    const plan = computeCaloriePlan(inputs());
    expect(plan.targetKcal).toBe(plan.tdeeBot);
    expect(plan.dailyAdjustmentKcal).toBe(0);
  });
});

describe("computeCaloriePlan — целевой калораж под цель", () => {
  it("weight_loss с темпом 0.5 кг/нед → −550 ккал/день", () => {
    const plan = computeCaloriePlan(
      inputs({
        goal: {
          kind: "weight_loss",
          targetWeightKg: 70,
          targetDate: null,
          tempoKgPerWeek: 0.5,
          calorieSource: "hybrid",
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.dailyAdjustmentKcal).toBe(-550); // 0.5 × 7700 / 7
    expect(plan.targetKcal).toBe(plan.tdeeBot - 550);
  });

  it("muscle_gain → профицит", () => {
    const plan = computeCaloriePlan(
      inputs({
        goal: {
          kind: "muscle_gain",
          targetWeightKg: 90,
          targetDate: null,
          tempoKgPerWeek: 0.25,
          calorieSource: "hybrid",
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.dailyAdjustmentKcal).toBe(275);
    expect(plan.targetKcal).toBe(plan.tdeeBot + 275);
  });

  it("темп из target_date: 10 кг за 10 недель → 1 кг/нед", () => {
    const plan = computeCaloriePlan(
      inputs({
        weightKg: 90,
        goal: {
          kind: "weight_loss",
          targetWeightKg: 80,
          targetDate: "2026-10-23", // 70 дней от 2026-08-14
          tempoKgPerWeek: null,
          calorieSource: "hybrid",
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.tempoKgPerWeek).toBe(1);
    expect(plan.dailyAdjustmentKcal).toBe(-1100);
  });

  it("чрезмерный темп зажимается до 1100 ккал/день + note", () => {
    const plan = computeCaloriePlan(
      inputs({
        goal: {
          kind: "weight_loss",
          targetWeightKg: 60,
          targetDate: null,
          tempoKgPerWeek: 2, // 2200 ккал/день
          calorieSource: "hybrid",
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.dailyAdjustmentKcal).toBe(-1100);
    expect(plan.notes.join(" ")).toContain("зажимаю");
  });

  it("пол-минимум: цель ниже 1500 (муж) поднимается", () => {
    const plan = computeCaloriePlan(
      inputs({
        sex: "male",
        ageYears: 60,
        heightCm: 160,
        weightKg: 55, // BMR ≈ 1217; TDEE ≈ 1887
        goal: {
          kind: "weight_loss",
          targetWeightKg: 50,
          targetDate: null,
          tempoKgPerWeek: 1.5, // −1650 → зажим до −1100 → 787 → ниже пола
          calorieSource: "hybrid",
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.floorApplied).toBe(true);
    expect(plan.targetKcal).toBe(calorieFloor("male"));
    expect(plan.notes.join(" ")).toContain("минимум");
  });

  it("женский минимум — 1200", () => {
    expect(calorieFloor("female")).toBe(1200);
    expect(calorieFloor("male")).toBe(1500);
  });
});

describe("computeCaloriePlan — calorie_source", () => {
  const manualGoal = {
    kind: "weight_loss" as const,
    targetWeightKg: 70,
    targetDate: null,
    tempoKgPerWeek: 0.5,
    calorieSource: "manual" as const,
    manualTargetKcal: 1800,
  };

  it("manual → ручная норма как есть", () => {
    const plan = computeCaloriePlan(inputs({ goal: manualGoal }));
    expect(plan.calorieSource).toBe("manual");
    expect(plan.targetKcal).toBe(1800);
    expect(plan.floorApplied).toBe(false);
  });

  it("manual без нормы → по боту + note", () => {
    const plan = computeCaloriePlan(inputs({ goal: { ...manualGoal, manualTargetKcal: null } }));
    expect(plan.notes.join(" ")).toContain("ручная норма не задана");
    expect(plan.targetKcal).toBe(plan.tdeeBot - 550);
  });

  it("device → база из TDEE по часам", () => {
    const plan = computeCaloriePlan(
      inputs({
        goal: {
          kind: "maintenance" as const,
          targetWeightKg: null,
          targetDate: null,
          tempoKgPerWeek: null,
          calorieSource: "device" as const,
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.targetKcal).toBe(plan.tdeeDevice);
  });

  it("device без active_calories → по боту + note", () => {
    const plan = computeCaloriePlan(
      inputs({
        history: history({ avgActiveCalories: null }),
        goal: {
          kind: "maintenance" as const,
          targetWeightKg: null,
          targetDate: null,
          tempoKgPerWeek: null,
          calorieSource: "device" as const,
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.tdeeDevice).toBeNull();
    expect(plan.notes.join(" ")).toContain("по боту");
    expect(plan.targetKcal).toBe(plan.tdeeBot);
  });
});

describe("computeCaloriePlan — edge-cases цели", () => {
  it("цель без темпа/дедлайна → поддержка веса + note", () => {
    const plan = computeCaloriePlan(
      inputs({
        goal: {
          kind: "weight_loss",
          targetWeightKg: 70,
          targetDate: null,
          tempoKgPerWeek: null,
          calorieSource: "hybrid",
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.dailyAdjustmentKcal).toBe(0);
    expect(plan.notes.join(" ")).toContain("ни темп, ни дедлайн");
  });

  it("дедлайн прошёл → note", () => {
    const plan = computeCaloriePlan(
      inputs({
        goal: {
          kind: "weight_loss",
          targetWeightKg: 70,
          targetDate: "2026-01-01",
          tempoKgPerWeek: null,
          calorieSource: "hybrid",
          manualTargetKcal: null,
        },
      }),
    );
    expect(plan.dailyAdjustmentKcal).toBe(0);
    expect(plan.notes.join(" ")).toContain("дедлайн");
  });
});
