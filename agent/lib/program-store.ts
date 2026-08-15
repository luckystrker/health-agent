// @ts-check
/**
 * Хранилище тренировочной программы (§5.5, §11.4; PHASE-5 §4–5).
 *
 * План = совокупность строк `program_sessions` для `program_version`; колонки
 * `workout_programs.plan` НЕТ (§11.4). Новая версия = строка в
 * `workout_programs` + набор `program_sessions`, прежняя → `active=false` —
 * одной транзакцией (edge «параллельные build-program», §6 PHASE-5).
 *
 * Здесь же — workout_times-хелперы (§5.6: [{day_of_week: 0=вс…6=сб,
 * local_time: "HH:MM"}]): заполнение из build-program с подтверждением
 * (§5.2 PHASE-5) и sync при регулярном переносе (§5.4). Pure-часть
 * (normalize/merge/move/scale) unit-тестируется; DB-обёртки тонкие.
 */
import { and, desc, eq, inArray, isNotNull, max } from "drizzle-orm";

import { db } from "./db/client";
import { log } from "./log";
import {
  goals,
  programSessions,
  reminderSettings,
  users,
  workoutLogs,
  workoutPrograms,
  type WorkoutTimeSlot,
} from "./db/schema";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ─────────────────────────────────────────────────────────────────────────────
// Pure-хелперы
// ─────────────────────────────────────────────────────────────────────────────

/** День недели (0=вс…6=сб) локальной даты "YYYY-MM-DD". */
export function dayOfWeekOf(dayStr: string): number {
  if (!DAY_RE.test(dayStr)) throw new Error(`Invalid day string: "${dayStr}"`);
  return new Date(`${dayStr}T00:00:00Z`).getUTCDay();
}

/**
 * Валидация + нормализация workout_times: отбрасывает битые элементы,
 * дедуплицирует по (day_of_week, local_time), сортирует. Бросает при
 * невалидном дне/времени во вводе (tool возвращает user-friendly ошибку).
 */
