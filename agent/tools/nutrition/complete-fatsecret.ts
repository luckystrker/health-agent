// @ts-check
/**
 * Tool `complete-fatsecret` — обмен PIN (oauth_verifier) на access-токен (§6.2;
 * PHASE-2 §6.2). Сохраняет пару в `fatsecret_tokens` (upsert, revoked_at=null).
 *
 * Неверный PIN → flow НЕ сбрасывается (юзер может ретраить в рамках TTL 15 мин);
 * истёкший/отсутствующий flow → нужно перезапустить connect-fatsecret.
 */
import { defineTool } from "eve/tools";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { fatsecretTokens } from "../../lib/db/schema";
import {
  clearPendingFlow,
  fetchAccessToken,
  getPendingFlow,
  FsOauthError,
} from "../../lib/fatsecret-oauth";
import { fsErrorPayload } from "../../lib/fatsecret-api";
import { log } from "../../lib/log";
import { requireUser } from "../../lib/tenant";

const inputSchema = z.object({
  pin: z
    .string()
    .trim()
    .regex(/^\d{4,12}$/, "PIN — 4–12 цифр (без пробелов)")
    .describe("PIN-код с экрана авторизации FatSecret."),
});

export default defineTool({
  description:
    "Завершить подключение FatSecret: обменять PIN-код (получен пользователем на " +
    "экране авторизации после connect-fatsecret) на access-токен. Вызывай ровно с тем " +
    "PIN, который прислал пользователь. Неверный PIN можно ввести повторно (пока не " +
    "истёк 15-минутный флоу).",
  inputSchema,
  async execute({ pin }, ctx) {
    const { userId } = await requireUser(ctx);

    const pending = getPendingFlow(userId);
    if (!pending) {
      return {
        ok: false,
        error: "fs_flow_expired",
        message:
          "Подключение не начато или истекло (15 минут). Вызови connect-fatsecret заново.",
      };
    }

    try {
      const { token, tokenSecret } = await fetchAccessToken(
        pending.requestToken,
        pending.requestTokenSecret,
        pin,
      );

      const connectedAt = new Date();
      await db
        .insert(fatsecretTokens)
        .values({
          userId,
          accessToken: token,
          accessTokenSecret: tokenSecret,
          connectedAt,
        })
        .onConflictDoUpdate({
          target: fatsecretTokens.userId,
          set: {
            accessToken: token,
            accessTokenSecret: tokenSecret,
            connectedAt,
            revokedAt: null, // переподключение снимает прошлый отзыв
          },
        });

      clearPendingFlow(userId);
      log("oauth", "fs-connected", "info", { user_id: userId });
      return { ok: true, connected_at: connectedAt.toISOString() };
    } catch (e) {
      // Ретраебельные сбои (неверный PIN, сеть/таймаут) — флоу живёт дальше,
      // юзер может повторить в рамках TTL. Прочее — сбрасываем.
      if (e instanceof FsOauthError && (e.code === "fs_invalid_pin" || e.code === "fs_unavailable")) {
        log("oauth", e.code === "fs_invalid_pin" ? "fs-invalid-pin" : "fs-complete-network", "warn", {
          user_id: userId,
        });
        return { ok: false, ...fsErrorPayload(e) };
      }
      clearPendingFlow(userId);
      log("oauth", "fs-complete-failed", "error", {
        user_id: userId,
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, ...fsErrorPayload(e) };
    }
  },
});
