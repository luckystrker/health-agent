// @ts-check
/**
 * Юнит-тесты userAuthFor (§9, PHASE-0 §6.3) — формат синтезированного principal'а
 * для proactive-сообщений из schedules.
 */
import { describe, expect, it } from "vitest";

import { userAuthFor } from "../agent/lib/user-auth";

describe("userAuthFor", () => {
  it("строит principal строго по контракту §9", () => {
    const auth = userAuthFor({ telegram_chat_id: 123456789n, user_id: "abc-uuid" });
    expect(auth).toEqual({
      authenticator: "telegram-webhook",
      principalId: "telegram:123456789",
      principalType: "user",
      attributes: { chat_id: "123456789", user_id: "abc-uuid" },
    });
  });

  it("стрингифицирует bigint chat_id в attributes.chat_id и principalId", () => {
    const auth = userAuthFor({ telegram_chat_id: 7n, user_id: "u1" });
    expect(auth.principalId).toBe("telegram:7");
    expect(auth.attributes.chat_id).toBe("7");
    expect(typeof auth.attributes.chat_id).toBe("string");
  });

  it("фиксирует authenticator и principalType литералами", () => {
    const auth = userAuthFor({ telegram_chat_id: 1n, user_id: "u" });
    // Литералы важны для requireUser (principalType === "user", authenticator === "telegram-webhook").
    expect(auth.authenticator).toBe("telegram-webhook");
    expect(auth.principalType).toBe("user");
  });
});
