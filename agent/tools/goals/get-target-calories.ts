// @ts-check
/**
 * Tool `get-target-calories` — целевой калораж, гибрид вариант C (§8, §11.2).
 *
 * Возвращает ОБА числа: «по боту» (BMR × фактор активности — используется для
 * цели) и «по часам» (BMR + active_calories — для справки). `switched: true` —
 * момент перехода с cold-start на реальные данные: сообщи пользователю, что
 * «теперь считаю калории по твоим реальным данным» (§11.2).
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { computeCaloriePlanForUser } from "../../lib/calories";
import { requireUser } from "../../lib/tenant";
import { log } from "../../lib/log";

const inputSchema = z.object({});

export default defineTool({
  description:
    "Целевой калораж и его расчёт: BMR (Mifflin-St Jeor), фактор активности (по " +
    "реальным данным за 14 дней или self-reported при cold-start), TDEE по боту и по " +
    "часам, цель под goal (дефицит/профицит), оба числа покажи пользователю. Если " +
    "switched=true — сообщи, что калории теперь считаются по реальным данным с часов.",
  inputSchema,
  async execute(_input, ctx) {
    const { userId } = await requireUser(ctx);

    let plan, switched;
    try {
      ({ plan, switched } = await computeCaloriePlanForUser(userId));
    } catch (e) {
      return {
        ok: false,
        error: "profile_missing",
        message:
          e instanceof Error
            ? e.message
            : "Профиль не заполнен — расчёт калорий невозможен.",
      };
    }

    if (switched) {
      log("tool", "calories-cold-start-ended", "info", { user_id: userId });
    }

    return {
      ok: true,
      switched,
      bmr: plan.bmr,
      activity_factor: plan.activityFactor,
      factor_source: plan.factorSource, // 'computed' (реальные данные) | 'self_reported' (cold-start)
      days_of_history: plan.daysOfHistory,
      history_window_days: plan.historyWindowDays,
      tdee_bot: plan.tdeeBot, // «по боту» — база для цели (hybrid)
      tdee_device: plan.tdeeDevice, // «по часам» — для справки
      target_kcal: plan.targetKcal,
      calorie_source: plan.calorieSource, // hybrid | device | manual
      daily_adjustment_kcal: plan.dailyAdjustmentKcal, // дефицит (−) / профицит (+)
      tempo_kg_per_week: plan.tempoKgPerWeek,
      floor_applied: plan.floorApplied,
      notes: plan.notes,
    };
  },
});
