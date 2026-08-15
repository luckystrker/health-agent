// @ts-check
/**
 * Юнит-тесты chart-config.ts (фаза 3, §18.1): маппинг серий в датасеты по
 * kind, формат подписей дней, null-пропуски, guard'ы пустых данных (weight
 * <2 точек), линия цели на calories. Pure — без canvas.
 */
import { describe, expect, it } from "vitest";

import {
  buildCaloriesChart,
  buildSleepChart,
  buildStepsChart,
  buildWeightChart,
  formatDayLabels,
} from "../agent/lib/chart-config";

const DAYS = ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];

describe("formatDayLabels", () => {
  it("ISO-день → «дд.ММ»", () => {
    expect(formatDayLabels(["2026-08-04", "2026-12-31"])).toEqual(["04.08", "31.12"]);
  });
  it("не-ISO строки проходят как есть", () => {
    expect(formatDayLabels(["итог"])).toEqual(["итог"]);
  });
});

describe("buildSleepChart", () => {
  it("минуты → часы (0.1), null-день сохраняется как пропуск", () => {
    const spec = buildSleepChart({ days: DAYS, minutes: [420, null, 465, 442] });
    expect(spec).not.toBeNull();
    expect(spec!.type).toBe("bar");
    expect(spec!.data.labels).toEqual(["04.08", "05.08", "06.08", "07.08"]);
    expect(spec!.data.datasets[0].label).toBe("Сон, ч");
    expect(spec!.data.datasets[0].data).toEqual([7, null, 7.8, 7.4]);
    expect(spec!.options.scales.y.beginAtZero).toBe(true);
  });

  it("все null → null (нет данных)", () => {
    expect(buildSleepChart({ days: DAYS, minutes: [null, null, null, null] })).toBeNull();
  });
});

describe("buildStepsChart", () => {
  it("шаги как есть + null-пропуск", () => {
    const spec = buildStepsChart({ days: DAYS, steps: [8000, 10000, null, 6300] });
    expect(spec!.data.datasets[0].data).toEqual([8000, 10000, null, 6300]);
    expect(spec!.data.datasets[0].label).toBe("Шаги");
  });

  it("пусто → null", () => {
    expect(buildStepsChart({ days: DAYS, steps: [] as (number | null)[] })).toBeNull();
  });
});

describe("buildCaloriesChart", () => {
  it("bar потреблено + пунктирная линия цели на каждый день", () => {
    const spec = buildCaloriesChart({ days: DAYS, kcal: [1900, null, 2200, 1800], targetKcal: 2000 });
    expect(spec!.data.datasets).toHaveLength(2);
    const [bars, line] = spec!.data.datasets;
    expect(bars.type).toBeUndefined(); // основной bar
    expect(bars.data).toEqual([1900, null, 2200, 1800]);
    expect(line.type).toBe("line");
    expect(line.data).toEqual([2000, 2000, 2000, 2000]);
    expect(line.borderDash).toEqual([6, 4]);
    expect(line.spanGaps).toBe(true);
    expect(spec!.options.plugins.legend.display).toBe(true); // два датасета
  });

  it("без цели — один датасет, легенда скрыта", () => {
    const spec = buildCaloriesChart({ days: DAYS, kcal: [1900, 2000, 2100, 1800], targetKcal: null });
    expect(spec!.data.datasets).toHaveLength(1);
    expect(spec!.options.plugins.legend.display).toBe(false);
  });

  it("дней с записями нет → null", () => {
    expect(buildCaloriesChart({ days: DAYS, kcal: [null, null, null, null], targetKcal: 2000 })).toBeNull();
  });
});

describe("buildWeightChart", () => {
  it("≥2 точек — line с полем suggestedMin/Max вокруг данных", () => {
    const spec = buildWeightChart({
      points: [
        { day: "2026-07-15", kg: 79.2 },
        { day: "2026-07-25", kg: 78.6 },
        { day: "2026-08-05", kg: 78.1 },
      ],
    });
    expect(spec!.type).toBe("line");
    expect(spec!.data.datasets[0].data).toEqual([79.2, 78.6, 78.1]);
    expect(spec!.data.labels).toEqual(["15.07", "25.07", "05.08"]);
    expect(spec!.options.scales.y.beginAtZero).toBe(false);
    expect(spec!.options.scales.y.suggestedMin!).toBeLessThan(78.1);
    expect(spec!.options.scales.y.suggestedMax!).toBeGreaterThan(79.2);
  });

  it("<2 точек → null (тренд не виден)", () => {
    expect(buildWeightChart({ points: [{ day: "2026-08-05", kg: 78.1 }] })).toBeNull();
    expect(buildWeightChart({ points: [] })).toBeNull();
  });
});

describe("общие опции", () => {
  it("animation off, responsive off (серверный рендер), заголовок задан", () => {
    const spec = buildSleepChart({ days: DAYS, minutes: [420, 420, 420, 420], title: "Мой сон" });
    expect(spec!.options.animation).toBe(false);
    expect(spec!.options.responsive).toBe(false);
    expect(spec!.options.plugins.title).toEqual({ display: true, text: "Мой сон" });
  });
});
