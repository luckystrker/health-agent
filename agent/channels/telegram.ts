// @ts-check
/**
 * Telegram-канал (§7.1).
 *
 * - `botUsername` — из `TELEGRAM_BOT_USERNAME` (для `/cmd@bot` и mention-детекции
 *   в группах; для приватных чатов необязателен).
 * - Токены (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`) канал читает
 *   из env сам. Регистрация webhook'а (`setWebhook`) — вручную после деплоя.
 * - **Allowlist (§7.1):** чужой `chat_id` молча игнорируется (возвращаем `null`
 *   из `onMessage` → update дропается). Своим — стандартная auth + dispatch
 *   (`defaultOnMessage`). BotFather не фильтрует писавших — фильтр обязателен.
 * - **403 → `users.blocked` (фаза 3, §16):** override `message.completed`
 *   повторяет дефолтную доставку текста, но при HTTP 403 (юзер заблокировал
 *   бота) помечает юзера в БД и гасит ошибку (доставлять некому); schedules
 *   пропускают таких юзеров (§9). Прочие ошибки доставки — пробрасываются
 *   (поведение как в дефолтном хендлере).
 */
import { defaultTelegramAuth, telegramChannel } from "eve/channels/telegram";

import { env, isChatAllowed } from "../lib/env";
import { log } from "../lib/log";
import { markBlockedByChatId } from "../lib/tenant";
import { telegramHttpStatusFromError } from "../lib/telegram-send";

export default telegramChannel({
  botUsername: env.telegramBotUsername,
  async onMessage(_ctx, message) {
    const chatId = message.chat.id; // channel normalizes to string
    if (!isChatAllowed(chatId)) {
      // Молча игнорировать чужих; не сообщать об allowlist (безопасность).
      return null;
    }
    // Своим — стандартная Telegram user-auth (principal в ctx.session.auth.current).
    const auth = defaultTelegramAuth(message);
    return auth ? { auth } : null;
  },
  events: {
    // Дефолтная доставка (defaults.js) + 403-детект. Override заменяет
    // встроенный хендлер целиком — семантика дефолта сохранена:
    // skip для finishReason="tool-calls" и пустых сообщений, post текста.
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      try {
        await channel.telegram.post(data.message);
      } catch (e) {
        if (telegramHttpStatusFromError(e) === 403) {
          try {
            if (channel.state.chatId != null) {
              await markBlockedByChatId(channel.state.chatId);
            }
          } catch (dbError) {
            log("auth", "user-blocked-403-db-error", "error", {
              chat_id: channel.state.chatId,
              error: dbError instanceof Error ? dbError.message : String(dbError),
            });
          }
          log("auth", "user-blocked-403", "info", { chat_id: channel.state.chatId });
          return; // гасим: юзер заблокировал бота, доставлять некому
        }
        throw e;
      }
    },
  },
});
