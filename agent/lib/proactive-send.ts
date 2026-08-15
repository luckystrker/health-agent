// @ts-check
/**
 * Отправка proactive-сообщения из schedule с 429-backoff (§16; PHASE-4 §5.5).
 *
 * Доставка текста идёт через eve-канал (`to(telegram).send` → message.completed →
 * `channel.telegram.post`), у которого нет своих ретраев (фаза 3). На v1-масштабе
 * (family-of-2) rate-limit почти недостижим, но почасовые джобы фазы 4 могут
 * совпасть — поэтому здесь: 429 → экспоненциальный backoff (1с/2с, ≤3 попыток),
 * warn-лог; 403 НЕ ретраится и НЕ логируется как ошибка — канал сам помечает
 * `users.blocked` и гасит ошибку (agent/channels/telegram.ts, фаза 3); прочие
 * сбои — warn-лог без ретрая ( следующий тик повторит, dedup ещё не поставлен ).
 */
import { log } from "./log";
import { telegramHttpStatusFromError } from "./telegram-send";

export const PROACTIVE_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SendRetryOptions {
  /** Всего попыток, включая первую (по умолчанию 3). */
  maxAttempts?: number;
  /** Инжектированный sleep (для unit-тестов). */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Прогнать отправку с ретраями на 429. `send` — замыкание вызова
 * `to(channel, {chatId}).send(prompt, {auth})`. Возвращает true при успехе
 * (доставка запущена/завершена), false — доставка не удалась.
 */
export async function sendProactiveWithRetry(
  scheduleName: string,
  userId: string,
  send: () => Promise<unknown>,
  opts: SendRetryOptions = {},
): Promise<boolean> {
  const maxAttempts = opts.maxAttempts ?? PROACTIVE_MAX_ATTEMPTS;
  const sleep = opts.sleepFn ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await send();
      return true;
    } catch (e) {
      const status = telegramHttpStatusFromError(e);
      const error = e instanceof Error ? e.message : String(e);
      if (status === 429 && attempt < maxAttempts) {
        const delay = BACKOFF_BASE_MS * 2 ** (attempt - 1);
        log("schedule", `${scheduleName}-429-backoff`, "warn", {
          user_id: userId,
          attempt,
          delay_ms: delay,
        });
        await sleep(delay);
        continue;
      }
      // 403 обработан channel-override (users.blocked); здесь — только лог.
      log("schedule", `${scheduleName}-send-error`, "warn", {
        user_id: userId,
        attempt,
        http_status: status,
        error,
      });
      return false;
    }
  }
  return false;
}
