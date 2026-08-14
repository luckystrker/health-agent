// @ts-check
/**
 * Tool `get-calorie-balance` — потреблено vs цель/расход за период (§8, §11.2).
 *
 * Цель — из lib/calories (единый источник с anomaly-check фазы 4); потреблено —
 * из food_entries; расход — TDEE «по боту» и «по часам» для контекста.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { computeCaloriePlanForUser } from "../../lib/calories";
import { recentDays } from "../../lib/daily-read";
import { readFoodDays } from "../../lib/food-read";
import { getUserTimezone, requireUser } from "../../lib/tenant";
import { localDay } from "../../lib/time";

const inputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(7)
    .describe("За сколько последних дней показать баланс (включая сегодня). По умолчанию 7."),
});

export default defineTool({
  description:
    "Баланс калорий за период: по каждому дню — потреблено (food_entries) vs цель; " +
    "плюс итог периода и средний расход (TDEE по боту / по часам). Цель считается " +
    "lib/calories (гибрид, вариант C). Положительный balance — перебор относительно цели.",
  inputSchema,
  async execute({ days }, ctx) {
    const { userId } = await requireUser(ctx);

    let plan;
    try {
      ({ plan } = await computeCaloriePlanForUser(userId));
    } catch {
      return {
        ok: false,
        error: "profile_missing",
        message: "Профиль не заполнен (пол/возраст/рост/вес) — цель по калориям не посчитать.",
      };
    }

    const tz = await getUserTimezone(userId);
    const dayList = recentDays(localDay(new Date(), tz), days);
    const foodDays = await readFoodDays(userId, dayList);

    let consumedTotal = 0;
    let targetTotal = 0;
    const perDay = dayList.map((day) => {
      const consumed = foodDays.get(day)!.totals.kcal;
      const target = plan.targetKcal;
      consumedTotal += consumed;
      targetTotal += target;
      return {
        day,
        consumed_kcal: consumed,
        target_kcal: target,
        balance_kcal: Math.round((consumed - target) * 10) / 10,
      };
    });

    return {
      ok: true,
      days: dayList.length,
      days_data: perDay,
      period: {
        consumed_kcal: Math.round(consumedTotal * 10) / 10,
        target_kcal: targetTotal,
        balance_kcal: Math.round((consumedTotal - targetTotal) * 10) / 10,
        avg_balance_kcal_per_day: Math.round(((consumedTotal - targetTotal) / dayList.length) * 10) / 10,
      },
      burn: { tdee_bot: plan.tdeeBot, tdee_device: plan.tdeeDevice },
      method: plan.factorSource,
    };
  },
});
