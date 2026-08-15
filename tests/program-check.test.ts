// @ts-check
/**
 * Юнит-тесты триггера адаптации program-check (§11.4; PHASE-5 §5.5):
 * окно 7 дней, детект незалогированных сессий / просроченных pending /
 * ≥2 skipped+partial, guard «программы ещё не было», блок фактов и промпт.
 */
import { describe, expect, it } from "vitest";

import {
  analyzeProgram,
  buildProgramCheckPrompt,
  programFactsBlock,
  programWindowDays,
  type ProgramFacts,
  type ProgramLogRow,
} from "../agent/lib/program-check";

/** 2026-08-15 — суббота; окно: 2026-08-08 … 2026-08-15. */
const TODAY = "2026-08-15";

function log(id: number, day: string, status: string, notes: string | null = null): ProgramLogRow {
  return { id, scheduledDay: day, status, notes };
}

function facts(over: Partial<ProgramFacts> = {}): ProgramFacts {
  return {
    tz: "Europe/Moscow",
    localDate: TODAY,
    programVersion: 1,
    goalKind: "weight_loss",
    frequencyPerWeek: 3,
    programStartedDay: "2026-08-01",
    sessionsByDow: {
      1: [{ exercise_name_en: "Bench Press", sets: 4, reps: "8-12" }],
      3: [{ exercise_name_en: "Squat", sets: 4, reps: "8-12" }],
      5: [{ exercise_name_en: "Deadlift", sets: 3, reps: "5" }],
    },
    logs: [],
    ...over,
  };
}

describe("programWindowDays", () => {
  it("8 дней: [сегодня-7 … сегодня]", () => {
    expect(programWindowDays("2026-08-15")).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
    ]);
  });
  it("переход через месяц", () => {
    expect(programWindowDays("2026-03-02")[0]).toBe("2026-02-23");
  });
});

describe("analyzeProgram — незалогированные сессии", () => {
  it("дни программы без лога → unloggedDays + triggered", () => {
    // Пн 08-10, Ср 08-12, Пт 08-14 — все без отметок.
    const a = analyzeProgram(facts());
    expect(a.unloggedDays.map((d) => d.day)).toEqual(["2026-08-10", "2026-08-12", "2026-08-14"]);
    expect(a.unloggedDays[0]).toMatchObject({ day_of_week: 1, exercises: 1 });
    expect(a.triggered).toBe(true);
    expect(a.reasons.join(" ")).toContain("незалогированных сессий за 7 дней: 3");
  });

  it("любой лог по дню (даже rescheduled) снимает «не отмечен»", () => {
    const a = analyzeProgram(
      facts({
        logs: [
          log(1, "2026-08-10", "completed"),
          log(2, "2026-08-12", "rescheduled"),
          log(3, "2026-08-14", "skipped"),
        ],
      }),
    );
    expect(a.unloggedDays).toEqual([]);
    expect(a.skipped).toBe(1);
    expect(a.triggered).toBe(false); // 1 skipped < 2
  });

  it("guard: дни ДО создания активной версии не ждём", () => {
    const a = analyzeProgram(facts({ programStartedDay: "2026-08-13" }));
    // 08-14 (пт) — единственный день программы в окне после старта.
    expect(a.unloggedDays.map((d) => d.day)).toEqual(["2026-08-14"]);
  });
});

