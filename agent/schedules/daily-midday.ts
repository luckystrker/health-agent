// @ts-check
/**
 * Schedule `daily-midday` — дневная напоминалка (§9; PHASE-4 §5.1–5.2).
 *
 * Cron `0 * * * *`: fuzzy-сверка midday-слота ±30 мин в локальном времени
 * юзера + dedup. Напоминание — внести еду дня (завтрак/обед): если к моменту
 * слота записей еды сегодня нет — напомнить; если есть — лёгкая версия.
 * Тон — tone-пресет юзера; изоляция per-user (§16).
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { markKeySent } from "../lib/alert-dedup";
import { dueDailyReminderUsers } from "../lib/daily-reminders";
import { log } from "../lib/log";
import { sendProactiveWithRetry } from "../lib/proactive-send";
import { buildTodayVitals } from "../lib/today-vitals";
import { userAuthFor } from "../lib/user-auth";

export interface MiddayFacts {
  kcalEaten: number | null;
  foodEntries: number;
}

/** Промпт дневной напоминалки (pure — unit-тестируется). */
export function buildMiddayPrompt(f: MiddayFacts): string {
  const lines: string[] = [
    "Это проактивная сессия: ДНЕВНОЕ НАПОМИНАНИЕ (schedule daily-midday).",
    "Пользователь тебя не спрашивал — короткое сообщение и заверши сессию.",
    "Не задавай вопросов, не жди ответа.",
    "",
    "### Факты",
  ];
  if (f.kcalEaten != null) {
    lines.push(`- записано еды сегодня: ${f.foodEntries} записей, ${Math.round(f.kcalEaten)} ккал`);
  } else {
    lines.push("- записей еды сегодня: нет");
  }
  lines.push(
    "",
    "### Как составить сообщение",
    "",
    "1–2 предложения:",
    "- если записей нет — напомни внести завтрак и обед (и всё, что забыл);",
    "- если записи есть — не напоминай в лоб: одна лёгкая фраза («день на учёте»",
    "  и т.п. по твоему тону), без повторения цифр.",
    "",
    "Тон — строго по твоему tone-пресету. Язык — русский. Одно сообщение.",
  );
  return lines.join("\n");
}

export default defineSchedule({
  cron: "0 * * * *",
  async run({ to, waitUntil }) {
    const startedAt = Date.now();
    log("schedule", "daily-midday-start", "info", {});

    try {
      const due = await dueDailyReminderUsers("midday");
      let userErrors = 0;

      for (const t of due) {
        try {
          const vitals = await buildTodayVitals(t.userId);
          const prompt = buildMiddayPrompt({
            kcalEaten: vitals.kcalEaten,
            foodEntries: vitals.foodEntries,
          });

          waitUntil(
            (async () => {
              const ok = await sendProactiveWithRetry("daily-midday", t.userId, () =>
                to(telegram, { chatId: String(t.telegramChatId) }).send(prompt, {
                  auth: userAuthFor({ telegram_chat_id: t.telegramChatId, user_id: t.userId }),
                }),
              );
              if (ok) {
                markKeySent(t.dedupKey);
                log("schedule", "daily-midday-sent", "info", {
                  user_id: t.userId,
                  local_date: t.localDate,
                  slot: t.slotLocalTime,
                });
              }
            })(),
          );
        } catch (e) {
          userErrors++;
          log("schedule", "daily-midday-user-error", "error", {
            user_id: t.userId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      log("schedule", "daily-midday-done", "info", {
        usersDue: due.length,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      log("schedule", "daily-midday-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
