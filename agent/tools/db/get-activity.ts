// @ts-check
import { defineTool } from "eve/tools";
import { z } from "zod";

import { cleanValue, combinedSource, readPeriod, recentDays } from "../../lib/daily-read";
import { requireUser, getUserTimezone } from "../../lib/tenant";
import { localDay } from "../../lib/time";

const inputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .default(7)
    .describe("Сколько последних дней вернуть (включая сегодня). По умолчанию 7."),
});

export default defineTool({
  description:
    "Активность за последние N дней (по умолчанию 7): шаги (total + по часам), " +
    "калории (active/total), пульс (resting/avg/min/max). По дню: {steps, activity, heart_rate}. " +
    "Дни без данных помечены source='none'.",
  inputSchema,
  async execute({ days }, ctx) {
    const { userId } = await requireUser(ctx);
    const tz = await getUserTimezone(userId);
    const today = localDay(new Date(), tz);
    const dayList = recentDays(today, days);
    const period = await readPeriod(userId, tz, dayList, ["steps", "activity", "heart_rate"]);

    const items = dayList.map((day) => {
      const m = period.get(day)!;
      const stepsV = m.get("steps")!;
      const activityV = m.get("activity")!;
      const hrV = m.get("heart_rate")!;
      return {
        day,
        steps: cleanValue(stepsV.value),
        activity: cleanValue(activityV.value),
        heart_rate: cleanValue(hrV.value),
        // Источник данных по всем трём метрикам: aggregate > raw > none
        // (если есть HR/калории, но нет шагов, индикатор не должен быть 'none').
        source: combinedSource([stepsV.source, activityV.source, hrV.source]),
      };
    });
    return { ok: true, days: dayList.length, days_data: items };
  },
});
