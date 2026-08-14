// @ts-check
/**
 * FatSecret OAuth (§6.2, §13; PHASE-2 §6.1).
 *
 * Два независимых потока:
 *  1. **OAuth 2.0 Client Credentials** — публичный поиск продуктов (app-scoped).
 *     Токен живёт в памяти процесса (24ч TTL), refresh за ~1 час до истечения (§5.7).
 *     Ключи — env `FATSECRET_CLIENT_ID` / `FATSECRET_CLIENT_SECRET`.
 *  2. **OAuth 1.0a 3-legged (PIN-flow)** — чтение/запись дневника юзера.
 *     Access-токен бессрочный, refresh-flow отсутствует (при отзыве — перезапуск flow).
 *     Подпись — ручной HMAC-SHA1 по RFC 5849 (~40 строк, без зависимости `oauth-1.0a`
 *     — выбор зафиксирован в STATUS.md; корректность — юнит-тестом на вектор из RFC 5849).
 *
 * Эндпоинты (дока platform.fatsecret.com, раздел Authentication):
 *  - request token: POST https://authentication.fatsecret.com/oauth/request_token
 *    (старые platform/rest/* URL'ы деприкейтед и отдавали 500)
 *  - authorize:     https://authentication.fatsecret.com/oauth/authorize
 *  - access token:  POST https://authentication.fatsecret.com/oauth/access_token
 *  - REST:          POST https://platform.fatsecret.com/rest/server.api
 *
 * Токены НИКОГДА не логируются и не возвращаются в контекст модели (§13, §15).
 */
import { createHmac, randomBytes } from "node:crypto";

import { env } from "./env";
import { log } from "./log";

export const FS_OAUTH_BASE = "https://authentication.fatsecret.com/oauth";
export const FS_AUTHORIZE_URL = `${FS_OAUTH_BASE}/authorize`;

/**
 * Таймаут одного HTTP-запроса к FatSecret (review фазы 2, P1): Node fetch БЕЗ
 * дефолтного таймаута — зависший сервер вешал бы tool-вызов/ночной sync навсегда.
 * Каждая попытка (включая retry в fetchWithRetry) получает свежий сигнал.
 */
export const FS_FETCH_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 1.0a signing (RFC 5849), чистые функции — unit-тестируемые
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RFC 3986 percent-encoding (RFC 5849 §3.6). `encodeURIComponent` НЕ кодирует
 * `!'()*` — для сигнатуры они обязаны быть закодированы.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Нормализация URL для base string (RFC 5849 §3.4.1.2): схема+хост в lower-case,
 * дефолтный порт опускается, query/fragment отбрасываются (query-параметры
 * передаются в общем списке параметров вызывающим).
 */
export function normalizeBaseUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  const scheme = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  const port =
    (u.port && scheme === "https:" && u.port !== "443") ||
    (u.port && scheme === "http:" && u.port !== "80")
      ? `:${u.port}`
      : "";
  return `${scheme}//${host}${port}${u.pathname}`;
}

/**
 * Base string (RFC 5849 §3.4.1.1): `METHOD&encode(url)&encode(nvs)`,
 * где nvs — параметры (oauth_* + параметры запроса), отсортированные по
 * (encoded key, encoded value) и склеенные через `&` в форме `k=v`.
 * Дубликаты ключей поддерживаются (передаются повторными парами).
 */
export function signatureBaseString(
  method: string,
  url: string,
  params: readonly (readonly [string, string])[],
): string {
  const encoded = params.map(
    ([k, v]) => [percentEncode(k), percentEncode(v)] as const,
  );
  // Сортировка по закодированным key, затем value (§3.4.1.3.2).
  encoded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const nvs = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  return [method.toUpperCase(), percentEncode(normalizeBaseUrl(url)), percentEncode(nvs)].join("&");
}

/**
 * HMAC-SHA1 подпись (RFC 5849 §3.4.3). Ключ = `encode(consumer_secret) & encode(token_secret)`
 * (пустой token_secret на шаге request_token даёт хвостовой `&`).
 */
export function hmacSha1Signature(
  baseString: string,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(baseString, "utf8").digest("base64");
}

/** Случайный oauth_nonce (base64, 16 байт энтропии). */
export function makeNonce(): string {
  return randomBytes(16).toString("base64");
}

export interface Oauth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
}

/**
 * Подписать запрос OAuth 1.0a и собрать `Authorization: OAuth ...` заголовок.
 * Все oauth_*-параметры идут в заголовок; тело запроса подписывается через
 * `extraParams` (form-urlencoded параметры — их же отправляет вызывающий).
 * `extraOauth` — oauth_callback (request_token) / oauth_verifier (access_token).
 */
