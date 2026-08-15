// @ts-check
/**
 * Pure-конфигурации графиков для `render-chart` (§8, §13; PHASE-3 §5.3).
 *
 * Модуль НЕ импортирует chart.js — возвращает структурный ChartSpec
 * (подмножество ChartConfiguration), который tool передаёт в
 * `ChartJSNodeCanvas.renderToBuffer`. Так маппинг данных → датасеты
 * unit-тестируется без canvas.
 *
 * Все подписи — на русском. Данные графика читает сам tool из БД (никогда не
 * проходят через контекст модели).
 */

export type ChartKind = "sleep" | "weight" | "steps" | "calories";

/** Подмножество ChartConfiguration, достаточное для renderToBuffer. */
export interface ChartSpec {
  type: "bar" | "line";
  data: {
    labels: string[];
    datasets: ChartDataset[];
  };
  options: {
    animation: false;
    responsive: boolean;
    plugins: {
      legend: { display: boolean };
      title: { display: boolean; text: string };
    };
    scales: {
      x?: { stacked?: boolean };
      y: {
        beginAtZero?: boolean;
        title?: { display: boolean; text: string };
        suggestedMin?: number;
        suggestedMax?: number;
        ticks?: { precision?: number };
      };
    };
  };
}

export interface ChartDataset {
  label: string;
  data: (number | null)[];
  type?: "bar" | "line";
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderDash?: number[];
  fill?: boolean;
  spanGaps?: boolean;
  pointRadius?: number;
  tension?: number;
}

// Палитра: спокойные цвета, читаемые на белом фоне Telegram.
const COLORS = {
  sleep: "#6366f1", // индиго
  steps: "#14b8a6", // тил
  calories: "#f59e0b", // янтарь
  target: "#ef4444", // красный (пунктир цели)
  weight: "#3b82f6", // синий
  grid: "rgba(0,0,0,0.06)",
} as const;

/** "2026-08-10" → "10.08" (короткие подписи оси X). */
export function formatDayLabels(days: string[]): string[] {
  return days.map((d) => (/^\d{4}-(\d{2})-(\d{2})$/.test(d) ? d.slice(8, 10) + "." + d.slice(5, 7) : d));
}

function baseOptions(title: string, yTitle: string, beginAtZero: boolean): ChartSpec["options"] {
  return {
    animation: false,
    responsive: false,
    plugins: {
      legend: { display: false },
      title: { display: true, text: title },
    },
    scales: {
      y: {
        beginAtZero,
        title: { display: true, text: yTitle },
      },
    },
  };
}

export interface SleepChartInput {
  days: string[];
  /** Минуты по дням; null — нет данных (пропуск на графике). */
  minutes: (number | null)[];
  title?: string;
}

/** Сон по ночам (bar, часы с точностью 0.1). null → нет данных. */
export function buildSleepChart(input: SleepChartInput): ChartSpec | null {
  if (!input.minutes.some((m) => m != null)) return null;
  const hours = input.minutes.map((m) => (m != null ? Math.round((m / 60) * 10) / 10 : null));
  return {
    type: "bar",
    data: {
      labels: formatDayLabels(input.days),
      datasets: [
        {
          label: "Сон, ч",
          data: hours,
          backgroundColor: COLORS.sleep,
        },
      ],
    },
    options: baseOptions(input.title ?? "Сон по ночам", "часы", true),
  };
}

export interface StepsChartInput {
  days: string[];
  steps: (number | null)[];
  title?: string;
}

export function buildStepsChart(input: StepsChartInput): ChartSpec | null {
  if (!input.steps.some((s) => s != null)) return null;
  return {
    type: "bar",
    data: {
      labels: formatDayLabels(input.days),
      datasets: [
        {
          label: "Шаги",
          data: input.steps,
          backgroundColor: COLORS.steps,
        },
      ],
    },
    options: baseOptions(input.title ?? "Шаги по дням", "шаги", true),
  };
}

export interface CaloriesChartInput {
  days: string[];
  /** Ккал по дням; null — день без записей (не записывал ≠ 0 ккал). */
  kcal: (number | null)[];
  targetKcal: number | null;
  title?: string;
}

/** Потреблено по дням (bar) + целевой калораж (пунктирная линия). */
export function buildCaloriesChart(input: CaloriesChartInput): ChartSpec | null {
  if (!input.kcal.some((k) => k != null)) return null;
  const title = input.title ?? "Калории по дням";
  const hasTarget = input.targetKcal != null;
  const datasets: ChartDataset[] = [
    {
      label: "Потреблено, ккал",
      data: input.kcal,
      backgroundColor: COLORS.calories,
    },
  ];
  if (hasTarget) {
    datasets.push({
      label: "Цель, ккал",
      data: input.kcal.map(() => input.targetKcal),
      type: "line",
      borderColor: COLORS.target,
      borderWidth: 2,
      borderDash: [6, 4],
      pointRadius: 0,
      spanGaps: true,
    });
  }
  return {
    type: "bar",
    data: {
      labels: formatDayLabels(input.days),
      datasets,
    },
    options: {
      ...baseOptions(title, "ккал", true),
      // легенда осмысленна только с линией цели (2 датасета)
      plugins: { legend: { display: hasTarget }, title: { display: true, text: title } },
    },
  };
}

export interface WeightChartInput {
  points: { day: string; kg: number }[];
  title?: string;
}

/** Тренд веса (line). Guard: <2 точек → null (тренд не виден). */
export function buildWeightChart(input: WeightChartInput): ChartSpec | null {
  if (input.points.length < 2) return null;
  const kgs = input.points.map((p) => p.kg);
  const min = Math.min(...kgs);
  const max = Math.max(...kgs);
  const pad = Math.max((max - min) * 0.15, 0.4);
  return {
    type: "line",
    data: {
      labels: formatDayLabels(input.points.map((p) => p.day)),
      datasets: [
        {
          label: "Вес, кг",
          data: kgs,
          borderColor: COLORS.weight,
          backgroundColor: COLORS.weight,
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.2,
          spanGaps: true,
        },
      ],
    },
    options: {
      ...baseOptions(input.title ?? "Тренд веса", "кг", false),
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: "кг" },
          suggestedMin: Math.round((min - pad) * 10) / 10,
          suggestedMax: Math.round((max + pad) * 10) / 10,
        },
      },
    },
  };
}
