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
 */
import { defaultTelegramAuth, telegramChannel } from "eve/channels/telegram";

import { env, isChatAllowed } from "../lib/env";

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
});
