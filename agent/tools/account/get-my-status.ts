// @ts-check
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireUser } from "../../lib/tenant";
import { loadUserOverview, onboardingStepsDone } from "../../lib/user-status";

export default defineTool({
  description:
    "Получить текущий статус пользователя: профиль, активную цель, напоминания, " +
    "timezone, tone и какие шаги онбординга уже пройдены. ВЫЗЫВАЙ В НАЧАЛЕ " +
    "онбординга, чтобы понять, с какого шага продолжить. Также годится, чтобы " +
    "ответить пользователю на «что у меня настроено?».",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { chatId } = await requireUser(ctx);
    const overview = await loadUserOverview(chatId);
    if (!overview) {
      return { ok: false, error: "Профиль не найден." };
    }
    return { ok: true, ...overview, onboarding: onboardingStepsDone(overview) };
  },
});
