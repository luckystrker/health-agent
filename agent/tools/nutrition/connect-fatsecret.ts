// @ts-check
/**
 * Tool `connect-fatsecret` — запуск OAuth 1.0a 3-legged PIN-flow (§6.2; PHASE-2 §6.2).
 *
 * Шаги: request_token (signed POST, oauth_callback=oob) → юзер открывает
 * authorize URL → FatSecret показывает PIN → модель спрашивает PIN через
 * `ask_question` (allowFreeform) → `complete-fatsecret` обменивает PIN на токен.
 *
 * Request-token держится в памяти процесса с TTL 15 мин (решение — см.
 * lib/fatsecret-oauth.ts и STATUS.md): секрет не проходит через контекст модели.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  fetchRequestToken,
  FS_AUTHORIZE_URL,
  PENDING_TTL_MINUTES,
  PENDING_TTL_MS,
  setPendingFlow,
} from "../../lib/fatsecret-oauth";
import { fsErrorPayload, getUserFsToken } from "../../lib/fatsecret-api";
import { log } from "../../lib/log";
import { requireUser } from "../../lib/tenant";

const inputSchema = z.object({});

export default defineTool({
  description:
    "Подключить FatSecret (дневник питания): запускает OAuth 1.0a PIN-flow. " +
    "Вернёт authorize_url — НЕ вызывай этот tool повторно, пока флоу не завершён или " +
    "не истёк (15 мин). После вызова: (1) покажи пользователю ссылку и попроси открыть " +
    "её, войти в FatSecret и разрешить доступ; (2) FatSecret покажет PIN-код; " +
    "(3) спроси PIN через ask_question с allowFreeform:true; (4) передай PIN в " +
    "complete-fatsecret. Если пользователь уже подключён — вернёт already_connected.",
  inputSchema,
  async execute(_input, ctx) {
    const { userId } = await requireUser(ctx);

    try {
      const existing = await getUserFsToken(userId);
      if (existing) {
        return { ok: true, already_connected: true };
      }

      const { token, tokenSecret } = await fetchRequestToken();
      setPendingFlow(userId, {
        requestToken: token,
        requestTokenSecret: tokenSecret,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });
      log("oauth", "fs-connect-started", "info", { user_id: userId });

      return {
        ok: true,
        already_connected: false,
        authorize_url: `${FS_AUTHORIZE_URL}?oauth_token=${encodeURIComponent(token)}`,
        expires_in_minutes: PENDING_TTL_MINUTES,
        instructions:
          "Покажи ссылку пользователю, попроси открыть её, войти в FatSecret и нажать " +
          "'Allow'. Отобразится PIN-код — спроси его через ask_question (allowFreeform: " +
          "true) и передай в complete-fatsecret в течение 15 минут.",
      };
    } catch (e) {
      log("oauth", "fs-connect-failed", "error", {
        user_id: userId,
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, ...fsErrorPayload(e) };
    }
  },
});
