// @ts-check
/**
 * Юнит-тесты tenant.ts: извлечение/проверка principal'а (§18.1, PHASE-0 §6.2).
 * Тестируются чистые функции (assertUserPrincipal/getChatId) без обращения к БД —
 * requireUser (с БД-лукапом) покрывается интеграционно в фазе верификации.
 */
import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  assertUserPrincipal,
  getChatId,
  type AuthContext,
} from "../agent/lib/tenant";

/** Минимальный ctx-constructor: только то, что читают функции. */
function ctxWithPrincipal(p: unknown): AuthContext {
  return {
    session: { auth: { current: p as AuthContext["session"]["auth"]["current"] } },
  };
}

const PRIVATE_USER = {
  principalType: "user",
  authenticator: "telegram-webhook",
  attributes: { chat_id: "123456789", chat_type: "private", user_id: "999" },
};

const SCHEDULE_APP = {
  principalType: "runtime",
  authenticator: "app",
  principalId: "eve:app",
  attributes: {},
};

describe("getChatId", () => {
  it("извлекает chat_id из приватного чата (строка)", () => {
    expect(getChatId(ctxWithPrincipal(PRIVATE_USER))).toBe("123456789");
  });

  it("возвращает null при отсутствии principal", () => {
    expect(getChatId(ctxWithPrincipal(null))).toBeNull();
  });

  it("возвращает null, если chat_id — массив (не строка)", () => {
    expect(
      getChatId(
        ctxWithPrincipal({
          principalType: "user",
          authenticator: "telegram-webhook",
          attributes: { chat_id: ["1", "2"] },
        }),
      ),
    ).toBeNull();
  });
});

describe("assertUserPrincipal", () => {
  it("возвращает chat_id для валидного приватного Telegram-пользователя", () => {
    expect(assertUserPrincipal(ctxWithPrincipal(PRIVATE_USER))).toBe("123456789");
  });

  it("бросает AuthenticationError при отсутствии principal", () => {
    expect(() => assertUserPrincipal(ctxWithPrincipal(null))).toThrow(AuthenticationError);
  });

  it("бросает для schedule/app principal (principalType=runtime)", () => {
    expect(() => assertUserPrincipal(ctxWithPrincipal(SCHEDULE_APP))).toThrow(AuthenticationError);
  });

  it("бросает, если principalType=user, но authenticator не telegram-webhook", () => {
    expect(() =>
      assertUserPrincipal(
        ctxWithPrincipal({
          principalType: "user",
          authenticator: "http",
          attributes: { chat_id: "1" },
        }),
      ),
    ).toThrow(AuthenticationError);
  });

  it("бросает, если authenticator верный, но principalType не user", () => {
    expect(() =>
      assertUserPrincipal(
        ctxWithPrincipal({
          principalType: "service",
          authenticator: "telegram-webhook",
          attributes: { chat_id: "1" },
        }),
      ),
    ).toThrow(AuthenticationError);
  });

  it("бросает, если chat_id — не строка", () => {
    expect(() =>
      assertUserPrincipal(
        ctxWithPrincipal({
          principalType: "user",
          authenticator: "telegram-webhook",
          attributes: { chat_id: 123 },
        }),
      ),
    ).toThrow(AuthenticationError);
  });
});
