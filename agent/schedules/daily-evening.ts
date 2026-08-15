// @ts-check
/**
 * Schedule `daily-evening` — вечерняя сводка дня (§9; PHASE-4 §5.1–5.2).
 *
 * Cron `0 * * * *`: fuzzy-сверка evening-слота ±30 мин + dedup. Итог дня по
 * калориям/шагам. ВАЖНО (§12.3): текущий день НЕ в daily_aggregates — снимок
 * дня собирает lib/today-vitals (raw_samples on-the-fly + food_entries + цель
 * из lib/calories). Тон — tone-пресет; изоляция per-user (§16).
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { markKeySent } from "../lib/alert-dedup";
import { dueDailyReminderUsers } from "../lib/daily-reminders";
import { log } from "../lib/log";
import { sendProactiveWithRetry } from "../lib/proactive-send";
import { buildTodayVitals, type TodayVitals } from "../lib/today-vitals";
import { userAuthFor } from "../lib/user-auth";

/** Промпт вечерней сводки (pure — unit-тестируется). */
export function buildEveningPrompt(v: TodayVitals): string {
  const hh = String(Math.floor(v.localMinutes / 60)).padStart(2, "0");
  const mm = String(v.localMinutes % 60).padStart(2, "0");

  const lines: string[] = [
    "Это проактивная сессия: ВЕЧЕРНЯЯ СВОДКА ДНЯ (schedule daily-evening).",
    "Пользователь тебя не спрашивал — короткая сводка и заверши сессию.",
    "Не задавай вопросов, не жди ответа.",
    "",
    `### День ${v.today} (к ${hh}:${mm} локального времени, tz ${v.tz})`,
  ];
  if (v.kcalEaten != null) {
    lines.push(`- съедено сегодня: ${Math.round(v.kcalEaten)} ккал (${v.foodEntries} записей)`);
    lines.push(
      v.kcalTarget != null
        ? `- целевой калораж: ${v.kcalTarget} ккал/день (остаток дня: ${Math.round(v.kcalTarget - v.kcalEaten)} ккал)`
        : "- целевой калораж: не посчитан (профиль не заполнен)",
    );
  } else {
    lines.push("- еды за сегодня не записано");
  }
  if (v.steps != null) {
    lines.push(`- шагов сегодня: ${v.steps}`);
  } else {
    lines.push("- шагов сегодня: данных нет");
  }
  if (v.activeKcal != null) lines.push(`- активные калории: ${Math.round(v.activeKcal)} ккал`);

  lines.push(
    "",
    "### Как составить сводку",
    "",
    "2–4 предложения, тренды дня, без разбора по часам:",
    "- калории vs цель: если заметный перебор — отметь в твоём тоне (без нравоучений",
    "  сверх тона); если в норме — одной фразой подтвердить;",
    "- шаги: короткая оценка дня;",
    "- если записей еды нет — просто короткое напоминание внести еду дня",
    "  (это единственный случай, когда можно попросить действие);",
    "- НЕ задавай вопросов, НЕ предлагай ответить; НЕ выдумывай числа сверх блока выше.",
    "",
    "Тон — строго по твоему tone-пресету. Язык — русский. Одно сообщение.",
  );
  return lines.join("\n");
}

export default defineSchedule({
  cron: "0 * * * *",
  async run({ to, waitUntil }) {
    const startedAt = Date.now();
    log("schedule", "daily-evening-start", "info", {});

    try {
      const due = await dueDailyReminderUsers("evening");
      let userErrors = 0;

      for (const t of due) {
        try {
          const vitals = await buildTodayVitals(t.userId);
          const prompt = buildEveningPrompt(vitals);

          waitUntil(
            (async () => {
              const ok = await sendProactiveWithRetry("daily-evening", t.userId, () =>
                to(telegram, { chatId: String(t.telegramChatId) }).send(prompt, {
                  auth: userAuthFor({ telegram_chat_id: t.telegramChatId, user_id: t.userId }),
                }),
              );
              if (ok) {
                markKeySent(t.dedupKey);
                log("schedule", "daily-evening-sent", "info", {
                  user_id: t.userId,
                  local_date: t.localDate,
                  slot: t.slotLocalTime,
                });
              }
            })(),
          );
        } catch (e) {
          userErrors++;
          log("schedule", "daily-evening-user-error", "error", {
            user_id: t.userId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      log("schedule", "daily-evening-done", "info", {
        usersDue: due.length,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      log("schedule", "daily-evening-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
