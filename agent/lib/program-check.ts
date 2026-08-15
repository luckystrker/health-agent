// @ts-check
/**
 * Триггер адаптации программы (§9, §11.4; PHASE-5 §5.5).
 *
 * `program-check` (cron `0 5 * * *`) для каждого онборженного юзера с активной
 * программой проверяет `workout_logs` за последние 7 локальных дней:
 *  - незалогированные сессии: прошедшие дни, где по `program_sessions` была
 *    тренировка, а лога нет (status IS NULL — сессия не отмечена);
 *  - просроченные разовые переносы (pending на уже прошедшую дату);
 *  - накопленное отставание: ≥2 skipped/partial за 7 дней.
 * При срабатывании — proactive-сессия: агент анализирует факты и решает
 * (перенести / облегчить / пересобрать / оставить), вызывая `reschedule`.
 *
 * Дополнение (§5.4 Примечание): pending-сессии на сегодня попадают в промпт как
 * «разовое напоминание» — workout-reminder фазы 4 работает по регулярным слотам
 * и разовую дату не покрывает.
 *
 * `collectProgramFacts` — DB-обёртка; `analyzeProgram` / промпт-билдеры — pure
 * (unit-тестируются).
 */
import { and, eq, gte, lte } from "drizzle-orm";

import { db } from "./db/client";
import { workoutLogs } from "./db/schema";
import { getActiveProgram } from "./program-store";
import { localDay, previousDay } from "./time";
import { getUserTimezone } from "./tenant";

export interface ProgramLogRow {
  id: number;
  scheduledDay: string;
  status: string;
  notes: string | null;
}

export interface ProgramFacts {
  tz: string;
  /** Локальная дата «сегодня» (для заголовка/дедупа). */
  localDate: string;
  programVersion: number;
  goalKind: string;
  frequencyPerWeek: number;
  /** Локальная дата создания активной версии (до неё программу не ждали). */
  programStartedDay: string;
  /** Сессии активной версии по дням недели (EN-имена — агент переводит). */
  sessionsByDow: Record<number, { exercise_name_en: string; sets: number | null; reps: string | null }[]>;
  /** Логи за окно [сегодня-7 … сегодня] (любые версии — это история выполнения). */
  logs: ProgramLogRow[];
}

export interface ProgramAnalysis {
  completed: number;
  skipped: number;
  partial: number;
  rescheduled: number;
  /** Прошедшие дни программы без отметки. */
  unloggedDays: { day: string; day_of_week: number; exercises: number }[];
  /** Разовые переносы на уже прошедшую дату, оставшиеся pending. */
  overduePending: { day: string; notes: string | null }[];
  /** Разовые переносы на сегодня (напомнить). */
  pendingToday: { day: string; notes: string | null }[];
  /** Есть признаки отставания (незалогированные/просроченные/≥2 skipped+partial). */
  triggered: boolean;
  reasons: string[];
}

/** Окно анализа: последние 7 завершённых локальных дней + сегодня. */
export function programWindowDays(localDate: string): string[] {
  const days: string[] = [localDate];
  for (let i = 0; i < 7; i++) days.push(previousDay(days[days.length - 1]));
  return days.reverse(); // [today-7 … today]
}

