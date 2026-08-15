// @ts-check
/**
 * Tool `reschedule` — перенос/облегчение/пересборка (§8, §11.4; PHASE-5 §5.4).
 *
 * Четыре режима:
 *  - `move_once`  — разовый перенос: лог исходного дня (status='rescheduled',
 *                  performed_at=now) + лог новой даты (status='pending');
 *                  program_sessions и workout_times НЕ трогаются (регулярное
 *                  расписание то же). Повторный перенос — двигает pending-строку.
 *  - `move_weekly`— регулярный перенос дня недели: program_sessions from→to +
 *                  ОБЯЗАТЕЛЬНЫЙ sync reminder_settings.workout_times (иначе
 *                  workout-reminder фазы 4 продолжит звать на старый день).
 *  - `lighten`    — облегчение: правка sets/reps текущей версии (без новой
 *                  версии; множители или явные значения).
 *  - `rebuild`    — пересборка: новая version (как build-program save; упражнения
 *                  предварительно подбираются через build-program search).
 *
 * `rescheduled` в workout_logs проставляется ТОЛЬКО здесь (log-workout умеет
 * completed/skipped/partial — см. §5.3 PHASE-5).
 */
import { defineTool } from "eve/tools";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { workoutLogs } from "../../lib/db/schema";
import { log } from "../../lib/log";
import {
  dayOfWeekOf,
  getActiveProgram,
  getWorkoutTimes,
  isFutureLocalDay,
  lightenProgram,
  moveProgramDay,
  moveSlotsDay,
  PENDING_ORIGIN_PREFIX,
  pendingOriginFromNotes,
  saveProgramFromParams,
  scaleRepsText,
  scaleSets,
  setWorkoutTimes,
} from "../../lib/program-store";
import { getUserTimezone, requireUser } from "../../lib/tenant";
import { localDay } from "../../lib/time";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStr = z.string().regex(DAY_RE).describe('Локальная дата "YYYY-MM-DD".');
const dayOfWeek = z.number().int().min(0).max(6).describe("День недели: 0=вс … 6=сб");
const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe('Локальное время "HH:MM"');

const exercise = z.object({
  wger_exercise_id: z.number().int().min(1),
  exercise_name_en: z.string().trim().min(1).max(300),
  sets: z.number().int().min(1).max(20).optional(),
  reps: z.string().trim().max(30).optional(),
});
const sessionDay = z.object({ day_of_week: dayOfWeek, exercises: z.array(exercise).min(1).max(15) });

const inputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("move_once"),
    from_scheduled_day: dayStr.describe("Дата переносимой тренировки."),
    to_scheduled_day: dayStr.describe("Новая дата (разовое исключение, не день недели)."),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({
    mode: z.literal("move_weekly"),
    from_day_of_week: dayOfWeek,
    to_day_of_week: dayOfWeek,
    local_time: hhmm.optional().describe("Новое время напоминания (если меняется)."),
  }),
  z.object({
    mode: z.literal("lighten"),
    day_of_week: dayOfWeek.optional().describe("День; не задан — все дни программы."),
    sets_factor: z.number().min(0.1).max(2).optional().describe("Множитель подходов, напр. 0.8."),
    reps_factor: z.number().min(0.1).max(2).optional().describe("Множитель повторов, напр. 0.8."),
    sets: z.number().int().min(1).max(20).optional().describe("Явное новое число подходов."),
    reps: z.string().trim().max(30).optional().describe("Явные новые повторы."),
  }),
  z.object({
    mode: z.literal("rebuild"),
    goal_kind: z.enum(["weight_loss", "maintenance", "muscle_gain"]).optional(),
    frequency_per_week: z.number().int().min(1).max(7),
    equipment: z.array(z.enum(["home", "gym", "outdoor"])).max(3),
    session_duration_min: z.number().int().min(10).max(240).optional(),
    constraints: z.string().trim().max(500).optional(),
    sessions: z.array(sessionDay).min(1).max(7),
    suggested_times: z
      .array(z.object({ day_of_week: dayOfWeek, local_time: hhmm }))
      .max(7)
      .optional(),
  }),
]);

