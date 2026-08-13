// @ts-check
/**
 * Юнит-тесты phone-hub-token.ts: генерация/хэширование/constant-time compare (§13, §18.1).
 */
import { describe, expect, it } from "vitest";

import { constantTimeHashEqual, generateToken, hashToken } from "../agent/lib/phone-hub-token";

const SALT = "test-salt-very-secret";

describe("generateToken", () => {
  it("возвращает base64url-строку длиной 43 (32 байта)", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("каждый вызов даёт новый токен", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("hashToken", () => {
  it("детерминирован для (token, salt)", () => {
    expect(hashToken("abc", SALT)).toBe(hashToken("abc", SALT));
  });

  it("разные токены → разные хэши", () => {
    expect(hashToken("abc", SALT)).not.toBe(hashToken("abd", SALT));
  });

  it("разная соль → разные хэши", () => {
    expect(hashToken("abc", SALT)).not.toBe(hashToken("abc", "other-salt"));
  });

  it("возвращает 64 hex-символа (SHA-256)", () => {
    expect(hashToken("abc", SALT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("бросает без соли", () => {
    expect(() => hashToken("abc", "")).toThrow();
  });
});

describe("constantTimeHashEqual", () => {
  it("равные хэши → true", () => {
    const h = hashToken("abc", SALT);
    expect(constantTimeHashEqual(h, h)).toBe(true);
  });

  it("разные хэши → false", () => {
    const a = hashToken("abc", SALT);
    const b = hashToken("abd", SALT);
    expect(constantTimeHashEqual(a, b)).toBe(false);
  });

  it("неправильная длина → false (без throw)", () => {
    expect(constantTimeHashEqual("short", hashToken("abc", SALT))).toBe(false);
    expect(constantTimeHashEqual(hashToken("abc", SALT), "short")).toBe(false);
  });
});
