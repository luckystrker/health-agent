// @ts-check
/**
 * Интеграционный тест рендера (§18.1 + §13): реальные ChartSpec'ы из
 * lib/chart-config.ts прогоняются через chartjs-node-canvas → PNG.
 *
 * Валидирует структурную совместимость ChartSpec ↔ ChartConfiguration
 * (в tool'е она обходит typecheck через cast) — ловит неверную форму опций.
 * Canvas — локальный (нативный модуль, без сети/БД); предbuilt-бинарники
 * работают на Windows/Linux без X-сервера.
 */
import { describe, expect, it } from "vitest";

import {
  buildCaloriesChart,
  buildSleepChart,
  buildStepsChart,
  buildWeightChart,
} from "../agent/lib/chart-config";

const DAYS = ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];

const PNG_SIGNATURE = "89504e47"; // ‰PNG

async function renderPng(spec: unknown): Promise<Buffer> {
  const { ChartJSNodeCanvas } = await import("chartjs-node-canvas");
  const renderer = new ChartJSNodeCanvas({
    width: 320,
    height: 200,
    backgroundColour: "#ffffff",
  });
  return renderer.renderToBuffer(spec as never);
}

describe("ChartSpec → PNG (интеграция с chartjs-node-canvas)", () => {
  it("sleep: bar-спек рендерится в валидный PNG", async () => {
    const spec = buildSleepChart({ days: DAYS, minutes: [420, null, 465, 442] });
    const png = await renderPng(spec);
    expect(png.subarray(0, 4).toString("hex")).toBe(PNG_SIGNATURE);
    expect(png.length).toBeGreaterThan(1000);
  });

  it("calories: bar + line-цель (2 датасета) рендерится", async () => {
    const spec = buildCaloriesChart({ days: DAYS, kcal: [1900, null, 2200, 1800], targetKcal: 2000 });
    const png = await renderPng(spec);
    expect(png.subarray(0, 4).toString("hex")).toBe(PNG_SIGNATURE);
  });

  it("weight: line-спек с suggestedMin/Max рендерится", async () => {
    const spec = buildWeightChart({
      points: [
        { day: "2026-07-15", kg: 79.2 },
        { day: "2026-07-25", kg: 78.6 },
        { day: "2026-08-05", kg: 78.1 },
      ],
    });
    const png = await renderPng(spec);
    expect(png.subarray(0, 4).toString("hex")).toBe(PNG_SIGNATURE);
  });

  it("steps: рендерится с кастомным title", async () => {
    const spec = buildStepsChart({ days: DAYS, steps: [8000, 10000, null, 6300], title: "Моя активность" });
    const png = await renderPng(spec);
    expect(png.subarray(0, 4).toString("hex")).toBe(PNG_SIGNATURE);
  });
});
