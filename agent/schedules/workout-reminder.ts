// @ts-check
/**
 * Schedule `workout-reminder` — напоминание о тренировке (§9; PHASE-4 §5.3).
 *
 * Cron `0 * * * *`: сверка `reminder_settings.workout_times`
 * ([{day_of_week: 0=вс…6=сб, local_time: "HH:MM"}], §5.6) с текущим локальным
 * днём недели и временем (fuzzy ±30 мин) + dedup по (user, day_of_week,
 * local_date).
 *
 * Фаза 5: в напоминание включаются упражнения активной программы на этот день
 * недели (`program_sessions`, EN-имена — модель переводит на русский). Сбор
 * best-effort: сбой чтения программы не блокирует само напоминание (как без
 * программы). Тон — tone-пресет; изоляция per-user (§16).
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { markKeySent } from "../lib/alert-dedup";
import { dueWorkoutReminderUsers, type ReminderTarget } from "../lib/daily-reminders";
import { localDayOfWeek } from "../lib/fuzzy-window";
import { log } from "../lib/log";
import { getSessionExercisesForDow } from "../lib/program-store";
import { sendProactiveWithRetry } from "../lib/proactive-send";
import { userAuthFor } from "../lib/user-auth";

export interface WorkoutExerciseBrief {
  exercise_name_en: string;
  sets: number | null;
  reps: string | null;
}

/** Промпт напоминания о тренировке (pure — unit-тестируется). */
export function buildWorkoutPrompt(
  slotLocalTime: string,
  exercises: WorkoutExerciseBrief[] = [],
): string {
  const planBlock =
    exercises.length > 0
      ? [
          "### План на сегодня (активная программа)",
          "",
          ...exercises.map(
            (e) => `- ${e.exercise_name_en}${e.sets ? ` ×${e.sets}` : ""}${e.reps ? ` (${e.reps})` : ""}`,
          ),
          "",
          "Названия упражнений переведи на русский (wger хранит английские).",
        ].join("\n")
      : [
          "### План на сегодня",
          "",
          "Деталей программы у тебя нет — не выдумывай упражнения и план, не обещай их.",
        ].join("\n");

  return [
    "Это проактивная сессия: НАПОМИНАНИЕ О ТРЕНИРОВКЕ (schedule workout-reminder).",
    "Пользователь тебя не спрашивал — короткое сообщение и заверши сессию.",
    "Не задавай вопросов, не жди ответа, не спрашивай про выполнение.",
    "",
    "### Факт",
    `- сегодня в ${slotLocalTime} (локальное время) у пользователя запланирована тренировка.`,
    "",
    planBlock,
    "",
    "### Как составить сообщение",
    "",
    "1–2 предложения: тренировка скоро — собрать себя / подготовиться.",
    "Если в плане есть упражнения — можно перечислить 3–5 основных (по-русски).",
    "Если время слота уже прошло — одна фраза-пинок «пора», без выяснений.",
    "",
    "Тон — строго по твоему tone-пресету. Язык — русский. Одно сообщение.",
  ].join("\n");
}

/** Упражнения дня недели активной программы (best-effort: сбой → []). */
async function exercisesForTarget(t: ReminderTarget, now: Date): Promise<WorkoutExerciseBrief[]> {
  try {
    return await getSessionExercisesForDow(t.userId, localDayOfWeek(now, t.tz));
  } catch (e) {
    log("schedule", "workout-reminder-plan-error", "warn", {
      user_id: t.userId,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

export default defineSchedule({
  cron: "0 * * * *",
  async run({ to, waitUntil }) {
    const startedAt = Date.now();
    log("schedule", "workout-reminder-start", "info", {});

    try {
      const due = await dueWorkoutReminderUsers();
      const now = new Date();
      let userErrors = 0;

      for (const t of due) {
        try {
          const exercises = await exercisesForTarget(t, now);
          const prompt = buildWorkoutPrompt(t.slotLocalTime, exercises);

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
                  exercises: exercises.length,
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
