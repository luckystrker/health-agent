// @ts-check
/**
 * Идентификация юзера (§7, §12.6).
 *
 * `requireUser(ctx)` — ОБЯЗАТЕЛЬНО во всех БД-tools. `user_id` берётся из сессии
 * (через ре-лукап в БД по `chat_id`), НИКОГДА не передаётся моделью.
 *
 * Контракт principal'а (§7): для приватного Telegram-чата eve формирует
 *   principalId = "telegram:" + from.id, authenticator = "telegram-webhook",
 *   principalType = "user", attributes.chat_id = String(chat.id).
 *
 * `requireUser` НЕ доверяет `attributes.user_id` (синтезированный principal может
 * его подсовывать) — всегда ре-лукап `user_id` из БД по `telegram_chat_id`.
 */
import { eq } from "drizzle-orm";

import { db } from "./db/client";
import { users } from "./db/schema";

/** Минимальный структурный тип для чтения principal'а (совместим с eve SessionContext). */
export interface AuthContext {
  readonly session: {
    readonly auth: {
      readonly current: {
        readonly principalType: string;
        readonly authenticator: string;
        readonly attributes: Readonly<Record<string, string | readonly string[]>>;
      } | null;
    };
  };
}

export class AuthenticationError extends Error {
  constructor(message = "authenticated user required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** chat_id из principal'а или null (без throw). */
export function getChatId(ctx: AuthContext): string | null {
  const current = ctx.session.auth.current;
  if (!current) return null;
  const chatId = current.attributes.chat_id;
  return typeof chatId === "string" ? chatId : null;
}

/**
 * Синхронная проверка principal'а: возвращает `chat_id`, если principal —
 * валидный Telegram user. Иначе бросает `AuthenticationError`.
 * (Чистая функция от ctx — unit-тестируется без БД.)
 */
export function assertUserPrincipal(ctx: AuthContext): string {
  const current = ctx.session.auth.current;
  if (!current) throw new AuthenticationError();
  if (current.principalType !== "user" || current.authenticator !== "telegram-webhook") {
    throw new AuthenticationError();
  }
  const chatId = current.attributes.chat_id;
  if (typeof chatId !== "string") throw new AuthenticationError();
  return chatId;
}

/** { userId, chatId } текущего юзера (ре-лукап user_id из БД по chat_id). */
export async function requireUser(ctx: AuthContext): Promise<{ userId: string; chatId: string }> {
  const chatId = assertUserPrincipal(ctx);
  const row = await db.query.users.findFirst({
    where: eq(users.telegramChatId, BigInt(chatId)),
  });
  if (!row) throw new AuthenticationError();
  return { userId: row.id, chatId };
}

/**
 * Создаёт user-row для chat_id, если её ещё нет (первый `/start` от allowlist-юзера).
 * Дефолтный tz — Europe/Moscow (§10 шаг 3; уточняется на онбординге).
 *
 * Atomic к гонке: Telegram шлёт webhook-обновления конкурентно, поэтому обычный
 * findFirst→insert падал бы на unique(user_id) у второго. Используем
 * `onConflictDoNothing().returning()`; если строка уже была — возвращается [],
 * и мы делаем повторный select.
 *
 * @returns `{ userId, onboarded }`.
 */
export async function ensureUserByChatId(chatId: string): Promise<{
  userId: string;
  onboarded: boolean;
}> {
  const telegramChatId = BigInt(chatId);

  // Попытка вставки; onConflictDoNothing по unique(telegram_chat_id) спасает от гонки.
  const inserted = await db
    .insert(users)
    .values({
      telegramChatId,
      timezone: "Europe/Moscow", // default; переопределяется set-tz / шагом 3 онбординга
    })
    .onConflictDoNothing()
    .returning({ id: users.id, onboardedAt: users.onboardedAt });

  if (inserted.length > 0) {
    return { userId: inserted[0].id, onboarded: inserted[0].onboardedAt !== null };
  }

  // Конфликт — строка уже существовала (создана параллельным запросом). Читаем её.
  const existing = await db.query.users.findFirst({
    where: eq(users.telegramChatId, telegramChatId),
  });
  // existing всегда есть (конфликт был именно по этой строке); guard на всякий случай.
  if (!existing) throw new Error("user row vanished after upsert conflict");
  return { userId: existing.id, onboarded: existing.onboardedAt !== null };
}
