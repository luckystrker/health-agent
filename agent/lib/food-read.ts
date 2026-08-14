// @ts-check
/**
 * Чтение `food_entries` за период (§8: get-food / get-calorie-balance; фаза 3 —
 * недельный отчёт). Дни — локальные дни юзера ("YYYY-MM-DD").
 */
import { and, asc, eq, gte, lte } from "drizzle-orm";

import { db } from "./db/client";
import { foodEntries } from "./db/schema";

export interface FoodEntryView {
  consumed_at: string; // ISO
  description: string;
  kcal: number;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  source: string;
}

export interface FoodTotals {
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
}

export interface FoodDaySummary {
  day: string;
  entries: FoodEntryView[];
  totals: FoodTotals;
}

function emptyTotals(): FoodTotals {
  return { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 };
}

/**
 * Записи о питании за `dayList` (отсортированный список локальных дней).
 * Возврат: Map<day, FoodDaySummary> — все дни из dayList, включая пустые.
 */
export async function readFoodDays(userId: string, dayList: string[]): Promise<Map<string, FoodDaySummary>> {
  const result = new Map<string, FoodDaySummary>();
  for (const day of dayList) {
    result.set(day, { day, entries: [], totals: emptyTotals() });
  }
  if (dayList.length === 0) return result;

  const rows = await db
    .select()
    .from(foodEntries)
    .where(
      and(
        eq(foodEntries.userId, userId),
        gte(foodEntries.day, new Date(`${dayList[0]}T00:00:00.000Z`)),
        lte(foodEntries.day, new Date(`${dayList[dayList.length - 1]}T00:00:00.000Z`)),
      ),
    )
    .orderBy(asc(foodEntries.consumedAt));

  for (const r of rows) {
    const dayStr = r.day.toISOString().slice(0, 10);
    const bucket = result.get(dayStr);
    if (!bucket) continue; // записи вне запрошенного окна (например, будущие дни)
    bucket.entries.push({
      consumed_at: r.consumedAt.toISOString(),
      description: r.description,
      kcal: r.kcal,
      protein_g: r.proteinG,
      fat_g: r.fatG,
      carbs_g: r.carbsG,
      source: r.source,
    });
    bucket.totals.kcal += r.kcal;
    bucket.totals.protein_g += r.proteinG ?? 0;
    bucket.totals.fat_g += r.fatG ?? 0;
    bucket.totals.carbs_g += r.carbsG ?? 0;
  }

  // Округление сумм до 0.1 (numeric-арифметика уже float, но чистим хвосты).
  for (const b of result.values()) {
    b.totals.kcal = Math.round(b.totals.kcal * 10) / 10;
    b.totals.protein_g = Math.round(b.totals.protein_g * 10) / 10;
    b.totals.fat_g = Math.round(b.totals.fat_g * 10) / 10;
    b.totals.carbs_g = Math.round(b.totals.carbs_g * 10) / 10;
  }
  return result;
}

/** Суммы за весь период по Map из readFoodDays. */
export function sumFoodPeriod(days: Map<string, FoodDaySummary>): FoodTotals & { days_logged: number } {
  const totals = emptyTotals();
  let logged = 0;
  for (const d of days.values()) {
    if (d.entries.length > 0) logged++;
    totals.kcal += d.totals.kcal;
    totals.protein_g += d.totals.protein_g;
    totals.fat_g += d.totals.fat_g;
    totals.carbs_g += d.totals.carbs_g;
  }
  return {
    kcal: Math.round(totals.kcal * 10) / 10,
    protein_g: Math.round(totals.protein_g * 10) / 10,
    fat_g: Math.round(totals.fat_g * 10) / 10,
    carbs_g: Math.round(totals.carbs_g * 10) / 10,
    days_logged: logged,
  };
}
