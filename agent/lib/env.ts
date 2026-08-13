// @ts-check
/**
 * Типизированный доступ к переменным окружения (§14).
 *
 * Читаются один раз при первом импорте (long-lived процесс). Секреты никогда
 * не попадают в репо — только `.env.example`. Для dev: `.env.local`.
 */

/** Разрешённые Telegram chat_id как строковый Set (для allowlist-сверки). */
function parseAllowedChatIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export const env = {
  // Telegram (фаза 0)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME,
  allowedChatIds: parseAllowedChatIds(process.env.ALLOWED_CHAT_IDS),

  // БД (фаза 0)
  databaseUrl: process.env.DATABASE_URL,
  postgresPassword: process.env.POSTGRES_PASSWORD,

  // Модель (фаза 0)
  modelApiKey: process.env.MODEL_API_KEY,

  // Phone-hub (фаза 1)
  phoneHubTokenSalt: process.env.PHONE_HUB_TOKEN_SALT,

  // FatSecret (фаза 2)
  fatsecretClientId: process.env.FATSECRET_CLIENT_ID,
  fatsecretClientSecret: process.env.FATSECRET_CLIENT_SECRET,
} as const;

/** true, если chat_id есть в allowlist (§7.1). Пустой allowlist пропускает всех. */
export function isChatAllowed(chatId: string): boolean {
  if (env.allowedChatIds.size === 0) return true;
  return env.allowedChatIds.has(chatId);
}
