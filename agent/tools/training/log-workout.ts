// @ts-check
/**
 * Tool `log-workout` — отметка выполнения сессии плана (§8, §11.4; PHASE-5 §5.3).
 *
 * Три статуса: completed / skipped / partial. `rescheduled` проставляется
 * ТОЛЬКО инструментом `reschedule` (и `pending` — его же разовые переносы);
 * сюда они не входят.
 *
 * Валидация (§5.3): scheduled_day должен существовать в активной программе —
 * либо это день недели с program_sessions, либо дата разового переноса
 * (pending-строка от reschedule move_once). Повторная отметка той же даты
 * обновляет существующую строку (не плодит дубли).
 */
import { defineTool } from "eve/tools";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { workoutLogs } from "../../lib/db/schema";
import { log } from "../../lib/log";
import { dayOfWeekOf, getActiveProgram, isFutureLocalDay } from "../../lib/program-store";
import { getUserTimezone, requireUser } from "../../lib/tenant";
import { localDay } from "../../lib/time";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z.object({
  scheduled_day: z
    .string()
    .regex(DAY_RE)
    .describe('Локальная дата "YYYY-MM-DD", к которой относится сессия плана.'),
  status: z.enum(["completed", "skipped", "partial"]),
  notes: z.string().trim().max(500).optional(),
});

function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export default defineTool({
  description:
    "Отметить выполнение тренировки из программы: completed (сделал), skipped (пропустил), " +
    "partial (частично). Дата — день плана (scheduled_day). Для разовой перенесённой тренировки " +
    "указывай её новую дату. Отметка «перенесено» делается не здесь, а инструментом reschedule.",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);

    // Guard (review P2): будущую тренировку отметить нельзя.
    const tz = await getUserTimezone(userId);
    const today = localDay(new Date(), tz);
    if (isFutureLocalDay(input.scheduled_day, today)) {
      return {
        ok: false,
        error: "day_in_future",
        message: `${input.scheduled_day} ещё не наступил(а) — отметить будущую тренировку нельзя.`,
      };
    }

    const active = await getActiveProgram(userId);
    if (!active) {
      return {
        ok: false,
        error: "no_active_program",
        message: "Нет активной тренировочной программы — отмечать нечего.",
      };
    }
    const version = active.program.version;
    const dayDate = dayToDate(input.scheduled_day);

    // Существующую строку ищем БЕЗ фильтра версии (review P1): pending разового
    // переноса мог быть создан до пересборки программы (saveProgramVersion
    // перецепляет такие строки, но ищем надёжно по любой версии).
    const existing = await db
      .select({ id: workoutLogs.id, status: workoutLogs.status })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, userId), eq(workoutLogs.scheduledDay, dayDate)))
      .orderBy(desc(workoutLogs.id))
      .limit(1);

    const isProgramDay = active.sessions.some(
      (s) => s.dayOfWeek === dayOfWeekOf(input.scheduled_day),
    );
    if (existing.length === 0 && !isProgramDay) {
      return {
        ok: false,
        error: "day_not_in_program",
        message:
          `${input.scheduled_day} — не день программы (нет сессий на этот день недели) и нет ` +
          "разового переноса на эту дату. Отмечай дни своей программы либо дату переноса.",
      };
    }

    const performedAt = new Date();
    if (existing.length > 0) {
      // Повторная отметка / закрытие pending — обновляем строку, дубли не плодим.
      await db
        .update(workoutLogs)
        .set({ status: input.status, performedAt, notes: input.notes ?? null })
        .where(eq(workoutLogs.id, existing[0].id));
      log("tool", "log-workout-updated", "info", {
        user_id: userId,
        scheduled_day: input.scheduled_day,
        status: input.status,
        prev_status: existing[0].status,
      });
      return {
        ok: true,
        id: existing[0].id,
        updated: true,
        scheduled_day: input.scheduled_day,
        status: input.status,
      };
    }

    const inserted = await db
      .insert(workoutLogs)
      .values({
        userId,
        programVersion: version,
        scheduledDay: dayDate,
        performedAt,
        status: input.status,
        notes: input.notes ?? null,
        source: "manual",
      })
      .returning({ id: workoutLogs.id });
    log("tool", "log-workout-created", "info", {
      user_id: userId,
      scheduled_day: input.scheduled_day,
      status: input.status,
    });
    return {
      ok: true,
      id: inserted[0].id,
      updated: false,
      scheduled_day: input.scheduled_day,
      status: input.status,
    };
  },
});
