// @ts-check
import { defineTool } from "eve/tools";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { users } from "../../lib/db/schema";
import { requireUser } from "../../lib/tenant";
import { isValidTimezone } from "../../lib/time";

const inputSchema = z
  .string()
  .min(1)
  .describe("IANA часовой пояс, например Europe/Moscow, Asia/Novosibirsk");

export default defineTool({
  description:
    "Сменить часовой пояс пользователя. Все «дни» и напоминания считаются по этому " +
    "поясу. Исторические агрегаты НЕ пересчитываются (фиксированы на tz дня измерения, " +
    "§12.1). Напоминания применяются к новому tz без изменений.",
  inputSchema,
  async execute(timezone, ctx) {
    const { userId } = await requireUser(ctx);

    if (!isValidTimezone(timezone)) {
      return {
        ok: false,
        error: `Неверный часовой пояс: «${timezone}». Нужно IANA-имя, например Europe/Moscow.`,
      };
    }

    // timezone_set_at — маркер, что юзер явно выбрал tz (шаг 3 онбординга пройден).
    await db
      .update(users)
      .set({ timezone, timezoneSetAt: new Date() })
      .where(eq(users.id, userId));
    return { ok: true, timezone };
  },
});
