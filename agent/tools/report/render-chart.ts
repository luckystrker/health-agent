// @ts-check
/**
 * Tool `render-chart` — PNG-графики для Telegram (§8, §13; PHASE-3 §5.3).
 *
 * `chartjs-node-canvas` рендерит локально (данные здоровья не покидают
 * сервер); PNG уходит юзеру прямым `sendPhoto` (lib/telegram-send — eve не
 * поддерживает исходящие вложения в message-stream). Данные tool читает сам из
 * БД (`requireUser`), они не проходят через контекст модели.
 *
 * Дни — ЗАВЕРШЁННЫЕ локальные дни (вчера и старше; сегодня не входит, §12.3).
 *
 * Ошибки — friendly (§16): `no_data` (нет точек), `render_failed` (фолбэк на
 * текст — модель продолжает отчёт без графика, error-лог), `blocked` (403 —
 * юзер заблокировал бота, помечаем в БД), `send_failed` (сеть/429 после
 * ретраев).
 */
import { and, desc, gte, lt, eq } from "drizzle-orm";
import { defineTool } from "eve/tools";
import { z } from "zod";
import type { ChartConfiguration } from "chart.js";

import { computeCaloriePlanForUser } from "../../lib/calories";
import {
  buildCaloriesChart,
  buildSleepChart,
  buildStepsChart,
  buildWeightChart,
  type ChartKind,
  type ChartSpec,
} from "../../lib/chart-config";
import { readPeriod } from "../../lib/daily-read";
import { db } from "../../lib/db/client";
import { weightLog } from "../../lib/db/schema";
import { readFoodDays } from "../../lib/food-read";
import { log } from "../../lib/log";
import { requireUser, getUserTimezone, markBlockedByChatId } from "../../lib/tenant";
import { TelegramSendError, sendPhotoBytes } from "../../lib/telegram-send";
import { completedDaysList } from "../../lib/weekly-digest";
import { localDay, localDayRangeUtc } from "../../lib/time";

const inputSchema = z.object({
  kind: z
    .enum(["sleep", "weight", "steps", "calories"])
    .describe("Вид графика: sleep — сон по ночам; weight — тренд веса; steps — шаги; calories — потреблено vs цель."),
  days: z
    .number()
    .int()
    .min(2)
    .max(90)
    .optional()
    .describe("За сколько завершённых локальных дней (по умолчанию 7; для weight — 30)."),
  title: z.string().max(120).optional().describe("Заголовок графика (необязательно)."),
  caption: z.string().max(1000).optional().describe("Подпись к фото в Telegram (необязательно)."),
});

/** Ленивый singleton canvas-рендерера (native-модуль не грузится на build). */
let rendererPromise: Promise<{
  renderToBuffer: (configuration: ChartConfiguration) => Promise<Buffer>;
}> | null = null;