/** DB: факты по активной программе юзера (null — программы нет). */
export async function collectProgramFacts(userId: string, now = new Date()): Promise<ProgramFacts | null> {
  const active = await getActiveProgram(userId);
  if (!active) return null;

  const tz = await getUserTimezone(userId);
  const localDate = localDay(now, tz);
  const window = programWindowDays(localDate);

  const logRows = await db
    .select({
      id: workoutLogs.id,
      scheduledDay: workoutLogs.scheduledDay,
      status: workoutLogs.status,
      notes: workoutLogs.notes,
    })
    .from(workoutLogs)
    .where(
      and(
        eq(workoutLogs.userId, userId),
        gte(workoutLogs.scheduledDay, new Date(`${window[0]}T00:00:00.000Z`)),
        lte(workoutLogs.scheduledDay, new Date(`${window[window.length - 1]}T00:00:00.000Z`)),
      ),
    )
    .orderBy(workoutLogs.scheduledDay);

  const sessionsByDow: ProgramFacts["sessionsByDow"] = {};
  for (const s of active.sessions) {
    (sessionsByDow[s.dayOfWeek] ??= []).push({
      exercise_name_en: s.exerciseNameEn,
      sets: s.sets,
      reps: s.reps,
    });
  }

  return {
    tz,
    localDate,
    programVersion: active.program.version,
    goalKind: active.program.goalKind,
    frequencyPerWeek: active.program.frequencyPerWeek,
    programStartedDay: localDay(active.program.createdAt, tz),
    sessionsByDow,
    logs: logRows.map((r) => ({
      id: r.id,
      scheduledDay: r.scheduledDay ? r.scheduledDay.toISOString().slice(0, 10) : "",
      status: r.status,
      notes: r.notes ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure-анализ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Анализ отставания. «Ожидаемый» день: завершённый локальный день ≥ даты
 * создания активной версии, по day_of_week которого есть сессии. День
 * «отмечен», если есть хоть какой-то лог с scheduled_day = этот день.
 */
export function analyzeProgram(facts: ProgramFacts): ProgramAnalysis {
  const logsByDay = new Map<string, ProgramLogRow[]>();
  for (const l of facts.logs) {
    if (!l.scheduledDay) continue;
    const list = logsByDay.get(l.scheduledDay);
    if (list) list.push(l);
    else logsByDay.set(l.scheduledDay, [l]);
  }

  let completed = 0;
  let skipped = 0;
  let partial = 0;
  let rescheduled = 0;
  for (const l of facts.logs) {
    if (l.status === "completed") completed++;
    else if (l.status === "skipped") skipped++;
    else if (l.status === "partial") partial++;
    else if (l.status === "rescheduled") rescheduled++;
  }

  const window = programWindowDays(facts.localDate);
  const completedDays = window.slice(0, -1); // без сегодня

  const unloggedDays: ProgramAnalysis["unloggedDays"] = [];
  for (const day of completedDays) {
    if (day < facts.programStartedDay) continue; // программы ещё не было
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const sessions = facts.sessionsByDow[dow];
    if (!sessions || sessions.length === 0) continue;
    const logs = logsByDay.get(day);
    if (!logs || logs.length === 0) {
      unloggedDays.push({ day, day_of_week: dow, exercises: sessions.length });
    }
  }

  const overduePending: ProgramAnalysis["overduePending"] = [];
  const pendingToday: ProgramAnalysis["pendingToday"] = [];
  for (const l of facts.logs) {
    if (l.status !== "pending" || !l.scheduledDay) continue;
    if (l.scheduledDay < facts.localDate) overduePending.push({ day: l.scheduledDay, notes: l.notes });
    else if (l.scheduledDay === facts.localDate) pendingToday.push({ day: l.scheduledDay, notes: l.notes });
  }

  const reasons: string[] = [];
  if (unloggedDays.length > 0) {
    reasons.push(`незалогированных сессий за 7 дней: ${unloggedDays.length}`);
  }
  if (overduePending.length > 0) {
    reasons.push(`просроченных разовых переносов: ${overduePending.length}`);
  }
  if (skipped + partial >= 2) {
    reasons.push(`skipped+partial за 7 дней: ${skipped + partial} (skipped ${skipped}, partial ${partial})`);
  }

  return {
    completed,
    skipped,
    partial,
    rescheduled,
    unloggedDays,
    overduePending,
    pendingToday,
    triggered: reasons.length > 0,
    reasons,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Промпт (pure)
// ─────────────────────────────────────────────────────────────────────────────

const DOW_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function formatSessions(sessions: { exercise_name_en: string; sets: number | null; reps: string | null }[]): string {
  return sessions
    .map((s) => `- ${s.exercise_name_en}${s.sets ? ` ×${s.sets}` : ""}${s.reps ? ` (${s.reps})` : ""}`)
    .join("\n");
}

/** Блок фактов для промпта proactive-сессии. */
export function programFactsBlock(facts: ProgramFacts, analysis: ProgramAnalysis): string {
  const window = programWindowDays(facts.localDate);
  const lines: string[] = [
    `- программа: версия ${facts.programVersion}, цель ${facts.goalKind}, ${facts.frequencyPerWeek} раз/нед, активна с ${facts.programStartedDay}`,
    `- окно 7 завершённых дней (${window[0]} … ${previousDay(facts.localDate)}): completed ${analysis.completed}, skipped ${analysis.skipped}, partial ${analysis.partial}, rescheduled ${analysis.rescheduled}`,
  ];

  const dows = Object.keys(facts.sessionsByDow)
    .map(Number)
    .sort((a, b) => a - b);
  if (dows.length > 0) {
    lines.push("- расписание программы (названия — английские, переведи на русский):");
    for (const d of dows) {
      lines.push(`  • ${DOW_RU[d]}: ${facts.sessionsByDow[d].length} упражн.`);
    }
  } else {
    lines.push("- расписание программы: пусто (нет сессий)");
  }

  if (analysis.unloggedDays.length > 0) {
    lines.push(
      `- НЕ отмечены (день программы прошёл, лога нет): ${analysis.unloggedDays
        .map((d) => `${d.day} (${DOW_RU[d.day_of_week]})`)
        .join(", ")}`,
    );
  }
  if (analysis.overduePending.length > 0) {
    lines.push(
      `- просроченные разовые переносы (pending на прошедшую дату): ${analysis.overduePending
        .map((d) => d.day)
        .join(", ")}`,
    );
  }
  if (analysis.pendingToday.length > 0) {
    lines.push(
      `- СЕГОДНЯ разовая перенесённая тренировка (${analysis.pendingToday
        .map((d) => `${d.day}${d.notes ? `, ${d.notes}` : ""}`)
        .join("; ")})`,
    );
  }
  return lines.join("\n");
}

/** Промпт proactive-сессии program-check (pure — unit-тестируется). */
export function buildProgramCheckPrompt(facts: ProgramFacts, analysis: ProgramAnalysis): string {
  const todaySessions = facts.sessionsByDow[new Date(`${facts.localDate}T00:00:00Z`).getUTCDay()] ?? [];
  const todayBlock =
    analysis.pendingToday.length > 0 && todaySessions.length > 0
      ? `\n### Сессии на сегодня (программа)\n\n${formatSessions(todaySessions)}\n`
      : analysis.pendingToday.length > 0
        ? `\n### Перенесённая сессия на сегодня\n\nРазовая тренировка (перенос); упражнений программы на этот день недели нет.\n`
        : "";

  return [
    "Это проактивная сессия: ПРОВЕРКА ТРЕНИРОВОЧНОЙ ПРОГРАММЫ (schedule program-check).",
    "Пользователь тебя не спрашивал. Проанализируй факты и прими решение по адаптации.",
    "",
    "### Факты (локальная дата юзера: " + facts.localDate + ")",
    "",
    programFactsBlock(facts, analysis),
    todayBlock,
    "### Как действовать",
    "",
    "1. Если сегодня разовая перенесённая тренировка — напомни о ней (упражнения,",
    "   если перечислены, переведи на русский).",
    "2. Если есть признаки отставания — оцени масштаб:",
    "   - 1 незалогированный день / лёгкое отставание: короткое сообщение, предложи",
    "     отметить тренировку (log-workout) или перенести (reschedule mode='move_once');",
    "   - ≥2 пропусков или ≥2 skipped/partial: предложи адаптацию — перенос",
    "     (reschedule move_once/move_weekly), облегчение (lighten) или пересборку",
    "     (rebuild; упражнения подбери через build-program search). Если выбор",
    "     неоднозначен — спроси ask_question с кнопками вариантов.",
    "3. Решение за юзером: адаптируй программу только после его явного выбора;",
    "   «отметить пропущенное» — только если юзер подтвердит.",
    "4. Числа и даты — только из блока фактов; ничего не выдумывай.",
    "5. Названия упражнений переводит на русский ты (wger хранит английские).",
    "",
    "Тон — строго по твоему tone-пресету. Язык — русский.",
  ].join("\n");
}
