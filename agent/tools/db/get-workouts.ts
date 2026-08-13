// @ts-check
import { defineTool } from "eve/tools";
import { z } from "zod";

import { cleanValue, readPeriod, recentDays } from "../../lib/daily-read";
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
    "Тренировки за последние N дней (по умолчанию 7). По дню: { count, items: [{type, " +
    "duration_min, calories_kcal, start_local}] }. Дни без тренировок помечены source='none'.",
  inputSchema,
  async execute({ days }, ctx) {
    const { userId } = await requireUser(ctx);
    const tz = await getUserTimezone(userId);
    const today = localDay(new Date(), tz);
    const dayList = recentDays(today, days);
    const period = await readPeriod(userId, tz, dayList, ["workouts"]);

    const items = dayList.map((day) => {
      const v = period.get(day)!.get("workouts")!;
      return { day, ...cleanValue(v.value), source: v.source };
    });
    return { ok: true, days: dayList.length, workouts: items };
  },
});
