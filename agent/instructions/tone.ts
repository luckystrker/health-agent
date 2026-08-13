// @ts-check
/**
 * Tone-пресет (§11.3) — динамическая инструкция на `turn.started`.
 * Читает `users.tone_preset` и подставляет соответствующий блок системного
 * промпта. Язык — русский для всех пресетов.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";
import { eq } from "drizzle-orm";

import { db } from "../lib/db/client";
import { users } from "../lib/db/schema";
import { getChatId } from "../lib/tenant";
import { tonePromptFor } from "../lib/tone-presets";

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const chatId = getChatId(ctx);
      if (chatId === null) return null;

      const row = await db.query.users.findFirst({
        where: eq(users.telegramChatId, BigInt(chatId)),
      });
      if (!row) return null; // нет user-row (не должно быть после onboarding-guard, но безопасно)

      return defineInstructions({ markdown: tonePromptFor(row.tonePreset) });
    },
  },
});