export function signOauth1(
  method: string,
  url: string,
  creds: Oauth1Credentials,
  extraParams: Readonly<Record<string, string>> = {},
  extraOauth: Readonly<Record<string, string>> = {},
): { authorization: string } {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: makeNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extraOauth,
  };
  if (creds.token) oauthParams.oauth_token = creds.token;

  const allParams: [string, string][] = [
    ...Object.entries(oauthParams),
    ...Object.entries({ ...extraParams }),
  ];
  const base = signatureBaseString(method, url, allParams);
  const signature = hmacSha1Signature(base, creds.consumerSecret, creds.tokenSecret ?? "");

  const header =
    "OAuth " +
    Object.entries(oauthParams)
      .map(([k, v]) => `${k}="${percentEncode(v)}"`)
      .concat(`oauth_signature="${percentEncode(signature)}"`)
      .join(", ");
  return { authorization: header };
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 1.0a 3-legged PIN-flow (§6.2)
// ─────────────────────────────────────────────────────────────────────────────

/** Шаг 1: request token (oauth_callback=oob → FatSecret покажет юзеру PIN). */
export async function fetchRequestToken(): Promise<{ token: string; tokenSecret: string }> {
  const url = `${FS_OAUTH_BASE}/request_token`;
  const creds = requireConsumer();
  const { authorization } = signOauth1("POST", url, creds, {}, { oauth_callback: "oob" });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(FS_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // Сеть/таймаут — ретраебельно юзером (перезапуск шага), не конфиг-ошибка.
    log("oauth", "fs-request-token-network", "warn", {
      error: e instanceof Error ? e.message : String(e),
    });
    throw new FsOauthError("request_token: network failure", "fs_unavailable");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log("oauth", "fs-request-token-error", "error", { status: res.status, body: body.slice(0, 200) });
    if (res.status === 401 || res.status === 403) {
      // Подпись/ключи отвергнуты сервером — конфиг приложения, не «не настроено».
      throw new FsOauthError(`request_token: credentials rejected (HTTP ${res.status})`, "fs_auth_failed");
    }
    throw new FsOauthError(`request_token failed: HTTP ${res.status}`, "fs_oauth_failed");
  }
  const form = new URLSearchParams(await res.text());
  const token = form.get("oauth_token");
  const tokenSecret = form.get("oauth_token_secret");
  if (!token || !tokenSecret) {
    throw new FsOauthError("request_token: missing oauth_token/oauth_token_secret", "fs_oauth_failed");
  }
  return { token, tokenSecret };
}

/**
 * Шаг 3: обмен PIN (oauth_verifier) на access-токен. Подписывается request-token'ом.
 * 401 → неверный/просроченный PIN (вызывающий даёт юзеру ретрай в рамках TTL).
 */
export async function fetchAccessToken(
  requestToken: string,
  requestTokenSecret: string,
  pin: string,
): Promise<{ token: string; tokenSecret: string }> {
  const url = `${FS_OAUTH_BASE}/access_token`;
  const creds = requireConsumer();
  const { authorization } = signOauth1(
    "POST",
    url,
    { ...creds, token: requestToken, tokenSecret: requestTokenSecret },
    {},
    { oauth_verifier: pin },
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(FS_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    log("oauth", "fs-access-token-network", "warn", {
      error: e instanceof Error ? e.message : String(e),
    });
    throw new FsOauthError("access_token: network failure", "fs_unavailable");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log("oauth", "fs-access-token-error", "warn", { status: res.status, body: body.slice(0, 200) });
    if (res.status === 401) {
      throw new FsOauthError("access_token: invalid/expired PIN", "fs_invalid_pin");
    }
    throw new FsOauthError(`access_token failed: HTTP ${res.status}`, "fs_oauth_failed");
  }
  const form = new URLSearchParams(await res.text());
  const token = form.get("oauth_token");
  const tokenSecret = form.get("oauth_token_secret");
  if (!token || !tokenSecret) {
    throw new FsOauthError("access_token: missing oauth_token/oauth_token_secret", "fs_oauth_failed");
  }
  return { token, tokenSecret };
}

/** Ошибка OAuth-флоу с кодом для user-friendly маппинга в tools. */
export class FsOauthError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FsOauthError";
    this.code = code;
  }
}

/** Consumer-ключи из env; бросает понятную ошибку, если не настроены. */
export function requireConsumer(): { consumerKey: string; consumerSecret: string } {
  if (!env.fatsecretClientId || !env.fatsecretClientSecret) {
    throw new FsOauthError(
      "FATSECRET_CLIENT_ID/FATSECRET_CLIENT_SECRET не настроены",
      "fs_not_configured",
    );
  }
  return { consumerKey: env.fatsecretClientId, consumerSecret: env.fatsecretClientSecret };
}

