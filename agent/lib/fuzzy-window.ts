// @ts-check
/**
 * Симметричное fuzzy-окно для per-user напоминаний (§9; PHASE-4 §5.1).
 *
 * Все daily-джобы и workout-reminder тикают каждый час (UTC) и при каждом тике
 * проверяют для каждого юзера `min(|LT − slot|, 24h − |LT − slot|) ≤ δ`,
 * `δ = 30 мин`, где LT — текущее локальное время юзера. Сравнение круговое
 * (по модулю суток) — корректно для слотов через полночь. При δ=30 и тике в
 * минуту 0 соседние окна стыкуются ровно в HH:30 — покрытие 100%.
 *
 * DST обрабатывается прозрачным образом: локальное время всегда вычисляется
 * через Intl по реальному моменту (никаких фиксированных offset'ов), поэтому
 * сдвиг часов просто меняет LT на час и окно корректно сдвигается вместе с ним.
 */
import { localDay } from "./time";

/** δ — полуширина fuzzy-окна (минуты), §9. */
export const FUZZY_WINDOW_MINUTES = 30;
export const MINUTES_PER_DAY = 24 * 60;

/** Формат "HH:MM" | "HH:MM:SS" с диапазонной проверкой всех компонент. */
const HHMM_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseTimeParts(v: string): { h: number; m: number } | null {
  const m = HHMM_RE.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] != null ? Number(m[3]) : 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return { h, m: min };
}

/**
 * "HH:MM" (или "HH:MM:SS" — так отдаёт колонку time в drizzle) → минуты от
 * полуночи (секунды не влияют на минуту суток). null при невалидном формате,
 * включая секунды > 59 (слот молча пропускается, §6 PHASE-4).
 */
export function parseHHMMToMinutes(v: string): number | null {
  const p = parseTimeParts(v);
  return p ? p.h * 60 + p.m : null;
}

/** "HH:MM[:SS]" → нормализованное "HH:MM" (для вывода юзеру); null при невалидном. */
export function normalizeHHMM(v: string): string | null {
  const p = parseTimeParts(v);
  if (!p) return null;
  return `${String(p.h).padStart(2, "0")}:${String(p.m).padStart(2, "0")}`;
}

/** Минуты локального времени от полуночи для UTC-момента в tz. */
export function localMinutesOfDay(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  // % 24: hour:"2-digit" при hour12:false может выдать "24" на полночь в старых ICU.
  const hour = Number(parts.find((p) => p.type === "hour")?.value) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
}

/** Локальный день недели (0=вс … 6=сб — нумерация §5.5/§5.6) для UTC-момента в tz. */
export function localDayOfWeek(now: Date, tz: string): number {
  const day = localDay(now, tz);
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/** Круговое расстояние между двумя минутами суток: 0..720. */
export function circularMinutesDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(d, MINUTES_PER_DAY - d);
}

/**
 * Слот попадает в симметричное окно `[slot − δ, slot + δ]` (минуты, кругово).
 * Границы включительны (§9 `≤ δ`): соседние часовые тики могут оба попасть в
 * окно ровно на границе HH:30 — дубль подавляется dedup, не окном.
 */
export function withinFuzzyWindow(
  localMinutes: number,
  slotMinutes: number,
  windowMinutes: number = FUZZY_WINDOW_MINUTES,
): boolean {
  return circularMinutesDiff(localMinutes, slotMinutes) <= windowMinutes;
}

/** Сработает ли напоминание слота `slotHHMM` в момент `now` (локальное время tz). */
export function shouldFireSlot(
  now: Date,
  tz: string,
  slotHHMM: string,
  windowMinutes: number = FUZZY_WINDOW_MINUTES,
): boolean {
  const slot = parseHHMMToMinutes(slotHHMM);
  if (slot == null) return false;
  return withinFuzzyWindow(localMinutesOfDay(now, tz), slot, windowMinutes);
}