/** Дата "YYYY-MM-DD" → Date для date-колонки (UTC-полночь, как food_entries.day). */
function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export default defineTool({
  description:
    "Перенести/облегчить/пересобрать тренировку или программу. Разовый перенос «сегодня не " +
    "могу, сделаю в ЧТ» — move_once (регулярное расписание не меняется). Постоянный перенос " +
    "на другой день недели — move_weekly (обновляет и напоминания). Сделать полегче — lighten. " +
    "Полная пересборка — rebuild (упражнения подбери заранее через build-program search). " +
    "Вызывается юзером вручную или из проактивной сессии program-check.",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);

    // ── move_once: разовый перенос ───────────────────────────────────────────
    if (input.mode === "move_once") {
      if (input.from_scheduled_day === input.to_scheduled_day) {
        return { ok: false, error: "same_day", message: "Даты переноса совпадают." };
      }
      // Guard (review P2): перенос «в прошлое» не имеет смысла — прошедшее
      // отмечается через log-workout.
      const tz = await getUserTimezone(userId);
      const today = localDay(new Date(), tz);
      if (input.to_scheduled_day < today) {
        return {
          ok: false,
          error: "move_to_past",
          message:
            `${input.to_scheduled_day} уже прошло — переносить можно только на сегодня или ` +
            "будущую дату. Прошедшую тренировку отметь через log-workout.",
        };
      }
      const active = await getActiveProgram(userId);
      if (!active) {
        return { ok: false, error: "no_active_program", message: "Нет активной программы — переносить нечего." };
      }
      const version = active.program.version;
      const fromDayDate = dayToDate(input.from_scheduled_day);

      // Guard (review P2): уже выполненная/пропущенная тренировка не переносится.
      const marked = await db
        .select({ status: workoutLogs.status })
        .from(workoutLogs)
        .where(
          and(
            eq(workoutLogs.userId, userId),
            eq(workoutLogs.scheduledDay, fromDayDate),
            inArray(workoutLogs.status, ["completed", "partial", "skipped"]),
          ),
        )
        .orderBy(desc(workoutLogs.id))
        .limit(1);
      if (marked.length > 0) {
        return {
          ok: false,
          error: "already_logged",
          message:
            `Тренировка за ${input.from_scheduled_day} уже отмечена (${marked[0].status}) — ` +
            "переносить отмеченную нельзя.",
        };
      }

      // Pending ищем по прямой дате ИЛИ по исходной дате в notes (review P2:
      // повторный перенос «от исходной даты» не должен плодить вторую пару).
      let pending = await db
        .select({ id: workoutLogs.id, notes: workoutLogs.notes })
        .from(workoutLogs)
        .where(
          and(
            eq(workoutLogs.userId, userId),
            eq(workoutLogs.scheduledDay, fromDayDate),
            eq(workoutLogs.status, "pending"),
          ),
        )
        .orderBy(desc(workoutLogs.id))
        .limit(1);
      if (pending.length === 0) {
        pending = await db
          .select({ id: workoutLogs.id, notes: workoutLogs.notes })
          .from(workoutLogs)
          .where(
            and(
              eq(workoutLogs.userId, userId),
              eq(workoutLogs.status, "pending"),
              like(workoutLogs.notes, `${PENDING_ORIGIN_PREFIX}${input.from_scheduled_day}%`),
            ),
          )
          .orderBy(desc(workoutLogs.id))
          .limit(1);
      }

      if (pending.length > 0) {
        // Двигаем существующий pending; notes хранит ИСХОДНУЮ дату сессии.
        const origin = pendingOriginFromNotes(pending[0].notes) ?? input.from_scheduled_day;
        await db
          .update(workoutLogs)
          .set({
            scheduledDay: dayToDate(input.to_scheduled_day),
            notes: `${PENDING_ORIGIN_PREFIX}${origin}${input.note ? `: ${input.note}` : ""}`,
          })
          .where(eq(workoutLogs.id, pending[0].id));
        log("tool", "reschedule-move-once-updated", "info", {
          user_id: userId,
          origin,
          to: input.to_scheduled_day,
        });
        return {
          ok: true,
          mode: "move_once",
          from: input.from_scheduled_day,
          to: input.to_scheduled_day,
          origin,
          updated_pending: true,
        };
      }

      // Обычный случай: исходная дата должна быть днём программы.
      const fromDow = dayOfWeekOf(input.from_scheduled_day);
      if (!active.sessions.some((s) => s.dayOfWeek === fromDow)) {
        return {
          ok: false,
          error: "not_program_day",
          message:
            `${input.from_scheduled_day} — не день программы (нет сессий на этот день недели). ` +
            "Для разовой даты переносят существующий день программы или pending-перенос.",
        };
      }

      await db.insert(workoutLogs).values([
        {
          userId,
          programVersion: version,
          scheduledDay: fromDayDate,
          performedAt: new Date(),
          status: "rescheduled",
          notes: `перенесено на ${input.to_scheduled_day}${input.note ? `: ${input.note}` : ""}`,
          source: "manual",
        },
        {
          userId,
          programVersion: version,
          scheduledDay: dayToDate(input.to_scheduled_day),
          performedAt: null,
          status: "pending",
          notes: `${PENDING_ORIGIN_PREFIX}${input.from_scheduled_day}`,
          source: "manual",
        },
      ]);
      log("tool", "reschedule-move-once-created", "info", {
        user_id: userId,
        from: input.from_scheduled_day,
        to: input.to_scheduled_day,
      });
      return {
        ok: true,
        mode: "move_once",
        from: input.from_scheduled_day,
        to: input.to_scheduled_day,
        log_rows: 2,
        workout_times_unchanged: true,
        hint:
          "Напоминания по регулярному расписанию не менялись; про новую дату юзера напомнит " +
          "program-check в этот день.",
      };
    }

    // ── move_weekly: регулярный перенос ──────────────────────────────────────
    if (input.mode === "move_weekly") {
      if (input.from_day_of_week === input.to_day_of_week) {
        return { ok: false, error: "same_day", message: "Дни переноса совпадают." };
      }
      const moved = await moveProgramDay(userId, input.from_day_of_week, input.to_day_of_week);
      if (moved === 0) {
        return {
          ok: false,
          error: "no_sessions_on_day",
          message: "В активной программе нет сессий на этот день недели.",
        };
      }

      // Sync напоминаний (§5.4): слоты from_dow → to_dow, время сохраняется
      // (или новое, если передано). Слотов под from_dow не было — не изобретаем.
      const current = await getWorkoutTimes(userId);
      let workoutTimes = current;
      if (current) {
        let movedSlots = moveSlotsDay(current, input.from_day_of_week, input.to_day_of_week);
        if (input.local_time) {
          const newTime = input.local_time;
          movedSlots = movedSlots.map((s) =>
            s.day_of_week === input.to_day_of_week ? { ...s, local_time: newTime } : s,
          );
        }
        if (movedSlots.length > 0) {
          await setWorkoutTimes(userId, movedSlots);
          workoutTimes = movedSlots;
        }
      }
      log("tool", "reschedule-move-weekly", "info", {
        user_id: userId,
        moved,
        from_dow: input.from_day_of_week,
        to_dow: input.to_day_of_week,
      });
      return { ok: true, mode: "move_weekly", moved_sessions: moved, workout_times: workoutTimes };
    }

    // ── lighten: облегчение ──────────────────────────────────────────────────
    if (input.mode === "lighten") {
      if (
        input.sets_factor == null && input.reps_factor == null &&
        input.sets == null && input.reps == null
      ) {
        return {
          ok: false,
          error: "no_changes",
          message: "Укажи хотя бы одно изменение (sets_factor / reps_factor / sets / reps).",
        };
      }
      const updated = await lightenProgram(userId, input.day_of_week ?? null, (row) => ({
        sets: input.sets != null ? input.sets : input.sets_factor != null ? scaleSets(row.sets, input.sets_factor) : row.sets,
        reps: input.reps != null ? input.reps : input.reps_factor != null ? scaleRepsText(row.reps, input.reps_factor) : row.reps,
      }));
      if (updated === 0) {
        return { ok: false, error: "nothing_to_update", message: "Нет сессий под изменение (программа активна?)." };
      }
      log("tool", "reschedule-lighten", "info", {
        user_id: userId,
        updated,
        day_of_week: input.day_of_week ?? null,
      });
      return { ok: true, mode: "lighten", updated_sessions: updated };
    }

    // ── rebuild: пересборка (новая version) ──────────────────────────────────
    const saved = await saveProgramFromParams(userId, input);
    if (!saved.ok) return saved;
    const { result } = saved;
    log("tool", "reschedule-rebuild", "info", {
      user_id: userId,
      version: result.version,
      days: result.days,
    });
    if (result.times.state === "applied") {
      return {
        ok: true,
        mode: "rebuild",
        version: result.version,
        days: result.days,
        workout_times_state: "applied",
        workout_times: result.times.workoutTimes,
      };
    }
    return {
      ok: true,
      mode: "rebuild",
      version: result.version,
      days: result.days,
      workout_times_state: "needs_confirmation",
      current_times: result.times.currentTimes,
      suggested_times: result.times.suggestedTimes,
      hint:
        "У пользователя были свои напоминания о тренировках. Спроси через ask_question: " +
        "«Заменить напоминания под новую программу?» (replace/keep/merge) и примени ответ " +
        "через build-program action='apply_times'.",
    };
  },
});
