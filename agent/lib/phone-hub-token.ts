// @ts-check
/**
 * Токены forwarder'ов phone-hub (§6.1, §13).
 *
 * Платформа хранит ТОЛЬКО хэш токена: `SHA-256(PHONE_HUB_TOKEN_SALT + token)`
 * (соль — в env `PHONE_HUB_TOKEN_SALT`). Plaintext-токен видит юзер один раз при
 * выдаче/ротации (`rotate-phone-hub-token`) и вписывает в forwarder-приложение.
 *
 * Проверка входящего Bearer-токена в webhook'е: хэшируем полученное значение и
 * ищем `token_hash` в `phone_hub_tokens`. Сравнение хэшей — constant-time
 * (defense-in-depth поверх index-lookup по PK; §13 требует именно constant-time).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Длина SHA-256 hex = 64 символа. Нужно для guard'а в constant-time compare. */
const SHA256_HEX_LEN = 64;

/**
 * Сгенерировать новый случайный токен forwarder'а.
 * 32 байта энтропии в base64url (43 символа, URL-safe — безопасно класть в заголовок
 * и в URL/инструкцию без кодирования).
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Хэш токена для хранения/поиска: `SHA-256(salt + token)` (hex).
 * Соль обязательна — без неё функция бросает (защита от случайного запуска без env).
 */
export function hashToken(token: string, salt: string): string {
  if (!salt) throw new Error("PHONE_HUB_TOKEN_SALT is required to hash tokens");
  return createHash("sha256").update(salt + token).digest("hex");
}

/**
 * Constant-time сравнение двух hex-хэшей (§13).
 * Разная длина → false (без утечки через ранний выход). `timingSafeEqual` требует
 * равные длины буферов, поэтому guard обязателен.
 */
export function constantTimeHashEqual(a: string, b: string): boolean {
  if (a.length !== SHA256_HEX_LEN || b.length !== SHA256_HEX_LEN) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}
