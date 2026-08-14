// @ts-check
/**
 * Юнит-тесты fatsecret-oauth.ts (§6.2, §13, §18.1; PHASE-2 §8).
 *
 * Главный вектор — пример из RFC 5849 §3.4.1.1 (base string, посимвольно) +
 * подпись HMAC-SHA1 по verified-эррате 2550 (в самом RFC пример посчитан как
 * GET; корректная POST-подпись — r6/TJjbCOr97/+UU0NsvSne7s5g=, ключ
 * "j49sk3j29djd&dh893hdasih9").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

import {
  FsOauthError,
  getAppToken,
  getPendingFlow,
  hmacSha1Signature,
  normalizeBaseUrl,
  peekAppToken,
  percentEncode,
  resetAppTokenCache,
  setAppTokenCacheForTests,
  setPendingFlow,
  clearPendingFlow,
  signatureBaseString,
  signOauth1,
} from "../agent/lib/fatsecret-oauth";

describe("percentEncode (RFC 3986)", () => {
  it("кодирует sub-delims !'()* и пробел как %20 (не +)", () => {
    expect(percentEncode("!'()*")).toBe("%21%27%28%29%2A");
    expect(percentEncode("r b")).toBe("r%20b");
  });

  it("не трогает unreserved: ALNUM - . _ ~", () => {
    expect(percentEncode("AZaz09-._~")).toBe("AZaz09-._~");
  });

  it("кодирует = & / @ и прочие reserved", () => {
    expect(percentEncode("=%3D")).toBe("%3D%253D");
    expect(percentEncode("a3/ qw=&=")).toBe("a3%2F%20qw%3D%26%3D");
    expect(percentEncode("c@")).toBe("c%40");
  });

  it("юникод — UTF-8 байты", () => {
    expect(percentEncode("к")).toBe("%D0%BA");
  });
});

describe("normalizeBaseUrl (RFC 5849 §3.4.1.2)", () => {
  it("lower-case схема/хост, query отбрасывается", () => {
    expect(normalizeBaseUrl("HTTPS://Example.COM:443/request?a=1")).toBe("https://example.com/request");
  });

  it("нестандартный порт сохраняется, дефолтный 80 опускается", () => {
    expect(normalizeBaseUrl("http://example.com:8080/x")).toBe("http://example.com:8080/x");
    expect(normalizeBaseUrl("http://example.com:80/x")).toBe("http://example.com/x");
  });
});

describe("signatureBaseString — вектор RFC 5849 §3.4.1.1", () => {
  // Запрос из §3.1/§3.4.1.1: POST http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b
  // с телом "c2&a3=2+q" и oauth-параметрами (без oauth_version).
  const params: [string, string][] = [
    ["b5", "=%3D"],
    ["a3", "a"],
    ["c@", ""],
    ["a2", "r b"],
    ["c2", ""],
    ["a3", "2 q"],
    ["oauth_consumer_key", "9djdj82h48djs9d2"],
    ["oauth_token", "kkk9d7dh3k39sjv7"],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", "137131201"],
    ["oauth_nonce", "7d8f3e4a"],
  ];

  const expectedBase =
    "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q" +
    "%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_" +
    "key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_m" +
    "ethod%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk" +
    "9d7dh3k39sjv7";

  it("воспроизводит base string посимвольно (сортировка, дубль-ключи, кодирование)", () => {
    expect(signatureBaseString("POST", "http://example.com/request", params)).toBe(expectedBase);
  });

  it("метод uppercase, URL нормализуется (порт/регистр)", () => {
    expect(signatureBaseString("post", "HTTP://Example.com:80/request", params)).toBe(expectedBase);
  });
});

describe("hmacSha1Signature — вектор RFC 5849 + Erratum 2550", () => {
  const base = signatureBaseString("POST", "http://example.com/request", [
    ["b5", "=%3D"],
    ["a3", "a"],
    ["c@", ""],
    ["a2", "r b"],
    ["c2", ""],
    ["a3", "2 q"],
    ["oauth_consumer_key", "9djdj82h48djs9d2"],
    ["oauth_token", "kkk9d7dh3k39sjv7"],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", "137131201"],
    ["oauth_nonce", "7d8f3e4a"],
  ]);

  it("подпись = r6/TJjbCOr97/+UU0NsvSne7s5g= (ключ consumer&token)", () => {
    // Verified-эррата 2550: RFC напечатал подпись для GET; корректная для POST — эта.
    expect(hmacSha1Signature(base, "j49sk3j29djd", "dh893hdasih9")).toBe(
      "r6/TJjbCOr97/+UU0NsvSne7s5g=",
    );
  });

  it("пустой token_secret → хвостовой & в ключе (шаг request_token)", () => {
    // Прямой пересчёт node:crypto — независимая проверка конкатенации ключа.
    const direct = createHmac("sha1", "secret&").update("x", "utf8").digest("base64");
    expect(hmacSha1Signature("x", "secret", "")).toBe(direct);
  });
});

describe("signOauth1 — Authorization-заголовок", () => {
  it("содержит все oauth-параметры и подпись, значения в кавычках", () => {
    const { authorization } = signOauth1(
      "POST",
      "https://platform.fatsecret.com/rest/server.api",
      { consumerKey: "key", consumerSecret: "sec", token: "tok", tokenSecret: "tsec" },
      { method: "food_entries.get", format: "json" },
    );
    expect(authorization.startsWith("OAuth ")).toBe(true);
    expect(authorization).toContain('oauth_consumer_key="key"');
    expect(authorization).toContain('oauth_token="tok"');
    expect(authorization).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(authorization).toContain('oauth_version="1.0"');
    expect(authorization).toMatch(/oauth_signature="[^"]+"/);
    expect(authorization).toContain('oauth_nonce="');
    expect(authorization).toContain('oauth_timestamp="');
    // Тело запроса в заголовок не попадает (подписывается, не отправляется как oauth_*).
    expect(authorization).not.toContain("food_entries");
  });
});

describe("pending PIN-flow (TTL)", () => {
  afterEach(() => clearPendingFlow("u1"));

  it("живой флоу читается, протухший — нет", () => {
    setPendingFlow("u1", {
      requestToken: "rt",
      requestTokenSecret: "rts",
      expiresAt: Date.now() + 60_000,
    });
    expect(getPendingFlow("u1")?.requestToken).toBe("rt");

    setPendingFlow("u1", {
      requestToken: "rt2",
      requestTokenSecret: "rts2",
      expiresAt: Date.now() - 1,
    });
    expect(getPendingFlow("u1")).toBeNull();
  });
});

describe("app-токен: окно refresh за ~1ч до истечения", () => {
  afterEach(() => resetAppTokenCache());

  it("токен жив, если до истечения > 1ч; рефрешится, если меньше", () => {
    const now = Date.now();
    setAppTokenCacheForTests("tok-long", now + 2 * 3_600_000);
    expect(peekAppToken(now)).toBe("tok-long");

    setAppTokenCacheForTests("tok-short", now + 3_600_000); // ровно 1ч → уже рефреш
    expect(peekAppToken(now)).toBeNull();

    setAppTokenCacheForTests("tok-expired", now - 1);
    expect(peekAppToken(now)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAppToken: таймаут на fetch + классификация ошибок (review фазы 2, P1)
// ─────────────────────────────────────────────────────────────────────────────

describe("getAppToken: классификация ошибок (fetch-mock)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAppTokenCache();
  });

  it("успех: Bearer-запрос с таймаут-сигналом, токен кэшируется", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 86_400 }), { status: 200 });
      }),
    );

    const token = await getAppToken();
    expect(token).toBe("tok");
    expect(peekAppToken()).toBe("tok"); // закэширован
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oauth.fatsecret.com/connect/token");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal); // P1: таймаут обязателен
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization.startsWith("Basic ")).toBe(true); // test-key:test-secret из env
    expect(String(calls[0].init.body)).toBe("grant_type=client_credentials&scope=basic");
  });

  it("400/401 → fs_auth_failed (ключи отвергнуты), НЕ 'не настроено'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"invalid_client"}', { status: 401 })),
    );
    await expect(getAppToken()).rejects.toMatchObject({
      code: "fs_auth_failed",
    });
    expect(peekAppToken()).toBeNull(); // кэш не poisoned
  });

  it("5xx → fs_unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    await expect(getAppToken()).rejects.toMatchObject({ code: "fs_unavailable" });
  });

  it("сетевой сбой/таймаут → FsOauthError fs_unavailable (не сырой TypeError)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(getAppToken()).rejects.toBeInstanceOf(FsOauthError);
    await expect(getAppToken()).rejects.toMatchObject({ code: "fs_unavailable" });
  });
});
