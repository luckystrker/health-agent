// @ts-check
/**
 * Schedule `weekly-report` — недельный отчёт (§9, §11.1; PHASE-3 §5.1–5.2).
 *
 * Cron `0 10 * * 1` (UTC). Dispatcher-паттерн §9: schedules ходят от appAuth
 * (НЕ user-principal), поэтому per-user сообщения отправляются через
 * синтезированный user-auth (`userAuthFor`) отдельной proactive-сессией —
 * внутри неё `requireUser(ctx)` отрабатывает корректно (тон — динамическая
 * инструкция `tone.ts` сработает: `turn.started` получает `attributes.chat_id`).
 *
 * Данные бот читает из нашей БД (daily_aggregates/food_entries/weight_log —
 * §9 «важное следствие»), НЕ дёргает FatSecret user-API в фоне. Дайджест
 * собирается кодом (`lib/weekly-digest`) и встраивается в промпт: модель
 * занимается анализом/выводами/тоном, числа не транскрибируются через LLM.
 *
 * Изоляция: try/catch per-user (§16) — сбой одного юзера не роняет остальных;
 * сбойный user-loop — error-лог, обработка продолжается. Blocked-юзеры
 * пропускаются (фильтр запроса; флаг ставится при Telegram 403 — см. канал).
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { db } from "../lib/db/client";
import { users } from "../lib/db/schema";
import { log } from "../lib/log";
import { userAuthFor } from "../lib/user-auth";
import {
  MIN_DAYS_FOR_FULL_REPORT,
  buildWeeklyDigest,
  digestPromptBlock,
  type WeekDigest,
} from "../lib/weekly-digest";

/**
 * Промпт proactive-сессии отчёта (pure — unit-тестируется).
 * Требования §11.1: тренды + выводы без разбора дней; порог N=4; тон по
 * пресету (даётся динамической инструкцией); графики через render-chart.
 */
export function buildWeeklyReportPrompt(d: WeekDigest): string {
  const missingDays = d.days.length - d.daysWithData;
  return [
    "Это проактивная сессия: НЕДЕЛЬНЫЙ ОТЧЁТ по здоровью (schedule weekly-report).",
    "Пользователь тебя не спрашивал — отчёт инициируешь ты сам. Не задавай вопросов,",
    "не ожидай ответа: составь отчёт и заверши сессию одним итоговым сообщением.",
    "",
    digestPromptBlock(d),
    "",
    "## Как составить отчёт",
    "",
    `Данные собраны за ${d.days.length} завершённых локальных дней (${d.days[0]} … ${d.days[d.days.length - 1]});`,
    `сегодня (${d.today}) в окно не входит. Дней с данными часов: ${d.daysWithData}/${d.days.length}.`,
    "",
    "**Если данных совсем нет** (0/7) — не строй отчёт: короткое дружелюбное сообщение,",
    "что данных за неделю не хватает (часы не подключены / не синхронизировались?),",
    "как это поправить.",
    "",
    "**Иначе — отчёт из трендов и выводов** (БЕЗ разбора каждого дня по отдельности):",
    `- сон: средняя длительность и тренд vs предыдущая неделя${d.sleep.avgMinutes == null ? " (данных нет — пропусти пункт)" : ""};`,
    `- шаги: среднее за неделю${d.steps.avg == null ? " (данных нет — пропусти пункт)" : ""};`,
    `- вес: дельта за неделю${d.weight.deltaKg == null ? " (взвешиваний нет/мало — пропусти или мягко напомни взвеситься)" : ""};`,
    `- калории: средний баланс vs цель (${d.kcalTarget != null ? `цель ${d.kcalTarget} ккал/день` : "цель не посчитана — профиль не заполнен"}),`,
    "  сколько дней из 7 с записями; при систематическом переборе/недоборе — предупреждение",
    "  в твоём тоне, цель молча НЕ меняй: если отклонение устойчиво — предложи пересмотр;",
    `- тренировки: выполнено/минуты${d.workouts.total.count === 0 ? " (не зафиксировано — пропусти)" : ""}.`,
    "",
    `Если дней с данными < ${MIN_DAYS_FOR_FULL_REPORT} — обязательно укажи в отчёте:`,
    `"нет данных за ${missingDays} из ${d.days.length} дней" (без обвинений).`,
    "",
    "**Выводы и советы** — 2–3 конкретных пункта на основе трендов и цели пользователя,",
    "без воды и общих слов. Ссылайся на числа из блока данных.",
    "",
    "**Графики**: перед итоговым текстом вызови `render-chart` 1–2 раза:",
    '- kind "sleep" — если есть данные сна за неделю;',
    '- kind "weight" — если есть ≥2 взвешиваний (окно 30 дней по умолчанию).',
    "Если render-chart вернул ok:false — просто продолжай текстом без графика.",
    "Числа из графиков не пересказывай полностью — только главное.",
    "",
    "**Формат итогового сообщения**: одно сообщение до 4096 символов: заголовок недели,",
    "краткие тренды (списком), выводы/советы. Тон — строго по твоему tone-пресету.",
    "Язык — русский.",
  ].join("\n");
}

export default defineSchedule({
  cron: "0 10 * * 1",
  async run({ to, waitUntil }) {
    const startedAt = Date.now();
    log("schedule", "weekly-report-start", "info", {});

    let usersQueued = 0;
    let usersNoData = 0;
    let userErrors = 0;

    try {
      const userList = await db
        .select({ id: users.id, telegramChatId: users.telegramChatId })
        .from(users)
        .where(and(isNotNull(users.onboardedAt), eq(users.blocked, false)));

      for (const u of userList) {
        // Изоляция per-user: сбой одного юзера не роняет обработку остальных (§16).
        try {
          const digest = await buildWeeklyDigest(u.id);
          if (digest.daysWithData === 0 && digest.food.daysLogged === 0 && digest.weight.points.length === 0) {
            // Совсем нет данных — сессия всё равно запускается: модель вежливо
            // объяснит, что данных мало (§11.1 «нет данных вообще»).
            usersNoData++;
          }
          const prompt = buildWeeklyReportPrompt(digest);

          waitUntil(
            (async () => {
              try {
                await to(telegram, { chatId: String(u.telegramChatId) }).send(prompt, {
                  auth: userAuthFor({ telegram_chat_id: u.telegramChatId, user_id: u.id }),
                });
              } catch (e) {
                // Сбой доставки proactive-сессии (не текста): 403 помечается
                // в канале, здесь — лог без ретрая (следующий тик — через неделю).
                log("schedule", "weekly-report-send-error", "warn", {
                  user_id: u.id,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            })(),
          );
          usersQueued++;
        } catch (e) {
          userErrors++;
          log("schedule", "weekly-report-user-error", "error", {
            user_id: u.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      log("schedule", "weekly-report-done", "info", {
        usersQueued,
        usersNoData,
        userErrors,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      // Фатальный сбой джоба — не роняет процесс.
      log("schedule", "weekly-report-fatal", "error", {
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  },
});
