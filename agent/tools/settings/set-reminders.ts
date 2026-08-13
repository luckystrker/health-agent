// @ts-check
import { defineTool } from "eve/tools";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { reminderSettings, type WorkoutTimeSlot } from "../../lib/db/schema";
import { requireUser } from "../../lib/tenant";

const hhmm = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .describe("Время в формате HH:MM (локальное для tz юзера)");

// Каждое поле: undefined → не трогать; null → сбросить (NULL); значение → поставить.
const timeField = z.union([hhmm, z.null()]).optional();
const workoutTimesField = z
  .union([
    z.array(
      z.object({
        day_of_week: z.number().int().min(0).max(6).describe("День недели: 0=вс … 6=сб"),
        local_time: hhmm,
      }),
    ),
    z.null(),
  ])
  .optional();

const inputSchema = z.object({
  morning_local: timeField.describe("Время утреннего напоминания (HH:MM) или null для отключения"),
  midday_local: timeField.describe("Время дневного напоминания (HH:MM) или null для отключения"),
  evening_local: timeField.describe("Время вечернего напоминания (HH:MM) или null для отключения"),
  workout_times: workoutTimesField.describe(
    "Слоты тренировок [{day_of_week, local_time}], null для очистки",
  ),
});

export default defineTool({
  description:
    "Настроить напоминания: время утра/дня/вечера и слоты тренировок. Время — " +
    "локальное (в tz юзера). Используется на онбординге (шаг 9). Можно вызывать " +
    "частично: незаданное поле (undefined) не трогается; null — сбрасывает в NULL " +
    "(отключает напоминание).",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);

    const workoutTimes: WorkoutTimeSlot[] | null = input.workout_times ?? null;

    // Частичное обновление: в set включаем только переданные поля.
    const set: Partial<typeof reminderSettings.$inferInsert> = {};
    if (input.morning_local !== undefined) set.morningLocal = input.morning_local;
    if (input.midday_local !== undefined) set.middayLocal = input.midday_local;
    if (input.evening_local !== undefined) set.eveningLocal = input.evening_local;
    if (input.workout_times !== undefined) set.workoutTimes = workoutTimes;

    // values для первичной вставки: незаданные → null.
    await db
      .insert(reminderSettings)
      .values({
        userId,
        morningLocal: input.morning_local ?? null,
        middayLocal: input.midday_local ?? null,
        eveningLocal: input.evening_local ?? null,
        workoutTimes,
      })
      .onConflictDoUpdate({
        target: reminderSettings.userId,
        set,
      });

    return {
      ok: true,
      reminders: {
        morning_local: input.morning_local ?? null,
        midday_local: input.midday_local ?? null,
        evening_local: input.evening_local ?? null,
        workout_times: input.workout_times ?? null,
      },
    };
  },
});
