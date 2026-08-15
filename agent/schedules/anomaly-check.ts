// @ts-check
/**
 * Schedule `anomaly-check` — детектор аномалий (§9, §11.5; PHASE-4 §5.4–5.5).
 *
 * Cron — каждые 30 минут (`30 * * * *` c шагом): для каждого онборженного не-blocked
 * юзера — собрать
 * входы (lib/anomalies: текущий день из raw_samples, базовая линия из
 * daily_aggregates, вес из weight_log, цель из lib/calories — чистый код, НЕ
 * LLM-tools) и прогнать 4 порога. Сработавшие аномалии склеиваются в ОДНО
 * сообщение (не спамить); rate-limit — не чаще 1 алерта типа на юзер×день
 * (lib/alert-dedup, in-memory). «Нет данных» — не алертим (§12.2).
 *
 * Тон алерта — tone-пресет юзера; вес — информационно. Изоляция per-user;
 * БД-сбой → warn/error-лог, retry на следующем тике (§16).
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import {
  collectAnomalyInputs,
  detectAnomalies,
  anomaliesPromptBlock,
  type Anomaly,
} from "../lib/anomalies";
import { anomalyAlertKey, keyAlreadySent, markKeySent } from "../lib/alert-dedup";
import { log } from "../lib/log";
import { sendProactiveWithRetry } from "../lib/proactive-send";
import { userAuthFor } from "../lib/user-auth";
import { db } from "../lib/db/client";
import { users } from "../lib/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";

/** Промпт алерта аномалий (pure — unit-тестируется). */
export function buildAnomalyPrompt(anomalies: Anomaly[], localDate: string): string {
  return [
    "Это проактивная сессия: АЛЕРТ ОБ АНОМАЛИИ (schedule anomaly-check).",
    "Пользователь тебя не спрашивал — короткое сообщение и заверши сессию.",
    "Не задавай вопросов, не жди ответа.",
    "",
    `### Сработавшие аномалии (локальный день ${localDate})`,
    "",
    anomaliesPromptBlock(anomalies),
    "",
    "### Как составить алерт",
    "",
    "Одно сообщение; на каждую аномалию — 1–3 предложения:",
    "- используй ТОЛЬКО числа из блока выше, ничего не пересчитывай и не добавляй;",
    "- «Скачок веса» — информационно: без тревоги, обычная вариативность веса",
    "  велика (вода/соль/время взвешивания); просто зафиксируй факт;",
    "- сон/калории/активность — забота или строгость ровно в меру твоего тона;",
    "- можно добавить ОДИН короткий конкретный совет на ближайшее действие;",
    "- не сыпь порогами как техническими деталями — говори по-человечески.",
    "",
    "Тон — строго по твоему tone-пресету. Язык — русский.",
  ].join("\n");
}

export default defineSchedule({
  cron: "*/30 * * * *",
  async run({ to, waitUntil }) {
    const startedAt = Date.now();
    log("schedule", "anomaly-check-start", "info", {});

    try {
      const userList = await db
        .select({ id: users.id, telegramChatId: users.telegramChatId })
        .from(users)
        .where(and(isNotNull(users.onboardedAt), eq(users.blocked, false)));

      let alertsQueued = 0;
      let userErrors = 0;

      for (const u of userList) {
        // Изоляция per-user (§16): сбой сбора данных одного юзера не роняет остальных.
        try {
          const inputs = await collectAnomalyInputs(u.id);
          const fired = detectAnomalies(inputs);
          if (fired.length === 0) continue;

          // Rate-limit (§11.5): только типы, не отправлявшиеся в эту локальную дату.
          const toSend = fired.filter((a) => !keyAlreadySent(anomalyAlertKey(u.id, a.type, inputs.localDate)));
          if (toSend.length === 0) continue;

          const prompt = buildAnomalyPrompt(toSend, inputs.localDate);
          const sentTypes = toSend.map((a) => a.type);

          waitUntil(
            (async () => {
              const ok = await sendProactiveWithRetry("anomaly-check", u.id, () =>
                to(telegram, { chatId: String(u.telegramChatId) }).send(prompt, {
                  auth: userAuthFor({ telegram_chat_id: u.telegramChatId, user_id: u.id }),
                }),
              );
              if (ok) {
                for (const type of sentTypes) {
                  markKeySent(anomalyAlertKey(u.id, type, inputs.localDate));
                }
                log("schedule", "anomaly-check-sent", "info", {
                  user_id: u.id,
                  local_date: inputs.localDate,
                  types: sentTypes,
                });
              }
            })(),
          );
          alertsQueued++;
        } catch (e) {
          userErrors++;
          log("schedule", "anomaly-check-user-error", "error", {
            user_id: u.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      log("schedule", "anomaly-check-done", "info", {
        usersProcessed: userList.length,
        alertsQueued,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      log("schedule", "anomaly-check-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
