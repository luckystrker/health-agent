// @ts-check
import { defineTool } from "eve/tools";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { goals, profiles, users } from "../../lib/db/schema";
import { requireUser } from "../../lib/tenant";

export default defineTool({
  description:
    "Завершить онбординг: выставляет users.onboarded_at = now(). Вызывается на " +
    "шаге 10 онбординга. НЕ завершай онбординг, пока не записаны профиль (update-profile), " +
    "часовой пояс (set-tz), цель (set-goal) и напоминания (set-reminders) — инструмент " +
    "проверит готовность и вернёт {ok:false, missing:[...]} при отсутствии обязательных данных.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { userId } = await requireUser(ctx);

    // Проверка готовности: профиль и активная цель обязательны (шаги 2 и 4).
    const [profile, activeGoal] = await Promise.all([
      db.query.profiles.findFirst({ where: eq(profiles.userId, userId) }),
      db.query.goals.findFirst({ where: and(eq(goals.userId, userId), eq(goals.active, true)) }),
    ]);

    const missing: string[] = [];
    if (!profile) missing.push("profile");
    if (!activeGoal) missing.push("goal");
    if (missing.length > 0) {
      return {
        ok: false,
        error: "Онбординг ещё не завершён: не хватает обязательных данных.",
        missing,
      };
    }

    await db.update(users).set({ onboardedAt: new Date() }).where(eq(users.id, userId));
    return { ok: true, onboarded_at: new Date().toISOString() };
  },
});
