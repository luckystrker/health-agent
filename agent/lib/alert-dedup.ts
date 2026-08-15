// @ts-check
/**
 * In-memory dedup / rate-limit для proactive-сообщений (§9 п.3; §11.5; PHASE-4 §5.1).
 *
 * Ключи последнего срабатывания:
 *  - daily-джобы: `(user_id, kind, local_date)`, kind ∈ {morning, midday, evening};
 *  - workout-reminder: `(user_id, day_of_week, local_date)`;
 *  - anomaly-check (rate-limit): `(user_id, type, local_date)` — не чаще 1 алерта
 *    типа на юзер×день;
 *  - program-check (фаза 5): `(user_id, local_date)` — не чаще одной
 *    адаптационной сессии в день.
 *
 * Признанный компромисс (PHASE-4 §8): счётчик в памяти процесса; рестарт
 * обнуляет → возможен редкий второй алерт в день рестарта (лучше дубля, чем
 * пропуска). При масштабировании (>~10 юзеров) — таблица alert_log.
 *
 * Ключи заканчиваются локальной датой "YYYY-MM-DD" → старые чистятся лексико-
 * графическим сравнением (ISO-даты сортируются как строки).
 */
const sentKeys = new Set<string>();

/** Автопрун: при достижении размера (защита от роста на сверх-длинном аптайме). */
const PRUNE_AT_SIZE = 256;
/** Сколько суток ключей держать. */
const PRUNE_KEEP_DAYS = 2;
/**
 * Запас в сутки для cutoff: ключи датированы ЛОКАЛЬНЫМИ датами юзеров, которые
 * могут опережать UTC-дату на сутки — без запаса свежий «сегодня-локально»
 * ключ вычищался бы преждевременно около полуночи.
 */
const PRUNE_UTC_MARGIN_DAYS = 1;

/** Ключ daily-напоминания: (user_id, kind, local_date). */
export function dailyReminderKey(userId: string, kind: string, localDate: string): string {
  return `daily:${kind}:${userId}:${localDate}`;
}

/** Ключ workout-напоминания: (user_id, day_of_week, local_date). */
export function workoutReminderKey(userId: string, dayOfWeek: number, localDate: string): string {
  return `workout:${userId}:${dayOfWeek}:${localDate}`;
}

/** Ключ rate-limit алерта аномалии: (user_id, type, local_date). */
export function anomalyAlertKey(userId: string, type: string, localDate: string): string {
  return `anomaly:${type}:${userId}:${localDate}`;
}

/** Ключ сессии program-check: (user_id, local_date) — не чаще раза в день. */
export function programCheckKey(userId: string, localDate: string): string {
  return `program-check:${userId}:${localDate}`;
}

export function keyAlreadySent(key: string): boolean {
  return sentKeys.has(key);
}

/** Пометить ключ отправленным (вызывается после УСПЕШНОЙ доставки — сбой доставки
 *  не съедает напоминалку: следующий тик попробует снова в рамках дня). */
export function markKeySent(key: string): void {
  sentKeys.add(key);
  if (sentKeys.size >= PRUNE_AT_SIZE) {
    pruneStaleSentKeys();
  }
}

/**
 * Прун устаревших ключей (auto — из markKeySent при переполнении). Cutoff —
 * UTC-дата минус (PRUNE_KEEP_DAYS + запас на локальные даты), см. константы.
 * Возвращает число удалённых. Публично — для тестов.
 */
export function pruneStaleSentKeys(now: Date = new Date()): number {
  const cutoff = new Date(
    now.getTime() - (PRUNE_KEEP_DAYS + PRUNE_UTC_MARGIN_DAYS) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return pruneSentKeysOlderThan(cutoff);
}

/**
 * Удалить ключи с датой раньше `cutoffDayStr` ("YYYY-MM-DD"; ключи заканчиваются
 * датой). Возвращает число удалённых. Для авто-пруна с локальным запасом —
 * `pruneStaleSentKeys`; здесь — прямое сравнение (для тестов/ручного вызова).
 */
export function pruneSentKeysOlderThan(cutoffDayStr: string): number {
  let removed = 0;
  for (const key of sentKeys) {
    const date = key.slice(-10);
    if (date < cutoffDayStr) {
      sentKeys.delete(key);
      removed++;
    }
  }
  return removed;
}

/** Сброс состояния (для unit-тестов; в рантайме не вызывать). */
export function clearSentKeysForTests(): void {
  sentKeys.clear();
}
