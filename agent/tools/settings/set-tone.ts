// @ts-check
import { defineTool } from "eve/tools";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { users } from "../../lib/db/schema";
import { requireUser } from "../../lib/tenant";
import { TONE_LABELS } from "../../lib/tone-presets";

const inputSchema = z.object({
  tone_preset: z
    .enum(["supportive", "sarcastic", "strict", "neutral"])
    .describe("Tone-пресет: " + Object.entries(TONE_LABELS).map(([k, v]) => `${k} (${v})`).join("; ")),
});

export default defineTool({
  description:
    "Сменить tone-пресет (стиль общения агента). Выбран на онбординге (шаг 6), " +
    "меняется в любой момент. Пресеты: supportive (поддерживающий), sarcastic " +
    "(саркастичный), strict (строгий тренер), neutral (нейтральный).",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);
    await db.update(users).set({ tonePreset: input.tone_preset }).where(eq(users.id, userId));
    return { ok: true, tone_preset: input.tone_preset };
  },
});