describe("analyzeProgram — skipped/partial и pending", () => {
  it("≥2 skipped+partial за 7 дней → triggered", () => {
    const a = analyzeProgram(
      facts({
        logs: [
          log(1, "2026-08-10", "completed"),
          log(2, "2026-08-12", "partial"),
          log(3, "2026-08-14", "skipped"),
        ],
      }),
    );
    expect(a.unloggedDays).toEqual([]);
    expect(a.partial).toBe(1);
    expect(a.skipped).toBe(1);
    expect(a.triggered).toBe(true);
    expect(a.reasons.join(" ")).toContain("skipped+partial за 7 дней: 2");
  });

  it("ровно 1 skipped при полностью отмеченных днях — НЕ triggered", () => {
    const a = analyzeProgram(
      facts({
        logs: [
          log(1, "2026-08-10", "completed"),
          log(2, "2026-08-12", "completed"),
          log(3, "2026-08-14", "skipped"),
        ],
      }),
    );
    expect(a.triggered).toBe(false);
  });

  it("pending на прошедшую дату → overduePending + triggered", () => {
    const a = analyzeProgram(
      facts({
        logs: [
          log(1, "2026-08-10", "completed"),
          log(2, "2026-08-12", "completed"),
          log(3, "2026-08-14", "completed"),
          log(4, "2026-08-11", "pending", "перенос с 2026-08-10"),
        ],
      }),
    );
    expect(a.overduePending).toEqual([{ day: "2026-08-11", notes: "перенос с 2026-08-10" }]);
    expect(a.triggered).toBe(true);
  });

  it("pending на сегодня → pendingToday (разовое напоминание), без отставания", () => {
    const a = analyzeProgram(
      facts({
        logs: [
          log(1, "2026-08-10", "completed"),
          log(2, "2026-08-12", "completed"),
          log(3, "2026-08-14", "completed"),
          log(4, TODAY, "pending", "перенос с 2026-08-14"),
        ],
      }),
    );
    expect(a.pendingToday).toEqual([{ day: TODAY, notes: "перенос с 2026-08-14" }]);
    expect(a.overduePending).toEqual([]);
    expect(a.triggered).toBe(false);
  });
});

describe("programFactsBlock / buildProgramCheckPrompt", () => {
  it("факты: программа, окно, расписание, не отмеченные дни", () => {
    const f = facts();
    const a = analyzeProgram(f);
    const block = programFactsBlock(f, a);
    expect(block).toContain("версия 1, цель weight_loss, 3 раз/нед, активна с 2026-08-01");
    expect(block).toContain("окно 7 завершённых дней (2026-08-08 … 2026-08-14)");
    expect(block).toContain("пн: 1 упражн.");
    expect(block).toContain("НЕ отмечены (день программы прошёл, лога нет): 2026-08-10");
  });

  it("промпт: смысл, инструменты адаптации, правило перевода, тон", () => {
    const f = facts();
    const p = buildProgramCheckPrompt(f, analyzeProgram(f));
    expect(p).toContain("ПРОВЕРКА ТРЕНИРОВОЧНОЙ ПРОГРАММЫ");
    expect(p).toContain("reschedule");
    expect(p).toContain("log-workout");
    expect(p).toContain("Названия упражнений переводит на русский ты");
    expect(p).toContain("tone-пресету");
    expect(p).toContain("Числа и даты — только из блока фактов");
  });

  it("промпт при pendingToday: напоминание + сессии на сегодня (если день программы)", () => {
    // Сегодня суббота (6) — не день программы: блок «разовая, упражнений нет».
    const f = facts({
      logs: [
        log(1, "2026-08-10", "completed"),
        log(2, "2026-08-12", "completed"),
        log(3, "2026-08-14", "completed"),
        log(4, TODAY, "pending", "перенос с 2026-08-14"),
      ],
    });
    const a = analyzeProgram(f);
    const p = buildProgramCheckPrompt(f, a);
    expect(p).toContain("СЕГОДНЯ разовая перенесённая тренировка");
    expect(p).toContain("Разовая тренировка (перенос); упражнений программы на этот день недели нет");

    // А если сегодня — день программы (суббота добавлена в расписание):
    const f2 = facts({
      sessionsByDow: { ...f.sessionsByDow, 6: [{ exercise_name_en: "Bear Walk", sets: 3, reps: "30s" }] },
      logs: f.logs,
    });
    const p2 = buildProgramCheckPrompt(f2, analyzeProgram(f2));
    expect(p2).toContain("Сессии на сегодня (программа)");
    expect(p2).toContain("Bear Walk ×3 (30s)");
  });
});
