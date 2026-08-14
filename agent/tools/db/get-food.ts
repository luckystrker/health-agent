// @ts-check
/**
 * Tool `get-food` — питание за последние N дней: записи + суммарные ккал/БЖУ (§8).
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { readFoodDays, sumFoodPeriod } from "../../lib/food-read";
import { getUserTimezone, requireUser } from "../../lib/tenant";
import { localDay } from "../../lib/time";
import { recentDays } from "../../lib/daily-read";

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
    "Питание за последние N дней (по умолчанию 7): записи о еде за каждый день + " +
    "суммарные калории/белки/жиры/углеводы. Дни без записей возвращаются пустыми " +
    "(entries: []). Источники: fatsecret / manual / barcode_off.",
  inputSchema,
  async execute({ days }, ctx) {
    const { userId } = await requireUser(ctx);
    const tz = await getUserTimezone(userId);
    const dayList = recentDays(localDay(new Date(), tz), days);
    const foodDays = await readFoodDays(userId, dayList);

    return {
      ok: true,
      days: dayList.length,
      days_data: dayList.map((d) => foodDays.get(d)!),
      totals: sumFoodPeriod(foodDays),
    };
  },
});
