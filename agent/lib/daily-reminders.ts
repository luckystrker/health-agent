// @ts-check
/**
 * Выбор юзеров, которым пора отправить напоминание (§9; PHASE-4 §5.1–5.3).
 *
 * Все daily-джобы и workout-reminder тикают ежечасно и при каждом тике:
 *  1. берут онборженных не-blocked юзеров с настроенным слотом (inner join
 *     reminder_settings; NULL-слот = напоминание отключено — пропуск, §6 PHASE-4);
 *  2. сверяют слот с текущим локальным временем юзера симметричным fuzzy-окном
 *     ±30 мин (lib/fuzzy-window, круговое сравнение — слоты через полночь);
 *  3. подавляют повтор в ту же локальную дату in-memory dedup'ом
 *     (lib/alert-dedup). Ключ помечается ПОСЛЕ успешной доставки — сбой
 *     доставки не съедает напоминалку (следующий тик повторит).
 *
 * `pickDue*` — pure-фильтр над строками БД (unit-тестируется); `due*` —
 * DB-обёртки (query + вызов pure-фильтра).
 */
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "./db/client";
import { reminderSettings, users, type WorkoutTimeSlot } from "./db/schema";
import {
  dailyReminderKey,
  keyAlreadySent,
  workoutReminderKey,
} from "./alert-dedup";
import {
  localDayOfWeek,
  localMinutesOfDay,
  normalizeHHMM,
  parseHHMMToMinutes,
  withinFuzzyWindow,
} from "./fuzzy-window";
import { localDay } from "./time";

export type ReminderKind = "morning" | "midday" | "evening";

/** Юзер, которому пора отправить напоминание. */
export interface ReminderTarget {
  userId: string;
  telegramChatId: bigint;
  tz: string;
  /** Локальная дата срабатывания (для логов/промпта). */
  localDate: string;
  /** Слот "HH:MM", по которому сработали. */
  slotLocalTime: string;
  /** Dedup-ключ (пометить через markKeySent после успешной доставки). */
  dedupKey: string;
}

export interface DailySlotRow {
  id: string;
  telegramChatId: bigint;
  timezone: string;
  /** "HH:MM:SS" из колонки time (drizzle). */
  slot: string | null;
}

export interface WorkoutSlotRow {
  id: string;
  telegramChatId: bigint;
  timezone: string;
  workoutTimes: WorkoutTimeSlot[] | null;
}

/**
 * Pure-фильтр daily-слота: fuzzy-окно + dedup. Невалидное время слота —
 * молча пропускаем (не падаем, §6 PHASE-4).
 */
export function pickDueDaily(rows: DailySlotRow[], kind: ReminderKind, now: Date): ReminderTarget[] {
  const out: ReminderTarget[] = [];
  for (const r of rows) {
    if (r.slot == null) continue; // отключено
    const slotMinutes = parseHHMMToMinutes(r.slot);
    const slotHHMM = normalizeHHMM(r.slot);
    if (slotMinutes == null || slotHHMM == null) continue; // битый формат
    const localDate = localDay(now, r.timezone);
    if (!withinFuzzyWindow(localMinutesOfDay(now, r.timezone), slotMinutes)) continue;
    const key = dailyReminderKey(r.id, kind, localDate);
    if (keyAlreadySent(key)) continue;
    out.push({
      userId: r.id,
      telegramChatId: r.telegramChatId,
      tz: r.timezone,
      localDate,
      slotLocalTime: slotHHMM,
      dedupKey: key,
    });
  }
  return out;
}

/**
 * Pure-фильтр workout-слотов: сверка day_of_week (0=вс…6=сб, §5.6) с текущим
 * локальным днём недели + fuzzy-окно + dedup по (user, day_of_week, local_date).
 * Несколько слотов в один день → ОДНО напоминание (dedup по day_of_week);
 * битые элементы массива — молча пропускаются.
 */
export function pickDueWorkout(rows: WorkoutSlotRow[], now: Date): ReminderTarget[] {
  const out: ReminderTarget[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.workoutTimes) || r.workoutTimes.length === 0) continue;
    const localDate = localDay(now, r.timezone);
    const dow = localDayOfWeek(now, r.timezone);
    const minutes = localMinutesOfDay(now, r.timezone);

    for (const slot of r.workoutTimes) {
      if (typeof slot?.day_of_week !== "number" || slot.day_of_week !== dow) continue;
      const slotMinutes = parseHHMMToMinutes(String(slot.local_time));
      const slotHHMM = normalizeHHMM(String(slot.local_time));
      if (slotMinutes == null || slotHHMM == null) continue;
      if (!withinFuzzyWindow(minutes, slotMinutes)) continue;
      const key = workoutReminderKey(r.id, dow, localDate);
      if (keyAlreadySent(key)) continue;
      out.push({
        userId: r.id,
        telegramChatId: r.telegramChatId,
        tz: r.timezone,
        localDate,
        slotLocalTime: slotHHMM,
        dedupKey: key,
      });
      break; // одно напоминание на юзера в день
    }
  }
  return out;
}

// ── DB-обёртки ───────────────────────────────────────────────────────────────

/** Онборженные не-blocked юзеры со настроенным daily-слотом `kind`. */
export async function dueDailyReminderUsers(kind: ReminderKind, now = new Date()): Promise<ReminderTarget[]> {
  const slotColumn =
    kind === "morning"
      ? reminderSettings.morningLocal
      : kind === "midday"
        ? reminderSettings.middayLocal
        : reminderSettings.eveningLocal;

  const rows: DailySlotRow[] = await db
    .select({
      id: users.id,
      telegramChatId: users.telegramChatId,
      timezone: users.timezone,
      slot: slotColumn,
    })
    .from(users)
    .innerJoin(reminderSettings, eq(reminderSettings.userId, users.id))
    .where(and(isNotNull(users.onboardedAt), eq(users.blocked, false), isNotNull(slotColumn)));

  return pickDueDaily(rows, kind, now);
}

/** Онборженные не-blocked юзеры с workout_times (слоты фильтруются в pure-части). */
export async function dueWorkoutReminderUsers(now = new Date()): Promise<ReminderTarget[]> {
  const rows: WorkoutSlotRow[] = await db
    .select({
      id: users.id,
      telegramChatId: users.telegramChatId,
      timezone: users.timezone,
      workoutTimes: reminderSettings.workoutTimes,
    })
    .from(users)
    .innerJoin(reminderSettings, eq(reminderSettings.userId, users.id))
    .where(and(isNotNull(users.onboardedAt), eq(users.blocked, false)));

  return pickDueWorkout(rows, now);
}
