// @ts-check
/**
 * Юнит-тесты in-memory dedup/rate-limit (§9 п.3, §11.5; PHASE-4 §5.1):
 * формат ключей, подавление повтора в ту же локальную дату, прун старых ключей.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  anomalyAlertKey,
  clearSentKeysForTests,
  dailyReminderKey,
  keyAlreadySent,
  markKeySent,
  pruneSentKeysOlderThan,
  pruneStaleSentKeys,
  workoutReminderKey,
} from "../agent/lib/alert-dedup";

describe("ключи", () => {
  it("daily-ключ: (user, kind, local_date)", () => {
    expect(dailyReminderKey("u1", "morning", "2026-08-15")).toBe("daily:morning:u1:2026-08-15");
    expect(dailyReminderKey("u1", "evening", "2026-08-16")).not.toBe(
      dailyReminderKey("u1", "evening", "2026-08-15"),
    );
  });

  it("workout-ключ: (user, day_of_week, local_date)", () => {
    expect(workoutReminderKey("u1", 6, "2026-08-15")).toBe("workout:u1:6:2026-08-15");
  });

  it("anomaly-ключ (rate-limit): (user, type, local_date)", () => {
    expect(anomalyAlertKey("u1", "sleep_duration", "2026-08-15")).toBe(
      "anomaly:sleep_duration:u1:2026-08-15",
    );
  });
});

describe("dedup", () => {
  beforeEach(() => clearSentKeysForTests());

  it("не отправлен → помечен → подавлен повтор в ту же дату", () => {
    const key = dailyReminderKey("u1", "midday", "2026-08-15");
    expect(keyAlreadySent(key)).toBe(false);
    markKeySent(key);
    expect(keyAlreadySent(key)).toBe(true);
  });

  it("другая локальная дата / другой kind / другой type — НЕ подавлены", () => {
    markKeySent(dailyReminderKey("u1", "midday", "2026-08-15"));
    expect(keyAlreadySent(dailyReminderKey("u1", "midday", "2026-08-16"))).toBe(false);
    expect(keyAlreadySent(dailyReminderKey("u1", "morning", "2026-08-15"))).toBe(false);
    expect(keyAlreadySent(dailyReminderKey("u2", "midday", "2026-08-15"))).toBe(false);

    markKeySent(anomalyAlertKey("u1", "calories_over", "2026-08-15"));
    expect(keyAlreadySent(anomalyAlertKey("u1", "steps_low", "2026-08-15"))).toBe(false);
  });
});

describe("prune (защита от роста на длинном аптайме)", () => {
  beforeEach(() => clearSentKeysForTests());

  it("удаляет ключи с датой раньше cutoff, свежие оставляет", () => {
    markKeySent(dailyReminderKey("u1", "morning", "2026-08-10"));
    markKeySent(dailyReminderKey("u1", "morning", "2026-08-15"));
    markKeySent(anomalyAlertKey("u2", "steps_low", "2026-08-09"));
    const removed = pruneSentKeysOlderThan("2026-08-14");
    expect(removed).toBe(2);
    expect(keyAlreadySent(dailyReminderKey("u1", "morning", "2026-08-15"))).toBe(true);
    expect(keyAlreadySent(dailyReminderKey("u1", "morning", "2026-08-10"))).toBe(false);
  });

  it("pruneStaleSentKeys держит запас на локальные даты (+1 сутки, review P2)", () => {
    // 23:30 UTC 15-го: в Moscow уже 16-е — ключи «2026-08-16» свежие локально.
    // Cutoff = UTC − (2+1) дней = 2026-08-12: ключи 13–16-го должны выжить.
    const now = new Date("2026-08-15T23:30:00Z");
    markKeySent(dailyReminderKey("msk", "evening", "2026-08-16")); // локально «сегодня»
    markKeySent(dailyReminderKey("utc", "evening", "2026-08-13")); // старее keep, но в запасе
    markKeySent(dailyReminderKey("old", "evening", "2026-08-11")); // устарел с запасом
    const removed = pruneStaleSentKeys(now);
    expect(removed).toBe(1);
    expect(keyAlreadySent(dailyReminderKey("msk", "evening", "2026-08-16"))).toBe(true);
    expect(keyAlreadySent(dailyReminderKey("utc", "evening", "2026-08-13"))).toBe(true);
    expect(keyAlreadySent(dailyReminderKey("old", "evening", "2026-08-11"))).toBe(false);
  });
});
