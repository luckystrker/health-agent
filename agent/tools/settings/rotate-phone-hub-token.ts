// @ts-check
import { defineTool } from "eve/tools";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { phoneHubTokens } from "../../lib/db/schema";
import { env } from "../../lib/env";
import { log } from "../../lib/log";
import { generateToken, hashToken } from "../../lib/phone-hub-token";
import { requireUser } from "../../lib/tenant";

const inputSchema = z.object({
  platform: z
    .enum(["ios", "android"])
    .describe("Платформа forwarder'а: android (mcnaveen/health-connect-webhook) или ios."),
  device_label: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(
      "Метка устройства, напр. 'amazfit', 'huawei', 'iphone'. Одно устройство на " +
        "(платформа, метка); повторный вызов с той же меткой ротирует токен.",
    ),
});

const PHONE_HUB_PATH = "/eve/v1/phone-hub";

/** Собрать публичный URL webhook'а для выдачи юзеру (§6.1). null если база не задана. */
export function phoneHubWebhookUrl(): string | null {
  const base = env.phoneHubWebhookUrl?.trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${PHONE_HUB_PATH}`;
}

export default defineTool({
  description:
    "Выдать или ротировать токен phone-hub для forwarder'а (часы → Apple Health / " +
    "Health Connect → forwarder → наш webhook). На онбординге (шаг 7) и при замене " +
    "телефона/переустановке forwarder'а. Старый токен (если был для той же платформы " +
    "и метки) инвалидируется — POST'ы с ним получают 401. Plaintext-токен показывается " +
    "ОДИН РАЗ: сразу выведи его пользователю вместе с URL и инструкцией установки.",
  inputSchema,
  async execute({ platform, device_label }, ctx) {
    const { userId } = await requireUser(ctx);

    const salt = env.phoneHubTokenSalt;
    if (!salt) {
      log("auth", "phone-hub-salt-missing", "error", { user_id: userId });
      return { ok: false, error: "Сервер не настроен: отсутствует PHONE_HUB_TOKEN_SALT." };
    }

    // Atomic issue/rotate: найти существующий токен (→ rotated_from), удалить, вставить новый.
    const { token, rotatedFrom } = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ tokenHash: phoneHubTokens.tokenHash })
        .from(phoneHubTokens)
        .where(
          and(
            eq(phoneHubTokens.userId, userId),
            eq(phoneHubTokens.platform, platform),
            eq(phoneHubTokens.deviceLabel, device_label),
          ),
        )
        .limit(1);

      const rotatedFrom = existing[0]?.tokenHash ?? null;
      if (existing.length > 0) {
        await tx
          .delete(phoneHubTokens)
          .where(eq(phoneHubTokens.tokenHash, existing[0].tokenHash));
      }

      const newToken = generateToken();
      const tokenHash = hashToken(newToken, salt);
      await tx.insert(phoneHubTokens).values({
        tokenHash,
        userId,
        platform,
        deviceLabel: device_label,
        rotatedFrom,
      });
      return { token: newToken, rotatedFrom };
    });

    log("auth", "phone-hub-token-issued", "info", {
      user_id: userId,
      platform,
      device_label,
      rotated: rotatedFrom !== null,
    });

    const url = phoneHubWebhookUrl();
    return {
      ok: true,
      // ВЫВЕДИ пользователю немедленно — повторно токен не показывается.
      token,
      webhook_url: url ?? "(URL не настроен: задайте PHONE_HUB_WEBHOOK_URL)",
      webhook_url_configured: url !== null,
      platform,
      device_label,
      rotated_previous: rotatedFrom !== null,
      instructions:
        platform === "android"
          ? "Установи mcnaveen/health-connect-webhook (Android), в настройках webhook " +
            "укажи этот URL и Bearer-токен. Дай права на Health Connect (sleep/steps/heart_rate/...)."
          : "Установи «Health Webhook» (App Store), впиши этот URL и Bearer-токен, " +
            "дай права на Apple Health (sleep/steps/heart_rate/workouts).",
    };
  },
});
