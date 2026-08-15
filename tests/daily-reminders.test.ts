// @ts-check
/**
 * Юнит-тесты выбора due-юзеров для напоминаний (§9; PHASE-4 §5.1–5.3, DoD §7):
 * pure-фильтры pickDueDaily / pickDueWorkout — fuzzy-окно в локальном времени,
 * dedup на вторую попытку в ту же локальную дату, битые слоты, слоты через
 * полночь, день недели workout-слота.
 *
 * DB-обёртки (due*) не тестируются здесь — им нужна БД (manual checklist).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { clearSentKeysForTests, markKeySent } from "../agent/lib/alert-dedup";
import {
  pickDueDaily,
  pickDueWorkout,
  type DailySlotRow,
  type WorkoutSlotRow,
} from "../agent/lib/daily-reminders";

const MSK = "Europe/Moscow";
// 2026-08-15T15:00:00Z = суббота 18:00 MSK.
const NOW = new Date("2026-08-15T15:00:00Z");

function dailyRow(slot: string | null, id = "u1"): DailySlotRow {
  return { id, telegramChatId: 111n, timezone: MSK, slot };
}

beforeEach(() => clearSentKeysForTests());

describe("pickDueDaily", () => {
  it("слот в окне → due; ключ (user, kind, local_date); слот нормализован без секунд", () => {
    const [t] = pickDueDaily([dailyRow("18:00:00")], "evening", NOW);
    expect(t).toMatchObject({
      userId: "u1",
      localDate: "2026-08-15",
      slotLocalTime: "18:00",
      dedupKey: "daily:evening:u1:2026-08-15",
    });
  });

  it("DoD: слот 18:15 срабатывает на тике 18:00; на 19:00 — уже нет", () => {
    expect(pickDueDaily([dailyRow("18:15")], "evening", NOW)).toHaveLength(1);
    expect(pickDueDaily([dailyRow("18:15")], "evening", new Date("2026-08-15T16:00:00Z"))).toHaveLength(0);
  });

  it("dedup: вторая выборка в ту же локальную дату — пусто; на следующий день — снова due", () => {
    const first = pickDueDaily([dailyRow("18:00")], "morning", NOW);
    expect(first).toHaveLength(1);
    markKeySent(first[0].dedupKey);
    expect(pickDueDaily([dailyRow("18:00")], "morning", NOW)).toHaveLength(0);
    // На сутки позже (2026-08-16T15:00Z) — ключ новой даты, снова due.
    expect(pickDueDaily([dailyRow("18:00")], "morning", new Date("2026-08-16T15:00:00Z"))).toHaveLength(1);
  });

  it("NULL-слот (напоминание отключено) и битый формат — молча пропускаются", () => {
    expect(pickDueDaily([dailyRow(null)], "morning", NOW)).toHaveLength(0);
    expect(pickDueDaily([dailyRow("bad")], "morning", NOW)).toHaveLength(0);
    expect(pickDueDaily([dailyRow("25:99")], "morning", NOW)).toHaveLength(0);
  });

  it("слот через полночь: 23:45 срабатывает на тике 00:05 (локальная дата — следующая)", () => {
    // 2026-08-15T21:05:00Z = 00:05 MSK 16-го; круговая дистанция до 23:45 — 20 мин.
    const [t] = pickDueDaily([dailyRow("23:45")], "evening", new Date("2026-08-15T21:05:00Z"));
    expect(t).toBeDefined();
    expect(t.localDate).toBe("2026-08-16");
  });

  it("разные tz: слот 08:00 MSK не срабатывает на тике, где в другом tz ещё не время", () => {
    // 05:00 UTC = 08:00 MSK (due) и 01:00 EDT (не due для слота 08:00).
    const rows: DailySlotRow[] = [
      { id: "msk", telegramChatId: 1n, timezone: MSK, slot: "08:00" },
      { id: "ny", telegramChatId: 2n, timezone: "America/New_York", slot: "08:00" },
    ];
    const due = pickDueDaily(rows, "morning", new Date("2026-08-15T05:00:00Z"));
    expect(due.map((t) => t.userId)).toEqual(["msk"]);
  });
});

describe("pickDueWorkout", () => {
  function workoutRow(workoutTimes: WorkoutSlotRow["workoutTimes"]): WorkoutSlotRow {
    return { id: "u1", telegramChatId: 111n, timezone: MSK, workoutTimes };
  }

  it("совпадение day_of_week (сб=6) и времени → due; ключ (user, dow, date)", () => {
    const [t] = pickDueWorkout([workoutRow([{ day_of_week: 6, local_time: "18:00" }])], NOW);
    expect(t).toMatchObject({
      userId: "u1",
      slotLocalTime: "18:00",
      dedupKey: "workout:u1:6:2026-08-15",
    });
  });

  it("другой день недели — не due (пт=5 при субботе)", () => {
    expect(pickDueWorkout([workoutRow([{ day_of_week: 5, local_time: "18:00" }])], NOW)).toHaveLength(0);
  });

  it("два слота в один день — ОДНО напоминание (первый по массиву)", () => {
    const due = pickDueWorkout(
      [workoutRow([{ day_of_week: 6, local_time: "18:00" }, { day_of_week: 6, local_time: "19:30" }])],
      new Date("2026-08-15T16:30:00Z"), // 19:30 MSK: второй слот в окне, первый (18:00) — нет
    );
    expect(due).toHaveLength(1);
    expect(due[0].slotLocalTime).toBe("19:30");
  });

  it("dedup по (user, dow, local_date): повторная выборка — пусто", () => {
    const first = pickDueWorkout([workoutRow([{ day_of_week: 6, local_time: "18:00" }])], NOW);
    markKeySent(first[0].dedupKey);
    expect(pickDueWorkout([workoutRow([{ day_of_week: 6, local_time: "18:00" }])], NOW)).toHaveLength(0);
  });

  it("битые элементы (формат времени / день вне 0–6) и null — молча пропускаются", () => {
    expect(
      pickDueWorkout([workoutRow([{ day_of_week: 6, local_time: "bad" }])], NOW),
    ).toHaveLength(0);
    expect(pickDueWorkout([workoutRow(null)], NOW)).toHaveLength(0);
    expect(pickDueWorkout([workoutRow([])], NOW)).toHaveLength(0);
  });
});