export function normalizeSlots(slots: unknown): WorkoutTimeSlot[] {
  const list = Array.isArray(slots) ? slots : [];
  const seen = new Set<string>();
  const out: WorkoutTimeSlot[] = [];
  for (const s of list as unknown[]) {
    const dow = Number((s as { day_of_week?: unknown })?.day_of_week);
    const time = String((s as { local_time?: unknown })?.local_time ?? "");
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      throw new Error(`Невалидный day_of_week: ${JSON.stringify(s)}`);
    }
    if (!HHMM_RE.test(time)) {
      throw new Error(`Невалидное local_time: "${time}" (ожидается HH:MM)`);
    }
    const key = `${dow}:${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day_of_week: dow, local_time: time });
  }
  return out.sort((a, b) => a.day_of_week - b.day_of_week || a.local_time.localeCompare(b.local_time));
}

/** Дефолтные слоты под дни программы (когда модель не предложила время). */
export function defaultTimesForDays(dows: number[], time = "18:00"): WorkoutTimeSlot[] {
  return normalizeSlots(dows.map((d) => ({ day_of_week: d, local_time: time })));
}

/** «Смешать»: объединение с удалением дублей по (day_of_week, local_time). */
export function mergeSlots(a: WorkoutTimeSlot[], b: WorkoutTimeSlot[]): WorkoutTimeSlot[] {
  return normalizeSlots([...a, ...b]);
}

/**
 * Регулярный перенос дня: слоты с from_dow → to_dow (время сохраняется),
 * дубли после переноса схлопываются. Слотов под from_dow не было → пустой
 * массив (вызывающий не трогает workout_times — не изобретаем слоты).
 */
export function moveSlotsDay(
  slots: WorkoutTimeSlot[],
  fromDow: number,
  toDow: number,
): WorkoutTimeSlot[] {
  if (!slots.some((s) => s.day_of_week === fromDow)) return [];
  return normalizeSlots(
    slots.map((s) => (s.day_of_week === fromDow ? { ...s, day_of_week: toDow } : s)),
  );
}

/** Масштабирование подходов: round(sets × factor), минимум 1. */
export function scaleSets(sets: number | null, factor: number): number | null {
  if (sets == null) return null;
  return Math.max(1, Math.round(sets * factor));
}

/** Префикс notes pending-строки разового переноса: «перенос с YYYY-MM-DD». */
export const PENDING_ORIGIN_PREFIX = "перенос с ";
const PENDING_ORIGIN_RE = /^перенос с (\d{4}-\d{2}-\d{2})/;

/**
 * Исходная дата разового переноса из notes pending-строки (или null).
 * Повторный перенос «от исходной даты» ищет pending по этому паттерну
 * (review P2): notes всегда хранит ИСХОДНУЮ дату сессии, сколько бы раз
 * её ни двигали.
 */
export function pendingOriginFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const m = PENDING_ORIGIN_RE.exec(notes);
  return m ? m[1] : null;
}

/**
 * День строго позже локального «сегодня» (ISO-даты сравнимы лексикографически).
 * Гuard «нельзя отметить/перенести в будущее» (review P2).
 */
export function isFutureLocalDay(day: string, todayLocal: string): boolean {
  return day > todayLocal;
}

/**
 * Масштабирование reps-строки: '8-12' → оба числа, '30s'/'15 reps' → ведущее
 * число с суффиксом, текст без чисел («до отказа») — без изменений.
 */
export function scaleRepsText(reps: string | null, factor: number): string | null {
  if (!reps) return null;
  const scale = (n: number) => Math.max(1, Math.round(n * factor));
  const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(reps.trim());
  if (range) return `${scale(Number(range[1]))}-${scale(Number(range[2]))}`;
  const leading = /^(\d+)(\s*\D.*)?$/.exec(reps.trim());
  if (leading) return `${scale(Number(leading[1]))}${leading[2] ?? ""}`;
  return reps;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB: активная программа
// ─────────────────────────────────────────────────────────────────────────────

export interface ActiveProgramMeta {
  version: number;
  goalKind: string;
  frequencyPerWeek: number;
  equipment: string[] | null;
  sessionDurationMin: number | null;
  constraints: string | null;
  createdAt: Date;
}

export interface ProgramSessionRow {
  id: number;
  dayOfWeek: number;
  wgerExerciseId: number;
  exerciseNameEn: string;
  sets: number | null;
  reps: string | null;
  sortOrder: number;
}

/** Активная программа (active=true, максимальная version) + её сессии, или null. */
export async function getActiveProgram(
  userId: string,
): Promise<{ program: ActiveProgramMeta; sessions: ProgramSessionRow[] } | null> {
  const program = await db
    .select()
    .from(workoutPrograms)
    .where(and(eq(workoutPrograms.userId, userId), eq(workoutPrograms.active, true)))
    .orderBy(desc(workoutPrograms.version))
    .limit(1);
  if (program.length === 0) return null;
  const p = program[0];
  const sessions = await db
    .select()
    .from(programSessions)
    .where(and(eq(programSessions.userId, userId), eq(programSessions.programVersion, p.version)))
    .orderBy(programSessions.dayOfWeek, programSessions.sortOrder);
  return {
    program: {
      version: p.version,
      goalKind: p.goalKind,
      frequencyPerWeek: p.frequencyPerWeek,
      equipment: p.equipment ?? null,
      sessionDurationMin: p.sessionDurationMin ?? null,
      constraints: p.constraints ?? null,
      createdAt: p.createdAt,
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      dayOfWeek: s.dayOfWeek,
      wgerExerciseId: s.wgerExerciseId,
      exerciseNameEn: s.exerciseNameEn,
      sets: s.sets ?? null,
      reps: s.reps ?? null,
      sortOrder: s.sortOrder,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB: сохранение новой версии
// ─────────────────────────────────────────────────────────────────────────────

export interface ProgramSessionInput {
  day_of_week: number;
  exercises: {
    wger_exercise_id: number;
    exercise_name_en: string;
    sets?: number | null;
    reps?: string | null;
  }[];
}

export interface ProgramMetaInput {
  goalKind: string;
  frequencyPerWeek: number;
  equipment: string[] | null;
  sessionDurationMin: number | null;
  constraints: string | null;
}

/**
 * Новая версия программы в ОДНОЙ транзакции: прежние active=false → insert
 * `workout_programs` (version = max+1, active=true) → insert `program_sessions`
 * (sort_order сквозной внутри дня). Открытые разовые переносы (status='pending')
 * привязываются к новой версии — иначе после пересборки они «осиротеют» со
 * старым program_version (review P1: log-workout не находил строку, program-check
 * вечно считал перенос просроченным). PK (user_id, version) защищает от гонки
 * параллельных сборок (второй вызов упадёт на конфликт — tool отдаст friendly
 * ошибку).
 */
export async function saveProgramVersion(
  userId: string,
  meta: ProgramMetaInput,
  sessions: ProgramSessionInput[],
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .update(workoutPrograms)
      .set({ active: false })
      .where(and(eq(workoutPrograms.userId, userId), eq(workoutPrograms.active, true)));

    const [{ maxVersion }] = await tx
      .select({ maxVersion: max(workoutPrograms.version) })
      .from(workoutPrograms)
      .where(eq(workoutPrograms.userId, userId));
    const version = (maxVersion ?? 0) + 1;

    // Разовые переносы переживают пересборку: перецепляем на новую версию.
    await tx
      .update(workoutLogs)
      .set({ programVersion: version })
      .where(and(eq(workoutLogs.userId, userId), eq(workoutLogs.status, "pending")));

    await tx.insert(workoutPrograms).values({
      userId,
      version,
      goalKind: meta.goalKind,
      frequencyPerWeek: meta.frequencyPerWeek,
      equipment: meta.equipment,
      sessionDurationMin: meta.sessionDurationMin,
      constraints: meta.constraints,
      active: true,
    });

    const rows = sessions.flatMap((day) =>
      day.exercises.map((ex, i) => ({
        userId,
        programVersion: version,
        dayOfWeek: day.day_of_week,
        wgerExerciseId: ex.wger_exercise_id,
        exerciseNameEn: ex.exercise_name_en,
        sets: ex.sets ?? null,
        reps: ex.reps ?? null,
        sortOrder: i,
      })),
    );
    if (rows.length > 0) await tx.insert(programSessions).values(rows);
    return version;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DB: workout_times (§5.6)
// ─────────────────────────────────────────────────────────────────────────────

/** Текущие workout_times юзера (null — не настроены/пустые). */
export async function getWorkoutTimes(userId: string): Promise<WorkoutTimeSlot[] | null> {
  const row = await db.query.reminderSettings.findFirst({
    where: eq(reminderSettings.userId, userId),
    columns: { workoutTimes: true },
  });
  const slots = row?.workoutTimes;
  return Array.isArray(slots) && slots.length > 0 ? slots : null;
}

/** Записать workout_times (upsert строки reminder_settings, прочие поля не трогаем). */
export async function setWorkoutTimes(userId: string, slots: WorkoutTimeSlot[] | null): Promise<void> {
  await db
    .insert(reminderSettings)
    .values({ userId, workoutTimes: slots })
    .onConflictDoUpdate({
      target: reminderSettings.userId,
      set: { workoutTimes: slots },
    });
}

export type WorkoutTimesChoice = "replace" | "merge" | "keep";

/**
 * Применить выбор юзера по подтверждению (§5.2 PHASE-5): replace — слоты
 * программы; merge — объединение с дедупом (текущих нет → слоты программы);
 * keep — не трогать. Возвращает итоговые слоты (для keep — текущие как есть).
 */
export async function applyWorkoutTimesChoice(
  userId: string,
  mode: WorkoutTimesChoice,
  suggested: WorkoutTimeSlot[],
): Promise<{ mode: WorkoutTimesChoice; workoutTimes: WorkoutTimeSlot[] | null }> {
  if (mode === "keep") {
    return { mode, workoutTimes: await getWorkoutTimes(userId) };
  }
  const current = (await getWorkoutTimes(userId)) ?? [];
  const merged = mode === "replace" ? suggested : mergeSlots(current, suggested);
  const normalized = normalizeSlots(merged);
  await setWorkoutTimes(userId, normalized);
  return { mode, workoutTimes: normalized };
}

export interface SaveProgramResult {
  version: number;
  days: number;
  exercisesTotal: number;
  times:
    | { state: "applied"; workoutTimes: WorkoutTimeSlot[] }
    | {
        state: "needs_confirmation";
        currentTimes: WorkoutTimeSlot[] | null;
        suggestedTimes: WorkoutTimeSlot[];
      };
}

/**
 * Сохранить программу + наполнить workout_times по правилу §5.2 PHASE-5:
 * пустые текущие → записать предложенные без вопроса; непустые → НЕ трогать,
 * вернуть needs_confirmation (модель спросит Заменить/Оставить мои/Смешать и
 * вызовет build-program action='apply_times').
 */
export async function saveProgramWithTimes(
  userId: string,
  meta: ProgramMetaInput,
  sessions: ProgramSessionInput[],
  suggestedTimes: WorkoutTimeSlot[],
): Promise<SaveProgramResult> {
  const version = await saveProgramVersion(userId, meta, sessions);
  const days = sessions.length;
  const exercisesTotal = sessions.reduce((n, d) => n + d.exercises.length, 0);

  const current = await getWorkoutTimes(userId);
  if (!current) {
    const normalized = normalizeSlots(suggestedTimes);
    await setWorkoutTimes(userId, normalized);
    return { version, days, exercisesTotal, times: { state: "applied", workoutTimes: normalized } };
  }
  return {
    version,
    days,
    exercisesTotal,
    times: { state: "needs_confirmation", currentTimes: current, suggestedTimes: suggestedTimes },
  };
}

/** Упражнения активной программы на день недели (для напоминания дня). */
export async function getSessionExercisesForDow(
  userId: string,
  dayOfWeek: number,
): Promise<{ exercise_name_en: string; sets: number | null; reps: string | null }[]> {
  const active = await db
    .select({ version: workoutPrograms.version })
    .from(workoutPrograms)
    .where(and(eq(workoutPrograms.userId, userId), eq(workoutPrograms.active, true)))
    .orderBy(desc(workoutPrograms.version))
    .limit(1);
  if (active.length === 0) return [];
  const rows = await db
    .select({
      exerciseNameEn: programSessions.exerciseNameEn,
      sets: programSessions.sets,
      reps: programSessions.reps,
    })
    .from(programSessions)
    .where(
      and(
        eq(programSessions.userId, userId),
        eq(programSessions.programVersion, active[0].version),
        eq(programSessions.dayOfWeek, dayOfWeek),
      ),
    )
    .orderBy(programSessions.sortOrder);
  return rows.map((r) => ({ exercise_name_en: r.exerciseNameEn, sets: r.sets ?? null, reps: r.reps ?? null }));
}

/** Онборженные не-blocked юзеры с активной программой (для program-check, §5.5). */
export async function usersWithActiveProgram(): Promise<
  { id: string; telegramChatId: bigint; timezone: string }[]
> {
  const programs = await db
    .selectDistinct({ userId: workoutPrograms.userId })
    .from(workoutPrograms)
    .where(eq(workoutPrograms.active, true));
  if (programs.length === 0) return [];
  return db
    .select({ id: users.id, telegramChatId: users.telegramChatId, timezone: users.timezone })
    .from(users)
    .where(
      and(
        inArray(users.id, programs.map((p) => p.userId)),
        isNotNull(users.onboardedAt),
        eq(users.blocked, false),
      ),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// DB: сохранение программы из tool-ввода (общее для build-program / reschedule:rebuild)
// ─────────────────────────────────────────────────────────────────────────────

/** Активная цель юзера (kind) или null. */
export async function activeGoalKind(userId: string): Promise<string | null> {
  const rows = await db
    .select({ kind: goals.kind })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.active, true)))
    .orderBy(desc(goals.createdAt))
    .limit(1);
  return rows[0]?.kind ?? null;
}

export interface ProgramParams {
  goal_kind?: string;
  frequency_per_week: number;
  equipment: string[];
  session_duration_min?: number;
  constraints?: string;
  sessions: ProgramSessionInput[];
  suggested_times?: WorkoutTimeSlot[];
}

export type SaveProgramFromParams =
  | { ok: false; error: string; message: string }
  | { ok: true; result: SaveProgramResult; goalKind: string };

/**
 * Валидация + сохранение программы из tool-ввода: дубли дней → ошибка; цель по
 * умолчанию — активная цель юзера (fallback maintenance); suggested_times по
 * умолчанию — дни программы на 18:00. См. saveProgramWithTimes про подтверждение
 * workout_times.
 */
export async function saveProgramFromParams(
  userId: string,
  params: ProgramParams,
): Promise<SaveProgramFromParams> {
  const dows = params.sessions.map((s) => s.day_of_week);
  if (new Set(dows).size !== dows.length) {
    return { ok: false, error: "duplicate_days", message: "Каждый day_of_week в плане должен быть один." };
  }
  const goalKind = params.goal_kind ?? (await activeGoalKind(userId)) ?? "maintenance";
  const suggestedTimes =
    params.suggested_times && params.suggested_times.length > 0
      ? params.suggested_times
      : defaultTimesForDays(params.sessions.map((s) => s.day_of_week));
  try {
    const result = await saveProgramWithTimes(
      userId,
      {
        goalKind,
        frequencyPerWeek: params.frequency_per_week,
        equipment: params.equipment,
        sessionDurationMin: params.session_duration_min ?? null,
        constraints: params.constraints ?? null,
      },
      params.sessions,
      suggestedTimes,
    );
    return { ok: true, result, goalKind };
  } catch (e) {
    log("tool", "program-save-failed", "error", {
      user_id: userId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: "save_failed", message: "Не удалось сохранить программу — попробуй ещё раз." };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB: правки текущей версии (reschedule)
// ─────────────────────────────────────────────────────────────────────────────

/** Регулярный перенос дня: program_sessions from→to (sort_order за существующими to-дня). */
export async function moveProgramDay(userId: string, fromDow: number, toDow: number): Promise<number> {
  return db.transaction(async (tx) => {
    const active = await tx
      .select({ version: workoutPrograms.version })
      .from(workoutPrograms)
      .where(and(eq(workoutPrograms.userId, userId), eq(workoutPrograms.active, true)))
      .orderBy(desc(workoutPrograms.version))
      .limit(1);
    if (active.length === 0) return 0;

    const rows = await tx
      .select({ id: programSessions.id })
      .from(programSessions)
      .where(
        and(
          eq(programSessions.userId, userId),
          eq(programSessions.programVersion, active[0].version),
          eq(programSessions.dayOfWeek, fromDow),
        ),
      );
    if (rows.length === 0) return 0;

    const [{ maxSort }] = await tx
      .select({ maxSort: max(programSessions.sortOrder) })
      .from(programSessions)
      .where(
        and(
          eq(programSessions.userId, userId),
          eq(programSessions.programVersion, active[0].version),
          eq(programSessions.dayOfWeek, toDow),
        ),
      );
    let next = (maxSort ?? -1) + 1;
    for (const r of rows) {
      await tx
        .update(programSessions)
        .set({ dayOfWeek: toDow, sortOrder: next++ })
        .where(eq(programSessions.id, r.id));
    }
    return rows.length;
  });
}

export interface LightenUpdate {
  sets: number | null;
  reps: string | null;
}

/** Облегчение: применить новые sets/reps к сессиям дня (или всех дней). */
export async function lightenProgram(
  userId: string,
  dayOfWeek: number | null,
  update: (row: { sets: number | null; reps: string | null }) => LightenUpdate,
): Promise<number> {
  const active = await db
    .select({ version: workoutPrograms.version })
    .from(workoutPrograms)
    .where(and(eq(workoutPrograms.userId, userId), eq(workoutPrograms.active, true)))
    .orderBy(desc(workoutPrograms.version))
    .limit(1);
  if (active.length === 0) return 0;

  const where = and(
    eq(programSessions.userId, userId),
    eq(programSessions.programVersion, active[0].version),
    ...(dayOfWeek == null ? [] : [eq(programSessions.dayOfWeek, dayOfWeek)]),
  );
  const rows = await db
    .select({ id: programSessions.id, sets: programSessions.sets, reps: programSessions.reps })
    .from(programSessions)
    .where(where);
  for (const r of rows) {
    const next = update({ sets: r.sets ?? null, reps: r.reps ?? null });
    await db
      .update(programSessions)
      .set({ sets: next.sets, reps: next.reps })
      .where(eq(programSessions.id, r.id));
  }
  return rows.length;
}
