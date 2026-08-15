// @ts-check
/**
 * Schedule `workout-reminder` — напоминание о тренировке (§9; PHASE-4 §5.3).
 *
 * Cron `0 * * * *`: сверка `reminder_settings.workout_times`
 * ([{day_of_week: 0=вс…6=сб, local_time: "HH:MM"}], §5.6) с текущим локальным
 * днём недели и временем (fuzzy ±30 мин) + dedup по (user, day_of_week,
 * local_date). Тренировочная программа (детали сессии) появится в фазе 5 —
 * пока напоминание общее. Тон — tone-пресет; изоляция per-user (§16).
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { markKeySent } from "../lib/alert-dedup";
import { dueWorkoutReminderUsers } from "../lib/daily-reminders";
import { log } from "../lib/log";
import { sendProactiveWithRetry } from "../lib/proactive-send";
import { userAuthFor } from "../lib/user-auth";

/** Промпт напоминания о тренировке (pure — unit-тестируется). */
export function buildWorkoutPrompt(slotLocalTime: string): string {
  return [
    "Это проактивная сессия: НАПОМИНАНИЕ О ТРЕНИРОВКЕ (schedule workout-reminder).",
    "Пользователь тебя не спрашивал — короткое сообщение и заверши сессию.",
    "Не задавай вопросов, не жди ответа, не спрашивай про выполнение.",
    "",
    "### Факт",
    `- сегодня в ${slotLocalTime} (локальное время) у пользователя запланирована тренировка.`,
    "",
    "### Как составить сообщение",
    "",
    "1–2 предложения: тренировка скоро — собрать себя / подготовиться.",
    "Деталей программы у тебя нет — не выдумывай упражнения и план, не обещай их.",
    "Если время слота уже прошло — одна фраза-пинок «пора», без выяснений.",
    "",
    "Тон — строго по твоему tone-пресету. Язык — русский. Одно сообщение.",
  ].join("\n");
}

export default defineSchedule({
  cron: "0 * * * *",
  async run({ to, waitUntil }) {
    const startedAt = Date.now();
    log("schedule", "workout-reminder-start", "info", {});

    try {
      const due = await dueWorkoutReminderUsers();
      let userErrors = 0;

      for (const t of due) {
        try {
          const prompt = buildWorkoutPrompt(t.slotLocalTime);

          waitUntil(
            (async () => {
              const ok = await sendProactiveWithRetry("workout-reminder", t.userId, () =>
                to(telegram, { chatId: String(t.telegramChatId) }).send(prompt, {
                  auth: userAuthFor({ telegram_chat_id: t.telegramChatId, user_id: t.userId }),
                }),
              );
              if (ok) {
                markKeySent(t.dedupKey);
                log("schedule", "workout-reminder-sent", "info", {
                  user_id: t.userId,
                  local_date: t.localDate,
                  slot: t.slotLocalTime,
                });
              }
            })(),
          );
        } catch (e) {
          userErrors++;
          log("schedule", "workout-reminder-user-error", "error", {
            user_id: t.userId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      log("schedule", "workout-reminder-done", "info", {
        usersDue: due.length,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      log("schedule", "workout-reminder-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
