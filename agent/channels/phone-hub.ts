// @ts-check
/**
 * Phone-hub webhook — приём данных с часов (§6.1, §7.2, §13, §16).
 *
 * `defineChannel` + единственный POST-маршрут `/eve/v1/phone-hub` (custom-маршрут
 * eve монтируется ровно по указанному пути — проверено по eve ^0.31).
 *
 * Чистый ингест: НЕ стартует сессию агента, НЕ шлёт юзеру сообщений. Только:
 *  лимит тела (1 MB → 413) → Bearer-токен → hash → lookup `phone_hub_tokens`
 *  (constant-time compare) → 401 при промахе → Zod-валидация + нормализация payload
 *  → дедупликация → запись в `raw_samples`. Структурный лог на каждое событие (§15).
 *
 * Статусы (§16): 200 (ok), 400 (невалидный payload/json), 401 (нет/неизвестный токен),
 * 413 (тело > 1 MB), 500 (ошибка БД — forwarder ретраит, дедуп отловит дубль).
 *
 * `platform`/`device_label` берутся из авторизованной записи токена (не из тела) —
 * токен однозначно идентифицирует устройство.
 */
import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse, extractBearerToken } from "eve/channels/auth";
import { eq } from "drizzle-orm";

import { db } from "../lib/db/client";
import { phoneHubTokens } from "../lib/db/schema";
import { env } from "../lib/env";
import { ingestSample } from "../lib/dedup";
import { log } from "../lib/log";
import { normalizeInbound, PayloadError } from "../lib/normalize";
import { constantTimeHashEqual, hashToken } from "../lib/phone-hub-token";

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB (§13)
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** 401 — токен отсутствует или неизвестен. */
function unauthorized(): Response {
  return createUnauthorizedResponse({
    status: 401,
    message: "valid bearer token required",
    challenges: [{ scheme: "Bearer" }],
  });
}

/**
 * Авторизация: Bearer-токен → SHA-256(salt+token) → lookup в `phone_hub_tokens`.
 * Возвращает userId устройства или Response (401/500).
 */
async function authenticate(request: Request): Promise<{ userId: string; platform: string } | Response> {
  const raw = extractBearerToken(request.headers.get("authorization"));
  if (!raw) {
    log("auth", "phone-hub-no-token", "warn");
    return unauthorized();
  }
  if (!env.phoneHubTokenSalt) {
    log("auth", "phone-hub-salt-missing", "error");
    return json({ ok: false, error: "server misconfigured" }, 500);
  }

  const tokenHash = hashToken(raw, env.phoneHubTokenSalt);
  const row = await db.query.phoneHubTokens.findFirst({
    where: eq(phoneHubTokens.tokenHash, tokenHash),
  });
  if (!row) {
    log("auth", "phone-hub-unknown-token", "warn");
    return unauthorized();
  }
  // Constant-time compare хэшей — defense-in-depth поверх PK-lookup (§13).
  if (!constantTimeHashEqual(tokenHash, row.tokenHash)) {
    log("auth", "phone-hub-token-mismatch", "warn");
    return unauthorized();
  }
  return { userId: row.userId, platform: row.platform };
}

export default defineChannel({
  routes: [
    POST("/eve/v1/phone-hub", async (request) => {
      // 1) Лимит тела по content-length (дёшево, без чтения тела).
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > MAX_BODY_BYTES) {
        log("ingestion", "phone-hub-too-large", "warn", { bytes: contentLength });
        return json({ ok: false, error: "request body too large" }, 413);
      }

      // 2) Авторизация (до чтения/парсинга тела — не тратим работу на чужих).
      const auth = await authenticate(request);
      if (auth instanceof Response) return auth;
      const { userId, platform } = auth;

      // 3) Чтение тела + повторный размерный guard (content-length мог отсутствовать).
      let bodyText: string;
      try {
        bodyText = await request.text();
      } catch {
        log("ingestion", "phone-hub-body-read-error", "warn", { user_id: userId });
        return json({ ok: false, error: "unreadable body" }, 400);
      }
      if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) {
        log("ingestion", "phone-hub-too-large", "warn", { user_id: userId });
        return json({ ok: false, error: "request body too large" }, 413);
      }

      // 4) JSON + нормализация payload (platform/device_label — из токена).
      let bodyJson: Record<string, unknown>;
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        log("ingestion", "phone-hub-invalid-json", "warn", { user_id: userId });
        return json({ ok: false, error: "invalid JSON" }, 400);
      }

      let sample;
      try {
        sample = normalizeInbound({
          platform,
          metric: String(bodyJson.metric ?? ""),
          recordedAt: bodyJson.recorded_at,
          payload: bodyJson.payload,
        });
      } catch (e) {
        const message = e instanceof PayloadError || e instanceof Error ? e.message : "invalid payload";
        log("ingestion", "phone-hub-invalid-payload", "warn", { user_id: userId, error: message });
        return json({ ok: false, error: message }, 400);
      }

      // 5) Дедупликация + запись в raw_samples.
      try {
        const outcome = await ingestSample(userId, sample);
        log("ingestion", "phone-hub-post", "info", {
          user_id: userId,
          metric: sample.metric,
          dedup: outcome.reason,
          inserted: outcome.inserted,
          hash: outcome.hash.slice(0, 12),
        });
        return json({ ok: true }, 200);
      } catch (e) {
        log("ingestion", "phone-hub-db-error", "error", {
          user_id: userId,
          metric: sample.metric,
          error: e instanceof Error ? e.message : String(e),
        });
        return json({ ok: false, error: "internal error" }, 500);
      }
    }),
  ],
});
