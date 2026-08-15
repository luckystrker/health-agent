// @ts-check
/**
 * Прямая отправка PNG-графиков в Telegram через Bot API `sendPhoto` (фаза 3, §8/§16).
 *
 * Почему прямой fetch, а не eve-хендл: eve не экспонирует telegram-хендл в
 * `ToolContext` (tools видят только `session`), а исходящие вложения в
 * message-stream не поддерживаются; JSON-хелпер eve (`callTelegramApi`) не
 * принимает бинарные тела. Node 24 имеет нативные `FormData`/`Blob` — multipart
 * собирается без зависимостей. Токен — существующий `TELEGRAM_BOT_TOKEN`,
 * chat_id — из `requireUser` (никогда не от модели).
 *
 * Обработка ошибок (§16): 429 — экспоненциальный backoff c respect
 * `parameters.retry_after`; 403 — `forbidden` (вызывающий помечает
 * `users.blocked`); сеть/5xx — retry, затем `network`. Технические детали — в
 * логи, юзеру — friendly-сообщение от tool'а.
 */
import { env } from "./env";
import { log } from "./log";

export type TelegramSendErrorKind =
  | "not_configured" // нет TELEGRAM_BOT_TOKEN
  | "forbidden" // HTTP 403 — юзер заблокировал бота
  | "rate_limited" // 429 после исчерпания ретраев
  | "network" // сеть/таймаут после ретраев
  | "api_error"; // прочие не-OK ответы Telegram

export class TelegramSendError extends Error {
  readonly kind: TelegramSendErrorKind;
  readonly status?: number;

  constructor(kind: TelegramSendErrorKind, status?: number) {
    super(`telegram send failed: ${kind}${status != null ? ` (HTTP ${status})` : ""}`);
    this.name = "TelegramSendError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * HTTP-статус из ошибки eve-канала. `sendTelegramMessage` бросает
 * `Error("Telegram sendMessage failed with HTTP 403.")` — статус надёжно
 * достаётся только из текста; это единственное место, где мы на него полагаемся
 * (для 403-детекта в channel-override).
 */
export function telegramHttpStatusFromError(e: unknown): number | null {
  if (!(e instanceof Error)) return null;
  const m = /HTTP (\d{3})\b/.exec(e.message);
  return m ? Number(m[1]) : null;
}

export interface SendPhotoInput {
  readonly chatId: string;
  readonly png: Uint8Array;
  readonly caption?: string;
  /** Для unit-тестов (по умолчанию глобальный fetch). */
  readonly fetchImpl?: typeof fetch;
  /** Для unit-тестов: инжектированный sleep (по умолчанию setTimeout). */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /** Токен бота (по умолчанию env.TELEGRAM_BOT_TOKEN; для тестов). */
  readonly botToken?: string;
  /** Всего попыток, включая первую (по умолчанию 4). */
  readonly maxAttempts?: number;
}

/** Cap на ожидание между ретраями (даже если Telegram прислал больше). */
const RETRY_AFTER_CAP_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Отправить PNG фото в чат `chatId` через `sendPhoto` (multipart/form-data).
 * Возвращает `{ ok: true, messageId }`. Бросает `TelegramSendError`.
 */
export async function sendPhotoBytes(input: SendPhotoInput): Promise<{
  ok: true;
  messageId: string | null;
}> {
  const botToken = input.botToken ?? env.telegramBotToken;
  if (!botToken) throw new TelegramSendError("not_configured");

  const maxAttempts = input.maxAttempts ?? 4;
  const doFetch = input.fetchImpl ?? fetch;
  const sleep = input.sleepFn ?? defaultSleep;

  let lastKind: TelegramSendErrorKind = "api_error";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // FormData/Blob собираются на каждую попытку: тело одноразовое (stream).
    const form = new FormData();
    form.set("chat_id", input.chatId);
    form.set("photo", new Blob([input.png], { type: "image/png" }), "chart.png");
    if (input.caption != null && input.caption.length > 0) {
      form.set("caption", input.caption);
    }

    let res: Response;
    try {
      res = await doFetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: "POST",
        body: form,
      });
    } catch (e) {
      // Сеть/таймаут — ретраебельно.
      lastKind = "network";
      log("tool", "telegram-send-network", "warn", {
        chat_id: input.chatId,
        attempt,
        error: e instanceof Error ? e.message : String(e),
      });
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      break;
    }

    if (res.ok) {
      let messageId: string | null = null;
      try {
        const body = (await res.json()) as {
          result?: { message_id?: number | string };
        };
        messageId =
          body.result?.message_id != null ? String(body.result.message_id) : null;
      } catch {
        // тело не JSON — фото отправлено, id недоступен (не критично)
      }
      return { ok: true, messageId };
    }

    lastStatus = res.status;
    if (res.status === 403) {
      // Юзер заблокировал бота — ретраи бессмысленны.
      throw new TelegramSendError("forbidden", 403);
    }

    if (res.status === 429) {
      lastKind = "rate_limited";
      const retryAfterMs = await parseRetryAfterMs(res);
      const delay = Math.min(retryAfterMs ?? backoffMs(attempt), RETRY_AFTER_CAP_MS);
      log("tool", "telegram-send-429", "warn", {
        chat_id: input.chatId,
        attempt,
        delay_ms: delay,
        retry_after_ms: retryAfterMs ?? null,
      });
      if (attempt < maxAttempts) {
        await sleep(delay);
        continue;
      }
      break;
    }

    if (res.status >= 500) {
      lastKind = "network"; // серверная деградация Telegram — ретраебельно
      log("tool", "telegram-send-5xx", "warn", { chat_id: input.chatId, attempt, status: res.status });
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      break;
    }

    // Прочие 4xx — постоянная ошибка запроса, ретраи не помогут.
    lastKind = "api_error";
    log("tool", "telegram-send-api-error", "warn", {
      chat_id: input.chatId,
      status: res.status,
    });
    break;
  }

  throw new TelegramSendError(lastKind, lastStatus);
}

/** Экспоненциальный backoff: 1с, 2с, 4с… */
function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

/** `parameters.retry_after` (секунды) → ms; null, если тела/параметра нет. */
async function parseRetryAfterMs(res: Response): Promise<number | null> {
  try {
    const body = (await res.json()) as { parameters?: { retry_after?: number } };
    const ra = body.parameters?.retry_after;
    return typeof ra === "number" && ra > 0 ? ra * 1000 : null;
  } catch {
    return null;
  }
}
