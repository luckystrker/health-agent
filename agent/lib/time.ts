// @ts-check
/**
 * Timezone-хелперы (§12.1).
 *
 * Все timestamp'ы хранятся в UTC; «день» = локальный день юзера по
 * `users.timezone`. Сон относится к дате пробуждения. DST обрабатывается
 * через абсолютные timestamp'ы (не разницу локальных часов).
 *
 * Реализация — на `Intl.DateTimeFormat` (0 внешних зависимостей). Корректно
 * работает на границе DST: длительность локального дня может быть 23/25 часов.
 */

/** "YYYY-MM-DD" — локальная дата юзера для данного UTC-момента. */
export function localDay(date: Date, tz: string): string {
  // "en-CA" даёт ISO-подобный формат YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Предыдущий день "YYYY-MM-DD" (строчная арифметика по UTC-полуночи дня-строки). */
export function previousDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Компоненты (number) из строки "YYYY-MM-DD"; бросает при невалидном формате. */
function parseDay(dayStr: string): { y: number; m: number; d: number } {
  if (!DAY_RE.test(dayStr)) {
    throw new Error(`Invalid day string: "${dayStr}" (expected YYYY-MM-DD)`);
  }
  const [y, m, d] = dayStr.split("-").map(Number);
  return { y, m, d };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Компоненты локального времени tz для данного UTC-момента. */
function localParts(epochMs: number, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // `hour: "2-digit"` при hour12:false может выдать "24" на полночь в старых ICU → нормализуем.
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * UTC-момент локальной полуночи начала локального дня, содержащего `epochMs`.
 * DST-корректно: offset в момент полуночи может отличаться от offsetа в произвольный
 * момент дня (переход весной/осенью), поэтому уточняем offset по самому candidate.
 */
function localMidnightUtc(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  const wantLocalMidnightEpoch = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  // Начальное приближение: offset из опорного момента.
  const refLocal = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let candidate = wantLocalMidnightEpoch - (refLocal - epochMs);
  // Итеративная коррекция: offset в самой полуночи может отличаться (DST). 2–3 итераций
  // достаточно, т.к. сдвиг — максимум час; сходится за один шаг в типовых tz.
  for (let i = 0; i < 3; i++) {
    const cp = localParts(candidate, tz);
    const actualLocal = Date.UTC(cp.year, cp.month - 1, cp.day, cp.hour, cp.minute, cp.second);
    const offset = actualLocal - candidate;
    const next = wantLocalMidnightEpoch - offset;
    if (next === candidate) break;
    candidate = next;
  }
  return candidate;
}

/**
 * Полуоткрытый UTC-диапазон [start, end) одного локального дня.
 *
 * @param dayStr — строка локального дня "YYYY-MM-DD" (из `localDay()`). Принимаем
 *   СТРОКУ, а не Date: Date-объект неоднозначен (UTC vs local-midnight) и его
 *   компоненты зависят от machine tz — это съезжало на сутки на машинах с
 *   отрицательным offset. Строка однозначна и не зависит от machine tz.
 * @param tz — IANA timezone юзера.
 *
 * DST: end вычисляется как локальная полночь следующего дня — поэтому
 * длинные/короткие дни (23/25 ч при переходе) учитываются точно.
 */
export function localDayRangeUtc(
  dayStr: string,
  tz: string,
): { start: Date; end: Date } {
  const { y, m, d } = parseDay(dayStr);
  // Опорная точка — UTC-полдень нужного дня (гарантированно в локальном дне для
  // любого tz с |offset| < 12h).
  const middayUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const startMs = localMidnightUtc(middayUtc, tz);
  const endMs = localMidnightUtc(middayUtc + 24 * 60 * 60 * 1000, tz);
  return { start: new Date(startMs), end: new Date(endMs) };
}

/**
 * UTC-момент локального времени "HH:MM" в локальном дне `dayStr` (tz юзера).
 *
 * Используется для `food_entries.consumed_at`: FatSecret не отдаёт точное время
 * приёма, только день+meal — берём каноническое время приёма (фаза 2). Точность
 * до часа достаточна: атрибуция дня идёт по отдельной колонке `day` (§5.4).
 * DST-нюанс: смещение берётся от полуночи дня; внутри переходного дня сдвиг
 * может отличаться на час — для времени приёма пищи это несущественно.
 */
export function localTimeToUtc(dayStr: string, hhmm: string, tz: string): Date {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid local time: "${hhmm}" (expected HH:MM)`);
  const { start } = localDayRangeUtc(dayStr, tz);
  return new Date(start.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60_000);
}

/**
 * Локальный день, к которому относится сон (дата пробуждения, §12.1).
 * `sleepEndUtc` — момент пробуждения.
 */
export function sleepWakeDay(sleepStartUtc: Date, sleepEndUtc: Date, tz: string): string {
  void sleepStartUtc; // Duration считается по абсолютным timestamp'ам вызывающим; здесь — только атрибуция дня.
  return localDay(sleepEndUtc, tz);
}

/** Проверка, что строка — валидный IANA timezone. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