async function getRenderer() {
  // `type` не задаём: PNG — дефолт (типизировано только 'pdf' | 'svg').
  rendererPromise ??= import("chartjs-node-canvas").then(
    (m) =>
      new m.ChartJSNodeCanvas({
        width: 800,
        height: 450,
        backgroundColour: "#ffffff",
      }),
  );
  return rendererPromise;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export default defineTool({
  description:
    "Собрать PNG-график и отправить его пользователю в Telegram (sendPhoto). Данные " +
    "читает сам (из БД, за завершённые локальные дни). Виды: sleep (сон по ночам, ч), " +
    "weight (тренд веса, ≥2 взвешиваний), steps (шаги), calories (потреблено vs цель). " +
    "Возвращает ok:true (отправлено) или ok:false с reason: no_data / render_failed " +
    "(продолжай текстом без графика) / blocked / send_failed.",
  inputSchema,
  async execute({ kind, days, title, caption }, ctx) {
    const { userId, chatId } = await requireUser(ctx);
    const tz = await getUserTimezone(userId);
    const dayCount = days ?? (kind === "weight" ? 30 : 7);
    const dayList = completedDaysList(tz, dayCount);

    // ── Данные → ChartSpec ──────────────────────────────────────────────────
    let spec: ChartSpec | null;
    try {
      spec = await buildSpec(kind as ChartKind, userId, tz, dayList, title);
    } catch (e) {
      log("tool", "render-chart-data-error", "error", {
        user_id: userId,
        kind,
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, reason: "no_data", message: "Не удалось собрать данные для графика." };
    }
    if (spec === null) {
      return {
        ok: false,
        reason: "no_data",
        message:
          kind === "weight"
            ? "Для тренда веса нужно минимум 2 взвешивания за период — данных пока нет."
            : "За выбранный период нет данных для этого графика.",
      };
    }

    // ── Рендер PNG (локально, §13) ──────────────────────────────────────────
    let png: Buffer;
    try {
      const renderer = await getRenderer();
      png = await renderer.renderToBuffer(spec as unknown as ChartConfiguration);
    } catch (e) {
      log("tool", "render-chart-render-error", "error", {
        user_id: userId,
        kind,
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        reason: "render_failed",
        message: "График не отрисовался — продолжай текстом без него.",
      };
    }

    // ── sendPhoto + 403/429-обработка (§16) ─────────────────────────────────
    let daysPlotted = dayList.length;
    if (kind === "weight") {
      // points хранятся в spec.datasets[0].data (labels = дни)
      daysPlotted = spec.data.datasets[0].data.filter((d) => d != null).length;
    }
    const missingDays =
      kind === "weight"
        ? 0
        : spec.data.datasets[0].data.filter((d) => d == null).length;

    try {
      await sendPhotoBytes({ chatId, png: new Uint8Array(png), caption });
      return { ok: true, kind, days_plotted: daysPlotted, missing_days: missingDays };
    } catch (e) {
      if (e instanceof TelegramSendError) {
        if (e.kind === "forbidden") {
          try {
            await markBlockedByChatId(chatId);
          } catch (dbError) {
            log("auth", "user-blocked-403-db-error", "error", {
              chat_id: chatId,
              error: dbError instanceof Error ? dbError.message : String(dbError),
            });
          }
          log("auth", "user-blocked-403", "info", { chat_id: chatId });
          return { ok: false, reason: "blocked", message: "Пользователь заблокировал бота." };
        }
        log("tool", "render-chart-send-error", "warn", {
          user_id: userId,
          kind: e.kind,
          status: e.status ?? null,
        });
        return {
          ok: false,
          reason: "send_failed",
          message: "Не удалось отправить график в Telegram — продолжай текстом.",
        };
      }
      throw e;
    }
  },
});

/** Данные по kind → ChartSpec (null — нет точек). */
async function buildSpec(
  kind: ChartKind,
  userId: string,
  tz: string,
  dayList: string[],
  title?: string,
): Promise<ChartSpec | null> {
  switch (kind) {
    case "sleep": {
      const period = await readPeriod(userId, tz, dayList, ["sleep"]);
      const minutes = dayList.map((d) => num(period.get(d)?.get("sleep")?.value.total_minutes));
      return buildSleepChart({ days: dayList, minutes, title });
    }
    case "steps": {
      const period = await readPeriod(userId, tz, dayList, ["steps"]);
      const steps = dayList.map((d) => num(period.get(d)?.get("steps")?.value.total_steps));
      return buildStepsChart({ days: dayList, steps, title });
    }
    case "calories": {
      const [foodDays, plan] = await Promise.all([
        readFoodDays(userId, dayList),
        computeCaloriePlanForUser(userId).catch(() => null),
      ]);
      // День без записей → null на графике (не записывал ≠ 0 ккал).
      const kcal = dayList.map((d) => {
        const f = foodDays.get(d);
        return f && f.entries.length > 0 ? f.totals.kcal : null;
      });
      return buildCaloriesChart({
        days: dayList,
        kcal,
        targetKcal: plan?.plan.targetKcal ?? null,
        title,
      });
    }
    case "weight": {
      const windowStart = localDayRangeUtc(dayList[0], tz).start;
      const rows = await db
        .select({ weightKg: weightLog.weightKg, measuredAt: weightLog.measuredAt })
        .from(weightLog)
        .where(
          and(
            eq(weightLog.userId, userId),
            gte(weightLog.measuredAt, windowStart),
            lt(weightLog.measuredAt, new Date()),
          ),
        )
        .orderBy(desc(weightLog.measuredAt))
        .limit(120);
      const points = rows
        .map((r) => ({ day: localDay(r.measuredAt, tz), kg: r.weightKg }))
        .reverse();
      return buildWeightChart({ points, title });
    }
  }
}
