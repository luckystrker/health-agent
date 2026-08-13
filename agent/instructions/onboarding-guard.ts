// @ts-check
/**
 * Onboarding-guard (§10) — динамическая инструкция на `turn.started`.
 *
 * Реализован через `defineDynamic`/`defineInstructions`, а НЕ через hook: hooks в
 * eve observe-only и не умеют инжектить промпт (см. STATUS.md). Контракт тот же,
 * что в PHASE-0.md §6.5: если юзер не онборжен — направить его в онбординг.
 *
 * Заодно ensures user-row для allowlist-юзера при первом сообщении (чтобы
 * `requireUser` находил юзера в tools во время онбординга).
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { ensureUserByChatId, getChatId } from "../lib/tenant";

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const chatId = getChatId(ctx);
      if (chatId === null) return null; // нет Telegram user principal (schedule/app) — не онбординг

      const { onboarded } = await ensureUserByChatId(chatId);
      if (onboarded) return null; // онборжен — обычный режим

      // Не онборжен → жёсткая директива онбординга.
      // Детали 10 шагов — в базовом instructions.md; здесь — только режим.
      return defineInstructions({
        markdown: `## РЕЖИМ ОНБОРДИНГА (приоритет)

Пользователь ещё не прошёл онбординг (\`onboarded_at IS NULL\`). СЕЙЧАС ты работаешь
ТОЛЬКО над онбордингом:

1. Сначала вызови \`get-my-status\`, чтобы узнать, какие шаги уже пройдены
   (онбординг можно прервать и продолжить с места остановки).
2. Веди пользователя по оставшимся шагам 1–10 (см. раздел «Онбординг» в системном
   промпте), используя \`ask_question\` и инструменты записи.
3. НЕ отвечай на посторонние запросы (аналитика, советы, болтовня), пока
   онбординг не завершён. Вежливо возвращай пользователя к текущему шагу.
4. После шага 10 вызови \`complete-onboarding\` — это снимет этот режим.

Шаги 7 (часы) и 8 (FatSecret) — заглушки: просто предложи «Пропустить».`,
      });
    },
  },
});
