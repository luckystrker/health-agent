// @ts-check
/**
 * Юнит-тесты buildWeeklyReportPrompt (schedule weekly-report, фаза 3):
 * промпт встраивает digest-блок, требования §11.1 (порог N=4, тренды без
 * разбора дней, тон, графики, кейс «нет данных») и не зависит от БД.
 */
import { describe, expect, it } from "vitest";

import { buildWeeklyReportPrompt } from "../agent/schedules/weekly-report";
import type { WeekDigest } from "../agent/lib/weekly-digest";

const DAYS7 = ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10"];

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

describe("buildWeeklyReportPrompt", () => {
  it("содержит роль сессии, digest-данные и правила отчёта", () => {
    const prompt = buildWeeklyReportPrompt(digest());
    // роль и запрет на вопросы
    expect(prompt).toContain("НЕДЕЛЬНЫЙ ОТЧЁТ");
    expect(prompt).toContain("Не задавай вопросов");
    // окно недели из digest
    expect(prompt).toContain("2026-08-04 … 2026-08-10");
    expect(prompt).toContain("Дней с данными часов: 7/7");
    // данные
    expect(prompt).toContain("целевой калораж: 2000 ккал/день");
    expect(prompt).toContain("**Цель пользователя**: weight_loss");
    // правила §11.1
    expect(prompt).toContain("БЕЗ разбора каждого дня");
    expect(prompt).toContain("цель молча НЕ меняй");
    expect(prompt).toContain("render-chart");
    expect(prompt).toContain("4096");
  });

  it("при <4 днях с данными — пометка об обязательной неполноте", () => {
    const prompt = buildWeeklyReportPrompt(digest({ daysWithData: 2, incomplete: true }));
    expect(prompt).toContain("Если дней с данными < 4");
    expect(prompt).toContain("нет данных за 5 из 7 дней");
  });

  it("0/7 данных — ветка «не строй отчёт»", () => {
    const prompt = buildWeeklyReportPrompt(digest({ daysWithData: 0, incomplete: true }));
    expect(prompt).toContain("**Если данных совсем нет** (0/7)");
  });
});
