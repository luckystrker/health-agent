// @ts-check
/**
 * Юнит-тесты telegram-send.ts (фаза 3, §16): форма multipart-запроса sendPhoto,
 * коды ошибок (403 forbidden без ретраев, 429 c respect retry_after и
 * экспоненциальным backoff, сеть → ретраи → network), парсер HTTP-статуса из
 * ошибок eve-канала. Fetch и sleep инжектируются — реальной сети нет.
 */
import { describe, expect, it, vi } from "vitest";

import {
  TelegramSendError,
  sendPhotoBytes,
  telegramHttpStatusFromError,
} from "../agent/lib/telegram-send";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** fetch-mock: последовательность ответов (или Error для сетевого сбоя). */
function mockFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra fetch call");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn, calls };
}

const noSleep = () => Promise.resolve();

describe("sendPhotoBytes", () => {
  it("200 → ok + message_id; multipart содержит chat_id, photo (image/png), caption", async () => {
    const { fn, calls } = mockFetch([jsonResponse(200, { ok: true, result: { message_id: 42 } })]);
    const r = await sendPhotoBytes({
      chatId: "123456",
      png: PNG,
      caption: "Сон за неделю",
      botToken: "TEST:TOKEN",
      fetchImpl: fn as unknown as typeof fetch,
      sleepFn: noSleep,
    });
    expect(r).toEqual({ ok: true, messageId: "42" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTEST:TOKEN/sendPhoto");
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chat_id")).toBe("123456");
    expect(form.get("caption")).toBe("Сон за неделю");
    const photo = form.get("photo");
    expect(photo).toBeInstanceOf(Blob);
    expect((photo as Blob).type).toBe("image/png");
  });

  it("без botToken → not_configured", async () => {
    await expect(
      sendPhotoBytes({ chatId: "1", png: PNG, botToken: undefined, fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch, sleepFn: noSleep }),
    ).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("403 → forbidden сразу, без ретраев", async () => {
    const { fn, calls } = mockFetch([jsonResponse(403, { ok: false, description: "Forbidden: bot was blocked by the user" })]);
    await expect(
      sendPhotoBytes({ chatId: "1", png: PNG, botToken: "T", fetchImpl: fn as unknown as typeof fetch, sleepFn: noSleep }),
    ).rejects.toMatchObject({ kind: "forbidden", status: 403 });
    expect(calls).toHaveLength(1);
  });

  it("429 → retry_after приоритетнее backoff; затем успех", async () => {
    const sleeps: number[] = [];
    const { fn, calls } = mockFetch([
      jsonResponse(429, { ok: false, parameters: { retry_after: 3 } }),
      jsonResponse(200, { ok: true, result: { message_id: 7 } }),
    ]);
    const r = await sendPhotoBytes({
      chatId: "1",
      png: PNG,
      botToken: "T",
      fetchImpl: fn as unknown as typeof fetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r.ok).toBe(true);
    expect(sleeps).toEqual([3000]); // retry_after=3с, не дефолтный 1с backoff
    expect(calls).toHaveLength(2);
  });

  it("429 без retry_after → экспоненциальный backoff 1с/2с/4с; исчерпание → rate_limited", async () => {
    const sleeps: number[] = [];
    const { fn, calls } = mockFetch([
      jsonResponse(429, { ok: false }),
      jsonResponse(429, { ok: false }),
      jsonResponse(429, { ok: false }),
      jsonResponse(429, { ok: false }),
    ]);
    await expect(
      sendPhotoBytes({
        chatId: "1",
        png: PNG,
        botToken: "T",
        fetchImpl: fn as unknown as typeof fetch,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toMatchObject({ kind: "rate_limited", status: 429 });
    expect(calls).toHaveLength(4); // maxAttempts=4
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("retry_after cap 15с", async () => {
    const sleeps: number[] = [];
    const { fn } = mockFetch([
      jsonResponse(429, { ok: false, parameters: { retry_after: 120 } }),
      jsonResponse(200, { ok: true, result: {} }),
    ]);
    await sendPhotoBytes({
      chatId: "1",
      png: PNG,
      botToken: "T",
      fetchImpl: fn as unknown as typeof fetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([15_000]);
  });

  it("сетевой сбой → ретраи → network", async () => {
    const { fn, calls } = mockFetch([new Error("ECONNRESET"), new Error("timeout"), new Error("x"), new Error("y")]);
    await expect(
      sendPhotoBytes({ chatId: "1", png: PNG, botToken: "T", fetchImpl: fn as unknown as typeof fetch, sleepFn: noSleep }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(calls).toHaveLength(4);
  });

  it("5xx → ретраебельно, затем network; 4xx (не 403/429) — сразу api_error", async () => {
    const fiveHundred = mockFetch([jsonResponse(500, { ok: false }), new Error("stop")]);
    await expect(
      sendPhotoBytes({ chatId: "1", png: PNG, botToken: "T", fetchImpl: fiveHundred.fn as unknown as typeof fetch, sleepFn: noSleep }),
    ).rejects.toMatchObject({ kind: "network" });

    const badRequest = mockFetch([jsonResponse(400, { ok: false, description: "Bad Request" })]);
    await expect(
      sendPhotoBytes({ chatId: "1", png: PNG, botToken: "T", fetchImpl: badRequest.fn as unknown as typeof fetch, sleepFn: noSleep }),
    ).rejects.toMatchObject({ kind: "api_error", status: 400 });
    expect(badRequest.calls).toHaveLength(1);
  });

  it("тело ответа не-JSON на 200 — не ошибка", async () => {
    const plain = new Response("not json", { status: 200 });
    const { fn } = mockFetch([plain]);
    const r = await sendPhotoBytes({
      chatId: "1",
      png: PNG,
      botToken: "T",
      fetchImpl: fn as unknown as typeof fetch,
      sleepFn: noSleep,
    });
    expect(r).toEqual({ ok: true, messageId: null });
  });
});

describe("TelegramSendError", () => {
  it("kind/status в экземпляре", () => {
    const e = new TelegramSendError("forbidden", 403);
    expect(e.kind).toBe("forbidden");
    expect(e.status).toBe(403);
    expect(e.message).toContain("forbidden");
  });
});

describe("telegramHttpStatusFromError", () => {
  it("парсит eve-ошибку отправки (HTTP 403.)", () => {
    expect(telegramHttpStatusFromError(new Error("Telegram sendMessage failed with HTTP 403."))).toBe(403);
    expect(telegramHttpStatusFromError(new Error("Telegram sendMessage failed with HTTP 429."))).toBe(429);
  });

  it("прочие ошибки → null", () => {
    expect(telegramHttpStatusFromError(new Error("some other error"))).toBeNull();
    expect(telegramHttpStatusFromError("string error")).toBeNull();
    expect(telegramHttpStatusFromError(undefined)).toBeNull();
  });
});
