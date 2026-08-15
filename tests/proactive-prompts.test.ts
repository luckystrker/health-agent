// @ts-check
/**
 * Юнит-тесты промптов проактивных сессий фазы 4 (PHASE-4 §5.2–5.4): напоминалки
 * утром/днём/вечером, тренировка, аномалии. Правила: данные уже в промпте,
 * без вопросов, одно сообщение, тон по пресету, вес — информационно.
 */
import { describe, expect, it } from "vitest";

import { buildMorningPrompt } from "../agent/schedules/daily-morning";
import { buildMiddayPrompt } from "../agent/schedules/daily-midday";
import { buildEveningPrompt } from "../agent/schedules/daily-evening";
import { buildWorkoutPrompt } from "../agent/schedules/workout-reminder";
import { buildAnomalyPrompt } from "../agent/schedules/anomaly-check";
import type { MorningFacts, TodayVitals } from "../agent/lib/today-vitals";
import { detectAnomalies, type AnomalyInputs } from "../agent/lib/anomalies";

function morningFacts(over: Partial<MorningFacts> = {}): MorningFacts {
  return {
    sleep: { totalMinutes: 430, bedtimeLocal: "23:30", wakeLocal: "06:40" },
    dinnerLoggedYesterday: false,
    weighedRecently: false,
    ...over,
  };
}

describe("buildMorningPrompt", () => {
  it("факты утра + правила: без вопросов, тон, «не перечисляй факты»", () => {
    const p = buildMorningPrompt(morningFacts());
    expect(p).toContain("УТРЕННЕЕ НАПОМИНАНИЕ");
    expect(p).toContain("Не задавай вопросов");
    expect(p).toContain("внести вчерашний ужин");
    expect(p).toContain("взвеситься");
    expect(p).toContain("tone-пресету");
    expect(p).toContain("ужин записан: нет");
    expect(p).toContain("7.2 ч"); // 430 мин → 7.2 ч
  });

  it("всё записано — ветка «доброе утро», без напоминаний", () => {
    const p = buildMorningPrompt(morningFacts({ dinnerLoggedYesterday: true, weighedRecently: true }));
    expect(p).toContain("если и ужин записан, и вес есть — не напоминай ничего");
    expect(p).toContain("доброе");
  });

  it("сна нет — модель не делает выводов о нём", () => {
    const p = buildMorningPrompt(morningFacts({ sleep: null }));
    expect(p).toContain("данных нет");
    expect(p).toContain("не упоминай отсутствие как проблему");
  });
});

describe("buildMiddayPrompt", () => {
  it("без записей еды — напоминание внести; с записями — лёгкая версия", () => {
    const noFood = buildMiddayPrompt({ kcalEaten: null, foodEntries: 0 });
    expect(noFood).toContain("внести завтрак и обед");
    expect(noFood).toContain("Не задавай вопросов");

    const withFood = buildMiddayPrompt({ kcalEaten: 950, foodEntries: 3 });
    expect(withFood).toContain("950 ккал");
    expect(withFood).toContain("не напоминай в лоб");
  });
});

function vitals(over: Partial<TodayVitals> = {}): TodayVitals {
  return {
    tz: "Europe/Moscow",
    today: "2026-08-15",
    localMinutes: 20 * 60,
    steps: 7300,
    activeKcal: 410,
    kcalEaten: 2150,
    foodEntries: 4,
    kcalTarget: 2000,
    sleep: null,
    ...over,
  };
}

describe("buildEveningPrompt", () => {
  it("сводка дня: калории vs цель (остаток), шаги, активность; без вопросов", () => {
    const p = buildEveningPrompt(vitals());
    expect(p).toContain("ВЕЧЕРНЯЯ СВОДКА");
    expect(p).toContain("съедено сегодня: 2150 ккал (4 записей)");
    expect(p).toContain("целевой калораж: 2000 ккал/день");
    expect(p).toContain("шагов сегодня: 7300");
    expect(p).toContain("активные калории: 410 ккал");
    expect(p).toContain("Не задавай вопросов");
    expect(p).toContain("tone-пресету");
  });

  it("данных нет — короткое напоминание внести еду дня", () => {
    const p = buildEveningPrompt(vitals({ kcalEaten: null, foodEntries: 0, steps: null, activeKcal: null }));
    expect(p).toContain("еды за сегодня не записано");
    expect(p).toContain("внести еду дня");
  });

  it("цель не посчитана — честная пометка, без выдуманных чисел", () => {
    const p = buildEveningPrompt(vitals({ kcalTarget: null }));
    expect(p).toContain("не посчитан");
  });
});

describe("buildWorkoutPrompt", () => {
  it("слот в фактах; без вопросов и без выдуманных деталей программы", () => {
    const p = buildWorkoutPrompt("18:30");
    expect(p).toContain("НАПОМИНАНИЕ О ТРЕНИРОВКЕ");
    expect(p).toContain("18:30");
    expect(p).toContain("не выдумывай упражнения");
    expect(p).toContain("Не задавай вопросов");
  });

  it("фаза 5: упражнения программы дня — в блоке плана, перевод на русском", () => {
    const p = buildWorkoutPrompt("18:30", [
      { exercise_name_en: "Bench Press", sets: 4, reps: "8-12" },
      { exercise_name_en: "Plank", sets: null, reps: "60s" },
    ]);
    expect(p).toContain("План на сегодня");
    expect(p).toContain("Bench Press ×4 (8-12)");
    expect(p).toContain("Plank (60s)");
    expect(p).toContain("переведи на русский");
    expect(p).not.toContain("не выдумывай"); // план есть — запрет не нужен
  });
});

describe("buildAnomalyPrompt", () => {
  function inputs(over: Partial<AnomalyInputs> = {}): AnomalyInputs {
    return {
      tz: "Europe/Moscow",
      localDate: "2026-08-15",
      localMinutes: 19 * 60,
      dayEnded: false,
      sleep: { totalMinutes: 250, bedtimeLocal: "03:00", wakeLocal: "07:10" },
      kcalToday: 2600,
      kcalTarget: 2000,
      stepsToday: 2000,
      stepsMedian7: 8000,
      stepsBaselineDays: 6,
      weight: { weightNowKg: 80.4, prevMedianKg: 78.9 },
      ...over,
    };
  }

  it("все аномалии в одном сообщении; факты с числами; вес — информационно", () => {
    const anomalies = detectAnomalies(inputs());
    const p = buildAnomalyPrompt(anomalies, "2026-08-15");
    expect(p).toContain("АЛЕРТ ОБ АНОМАЛИИ");
    expect(p).toContain("локальный день 2026-08-15");
    expect(p).toContain("Мало сна");
    expect(p).toContain("Перебор калорий");
    expect(p).toContain("съедено сегодня: 2600 ккал");
    expect(p).toContain("Скачок веса");
    expect(p).toContain("информационно");
    expect(p).toContain("Не задавай вопросов");
    expect(p).toContain("ТОЛЬКО числа из блока");
  });
});
