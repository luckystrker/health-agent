// @ts-check
/**
 * Schedule `daily-morning` — утренняя напоминалка (§9; PHASE-4 §5.1–5.2).
 *
 * Cron `0 * * * *` (почасовой тик): для каждого онборженного не-blocked юзера
 * fuzzy-сверка morning-слота ±30 мин в ЛОКАЛЬНОМ времени (почасовой тик нужен —
 * разовый UTC-тик не покрывает слоты юзеров в разных tz, §9). Повтор в ту же
 * локальную дату подавлен dedup (lib/alert-dedup).
 *
 * Напоминание: «внести ужин / взвеситься» (§9). Факты (записан ли вчерашний
 * ужин, было ли взвешивание, сон ночи) собирает lib/today-vitals — модель
 * упоминает только то, чего не хватает; если всё есть — короткое «доброе утро».
 * Тон — tone-пресет юзера (динамическая инструкция сработает в синтезированной
 * сессии, PHASE-3 §5.1). Изоляция per-user (§16).
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { markKeySent } from "../lib/alert-dedup";
import { dueDailyReminderUsers } from "../lib/daily-reminders";
import { log } from "../lib/log";
import { sendProactiveWithRetry } from "../lib/proactive-send";
import { buildMorningFacts, type MorningFacts } from "../lib/today-vitals";
import { userAuthFor } from "../lib/user-auth";
import { minutesToHoursStr } from "../lib/weekly-digest";

/** Промпт утренней напоминалки (pure — unit-тестируется). */
export function buildMorningPrompt(f: MorningFacts): string {
  const lines: string[] = [
    "Это проактивная сессия: УТРЕННЕЕ НАПОМИНАНИЕ (schedule daily-morning).",
    "Пользователь тебя не спрашивал — короткое сообщение и заверши сессию.",
    "Не задавай вопросов, не жди ответа.",
    "",
    "### Факты утра",
  ];
  if (f.sleep != null) {
    lines.push(
      `- сон прошлой ночи: ${f.sleep.totalMinutes} мин (${minutesToHoursStr(f.sleep.totalMinutes)} ч), отбой ${f.sleep.bedtimeLocal}, подъём ${f.sleep.wakeLocal || "—"}`,
    );
  } else {
    lines.push("- сон за ночь: данных нет (не упоминай отсутствие как проблему)");
  }
  lines.push(`- вчерашний ужин записан: ${f.dinnerLoggedYesterday ? "да" : "нет"}`);
  lines.push(`- взвешивался (с вчерашнего дня): ${f.weighedRecently ? "да" : "нет"}`);
  lines.push(
    "- если сна нет данных — не делай выводов о нём, просто не упоминай.",
    "",
    "### Как составить сообщение",
    "",
    "1–3 предложения, один смысл:",
    "- если ужин НЕ записан — мягко напомни внести вчерашний ужин;",
    "- если НЕ взвешивался — напомни взвеситься (утро — лучшее время);",
    "- если и ужин записан, и вес есть — не напоминай ничего: короткое доброе",
    "  утро (можно одной фразой отметить сон, если он есть);",
    "- НЕ перечисляй факты списком, НЕ используй слова «факт», «данные».",
    "",
    "Тон — строго по твоему tone-пресету. Язык — русский. Одно сообщение.",
  );
  return lines.join("\n");
}

export default defineSchedule({
  cron: "0 * * * *",
  async run({ to, waitUntil }) {
    const startedAt = Date.now();
    log("schedule", "daily-morning-start", "info", {});

    try {
      const due = await dueDailyReminderUsers("morning");
      let userErrors = 0;

      for (const t of due) {
        // Изоляция per-user: сбой одного юзера не роняет обработку остальных (§16).
        try {
          const facts = await buildMorningFacts(t.userId);
          const prompt = buildMorningPrompt(facts);

          waitUntil(
            (async () => {
              const ok = await sendProactiveWithRetry("daily-morning", t.userId, () =>
                to(telegram, { chatId: String(t.telegramChatId) }).send(prompt, {
                  auth: userAuthFor({ telegram_chat_id: t.telegramChatId, user_id: t.userId }),
                }),
              );
              if (ok) {
                markKeySent(t.dedupKey);
                log("schedule", "daily-morning-sent", "info", {
                  user_id: t.userId,
                  local_date: t.localDate,
                  slot: t.slotLocalTime,
                });
              }
            })(),
          );
        } catch (e) {
          userErrors++;
          log("schedule", "daily-morning-user-error", "error", {
            user_id: t.userId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      log("schedule", "daily-morning-done", "info", {
        usersDue: due.length,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      // Фатальный сбой джоба (напр. БД) — не роняет процесс; retry на следующем тике.
      log("schedule", "daily-morning-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