/**
 * Ожидаемый PIN-флоу между connect и complete (§6.2, PHASE-2 §6.2).
 *
 * Решение (STATUS.md): request-token держим в памяти процесса с TTL 15 мин, а НЕ
 * в resume-значении park-хука — секрет токена не должен проходить через контекст
 * модели (§13). Парковка turn'а в eve переживает рестарт процесса, а флоу — нет:
 * при рестарте в окне PIN юзер просто перезапускает подключение (edge-case §7
 * «юзер не ввёл PIN» — тот же исход). Совместим с паттерном in-memory dedup §9.
 */
const PENDING_TTL_MS = 15 * 60 * 1000;
export { PENDING_TTL_MS };
/** TTL pending-флоу в минутах — для подсказок юзеру (tools). */
export const PENDING_TTL_MINUTES = 15;

export interface PendingFsFlow {
  requestToken: string;
  requestTokenSecret: string;
  expiresAt: number;
}

const pendingFlows = new Map<string, PendingFsFlow>();

export function setPendingFlow(userId: string, flow: PendingFsFlow): void {
  // Чистим протухшие попутно (мапа максимум на размер аудитории).
  const now = Date.now();
  for (const [k, v] of pendingFlows) if (v.expiresAt <= now) pendingFlows.delete(k);
  pendingFlows.set(userId, flow);
}

/** Живой pending-flow юзера или null (отсутствует / истёк). */
export function getPendingFlow(userId: string): PendingFsFlow | null {
  const f = pendingFlows.get(userId);
  if (!f) return null;
  if (f.expiresAt <= Date.now()) {
    pendingFlows.delete(userId);
    return null;
  }
  return f;
}

export function clearPendingFlow(userId: string): void {
  pendingFlows.delete(userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 2.0 client-credentials (app-токен для публичного поиска)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Кэш app-токена в памяти процесса (§5.7): 24ч TTL, refresh за ~1ч до истечения.
 * Рестарт процесса → просто перевыпуск (токен дешёвый, единственный на приложение).
 * Single-flight: параллельные вызывающие ждут один и тот же promise.
 */
interface CachedAppToken {
  token: string;
  expiresAt: number; // epoch ms
}

let cachedAppToken: CachedAppToken | null = null;
let inflight: Promise<string> | null = null;
const APP_TOKEN_REFRESH_AHEAD_MS = 60 * 60 * 1000; // за 1 час до истечения

/** Тестовый хук: сброс кэша (используется юнит-тестами). */
export function resetAppTokenCache(): void {
  cachedAppToken = null;
  inflight = null;
}

/** Тестовый хук: подсадить кэш app-токена (проверка окна refresh за ~1ч). */
export function setAppTokenCacheForTests(token: string, expiresAt: number): void {
  cachedAppToken = { token, expiresAt };
}

/** Живой закэшированный токен (без сети) или null. */
export function peekAppToken(now = Date.now()): string | null {
  if (!cachedAppToken) return null;
  return cachedAppToken.expiresAt - APP_TOKEN_REFRESH_AHEAD_MS > now ? cachedAppToken.token : null;
}

/**
 * Получить валидный app-токен (кэш → перевыпуск при необходимости).
 * POST oauth.fatsecret.com/connect/token, Basic auth, grant_type=client_credentials.
 */
export async function getAppToken(): Promise<string> {
  const cached = peekAppToken();
  if (cached) return cached;
  if (inflight) return inflight;

  const creds = requireConsumer();
  inflight = (async () => {
    let res: Response;
    try {
      res = await fetch("https://oauth.fatsecret.com/connect/token", {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials&scope=basic",
        signal: AbortSignal.timeout(FS_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      // Сеть/таймаут → fs_unavailable (review P1: раньше сырой TypeError долетал
      // юзеру как fs_unexpected).
      log("oauth", "fs-app-token-network", "warn", {
        error: e instanceof Error ? e.message : String(e),
      });
      throw new FsOauthError("app token: network failure", "fs_unavailable");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 400/401 = invalid_client: ключи приложения отвергнуты (review P1: раньше
      // любой не-OK считался «не настроено»). Прочее (5xx и т.п.) — деградация.
      log("oauth", "fs-app-token-error", res.status === 400 || res.status === 401 ? "error" : "warn", {
        status: res.status,
        body: body.slice(0, 200),
      });
      if (res.status === 400 || res.status === 401) {
        throw new FsOauthError(
          `app token: invalid client credentials (HTTP ${res.status})`,
          "fs_auth_failed",
        );
      }
      throw new FsOauthError(`app token failed: HTTP ${res.status}`, "fs_unavailable");
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new FsOauthError("app token response: missing access_token", "fs_unavailable");
    }
    cachedAppToken = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000,
    };
    log("oauth", "fs-app-token-issued", "info", { expires_in: json.expires_in ?? 86_400 });
    return cachedAppToken.token;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
