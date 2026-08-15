// @ts-check
/**
 * Schedule `program-check` — триггер адаптации программы (§9, §11.4; PHASE-5 §5.5).
 *
 * Cron `0 5 * * *` (ежедневно): для каждого онборженного не-blocked юзера с
 * активной программой — собрать факты (lib/program-check: логи за 7 локальных
 * дней + расписание активной версии) и прогнать анализ. При признаках
 * отставания (незалогированные сессии / просроченные pending / ≥2 skipped+
 * partial) или разовой перенесённой тренировке сегодня — proactive-сессия с
 * `userAuthFor`: агент решает (перенести / облегчить / пересобрать / оставить),
 * вызывая `reschedule`; юзер может ответить — обычный диалог.
 *
 * Dedup `(user, program-check, local_date)` in-memory (паттерн §9): ключ
 * помечается ПОСЛЕ успешной доставки. Изоляция per-user (§16).
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { keyAlreadySent, markKeySent, programCheckKey } from "../lib/alert-dedup";
import { log } from "../lib/log";
import {
  analyzeProgram,
  buildProgramCheckPrompt,
  collectProgramFacts,
} from "../lib/program-check";
import { usersWithActiveProgram } from "../lib/program-store";
import { sendProactiveWithRetry } from "../lib/proactive-send";
import { userAuthFor } from "../lib/user-auth";

export default defineSchedule({
  cron: "0 5 * * *",
  async run({ to, waitUntil }) {
    const startedAt = Date.now();
    log("schedule", "program-check-start", "info", {});

    try {
      const userList = await usersWithActiveProgram();
      let sessionsQueued = 0;
      let userErrors = 0;

      for (const u of userList) {
        // Изоляция per-user (§16): сбой одного юзера не роняет остальных.
        try {
          const facts = await collectProgramFacts(u.id);
          if (!facts) continue; // активной программы нет (могла деактивироваться)
          const analysis = analyzeProgram(facts);

          if (!analysis.triggered && analysis.pendingToday.length === 0) continue;

          const key = programCheckKey(u.id, facts.localDate);
          if (keyAlreadySent(key)) continue;

          const prompt = buildProgramCheckPrompt(facts, analysis);
          waitUntil(
            (async () => {
              const ok = await sendProactiveWithRetry("program-check", u.id, () =>
                to(telegram, { chatId: String(u.telegramChatId) }).send(prompt, {
                  auth: userAuthFor({ telegram_chat_id: u.telegramChatId, user_id: u.id }),
                }),
              );
              if (ok) {
                markKeySent(key);
                log("schedule", "program-check-sent", "info", {
                  user_id: u.id,
                  local_date: facts.localDate,
                  reasons: analysis.reasons,
                  pending_today: analysis.pendingToday.length,
                });
              }
            })(),
          );
          sessionsQueued++;
        } catch (e) {
          userErrors++;
          log("schedule", "program-check-user-error", "error", {
            user_id: u.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      log("schedule", "program-check-done", "info", {
        usersProcessed: userList.length,
        sessionsQueued,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      log("schedule", "program-check-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
