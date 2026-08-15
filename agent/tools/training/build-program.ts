// @ts-check
/**
 * Tool `build-program` — построение тренировочной программы (§6.3, §8, §11.4;
 * PHASE-5 §5.1–5.2).
 *
 * Четыре действия:
 *  - `catalog`     — таксономии wger (категории/оборудование/мышцы) для маппинга
 *                   «дом/зал/улица» → id фильтров;
 *  - `search`      — поиск упражнений wger (структура + RU-перевод, если есть;
 *                   иначе агент переводит EN на русский на лету);
 *  - `save`        — записать программу: новая активная версия
 *                   `workout_programs` + строки `program_sessions` (прежняя
 *                   active=false одной транзакцией). Наполнение
 *                   `reminder_settings.workout_times`: пустые → записать без
 *                   вопроса; непустые → needs_confirmation (модель спрашивает
 *                   «Заменить / Оставить мои / Смешать» через ask_question);
 *  - `apply_times` — применить выбор юзера по подтверждению (replace/merge/keep).
 *
 * План = совокупность строк program_sessions (колонки workout_programs.plan нет).
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { log } from "../../lib/log";
import { applyWorkoutTimesChoice, saveProgramFromParams } from "../../lib/program-store";
import { requireUser } from "../../lib/tenant";
import {
  clampText,
  getTaxonomies,
  searchExercises,
  wgerErrorPayload,
} from "../../lib/wger";

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe('Локальное время "HH:MM" (в tz юзера)');

const dayOfWeek = z
  .number()
  .int()
  .min(0)
  .max(6)
  .describe("День недели: 0=вс … 6=сб");

const slot = z.object({ day_of_week: dayOfWeek, local_time: hhmm });

const exercise = z.object({
  wger_exercise_id: z.number().int().min(1).describe("id упражнения из wger (search)."),
  exercise_name_en: z.string().trim().min(1).max(300).describe("Английское имя из wger (кэш)."),
  sets: z.number().int().min(1).max(20).optional(),
  reps: z.string().trim().max(30).optional().describe("Повторы, напр. '8-12' / '30s' / 'до отказа'."),
});

const sessionDay = z.object({
  day_of_week: dayOfWeek,
  exercises: z.array(exercise).min(1).max(15),
});

const programSaveSchema = {
  goal_kind: z
    .enum(["weight_loss", "maintenance", "muscle_gain"])
    .optional()
    .describe("Цель программы; по умолчанию — активная цель пользователя."),
  frequency_per_week: z.number().int().min(1).max(7),
  equipment: z
    .array(z.enum(["home", "gym", "outdoor"]))
    .max(3)
    .describe("Оборудование: 'home' | 'gym' | 'outdoor' (комбинации)."),
  session_duration_min: z.number().int().min(10).max(240).optional(),
  constraints: z.string().trim().max(500).optional().describe("Травмы/ограничения."),
  sessions: z.array(sessionDay).min(1).max(7),
  suggested_times: z
    .array(slot)
    .max(7)
    .optional()
    .describe("Дни/время напоминаний под программу; если не задать — дни программы, время 18:00."),
};

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("catalog") }),
  z.object({
    action: z.literal("search"),
    category_id: z.number().int().optional().describe("id категории из catalog."),
    equipment_id: z.number().int().optional().describe("id оборудования из catalog (для «дом без железа» не задавай)."),
    limit: z.number().int().min(1).max(20).default(10),
    offset: z.number().int().min(0).default(0),
  }),
  z.object({
    action: z.literal("save"),
    ...programSaveSchema,
  }),
  z.object({
    action: z.literal("apply_times"),
    mode: z.enum(["replace", "merge", "keep"]).describe("Ответ юзера: replace=Заменить, merge=Смешать, keep=Оставить мои."),
    times: z.array(slot).max(7).optional().describe("Слоты программы (нужны для replace/merge)."),
  }),
]);

export default defineTool({
  description:
    "Тренировочная программа (wger). ПОРЯДОК: (1) catalog — категории/оборудование для " +
    "маппинга «дом/зал/улица»; (2) search — подбор упражнений под группы мышц и оборудование " +
    "(переводи названия и описания на русский; если есть name_ru — используй его); (3) покажи " +
    "план пользователю (дни → упражнения → подходы/повторы), согласуй; (4) save — записать " +
    "программу. При needs_confirmation спроси «Заменить твои напоминания о тренировках?» " +
    "(Заменить/Оставить мои/Смешать) и примени ответ через apply_times.",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);

    // ── catalog ──────────────────────────────────────────────────────────────
    if (input.action === "catalog") {
      try {
        const t = await getTaxonomies("tool");
        return {
          ok: true,
          categories: t.categories,
          equipment: t.equipment,
          muscles: t.muscles,
          hint:
            "Сопоставь пожелания пользователя: «зал» → Barbell/Dumbbell/Bench/…, «дом без " +
            "железа» → не задавай equipment_id (ищи bodyweight по категории), «улица» → " +
            "Pull-up bar / bodyweight / Cardio.",
        };
      } catch (e) {
        return { ok: false, ...wgerErrorPayload(e) };
      }
    }

    // ── search ───────────────────────────────────────────────────────────────
    if (input.action === "search") {
      try {
        const page = await searchExercises(
          {
            categoryId: input.category_id,
            equipmentId: input.equipment_id,
            limit: input.limit,
            offset: input.offset,
          },
          "tool",
        );
        return {
          ok: true,
          count: page.count,
          exercises: page.results.map((e) => ({
            id: e.id,
            name_en: e.nameEn,
            name_ru: e.nameRu,
            description_ru: clampText(e.descriptionRu),
            description_en: clampText(e.descriptionEn),
            category: e.category,
            muscles: e.muscles,
            equipment: e.equipment,
            image_url: e.imageUrl,
          })),
          hint:
            "Для юзера переведи name_en и description_en на русский сам (если name_ru null). " +
            "Выбери по 4–8 упражнений на день программы под цель и оборудование.",
        };
      } catch (e) {
        return { ok: false, ...wgerErrorPayload(e) };
      }
    }

    // ── apply_times ──────────────────────────────────────────────────────────
    if (input.action === "apply_times") {
      if (input.mode !== "keep" && (!input.times || input.times.length === 0)) {
        return {
          ok: false,
          error: "times_required",
          message: "Для replace/merge нужны слоты программы (times).",
        };
      }
      try {
        const r = await applyWorkoutTimesChoice(userId, input.mode, input.times ?? []);
        log("tool", "build-program-apply-times", "info", { user_id: userId, mode: r.mode });
        return { ok: true, mode: r.mode, workout_times: r.workoutTimes };
      } catch (e) {
        return {
          ok: false,
          error: "invalid_slots",
          message: e instanceof Error ? e.message : "Невалидные слоты напоминаний.",
        };
      }
    }

    // ── save ─────────────────────────────────────────────────────────────────
    const saved = await saveProgramFromParams(userId, input);
    if (!saved.ok) return saved;

    const { result } = saved;
    log("tool", "build-program-saved", "info", {
      user_id: userId,
      version: result.version,
      days: result.days,
    });

    if (result.times.state === "applied") {
      return {
        ok: true,
        version: result.version,
        days: result.days,
        exercises_total: result.exercisesTotal,
        workout_times: result.times.workoutTimes,
        workout_times_state: "applied",
      };
    }
    return {
      ok: true,
      version: result.version,
      days: result.days,
      exercises_total: result.exercisesTotal,
      workout_times_state: "needs_confirmation",
      current_times: result.times.currentTimes,
      suggested_times: result.times.suggestedTimes,
      hint:
        "У пользователя уже есть напоминания о тренировках. Покажи предложенные дни/время и " +
        "спроси через ask_question: «Заменить твои текущие напоминания о тренировках?» " +
        "options: replace=Заменить, keep=Оставить мои, merge=Смешать. Затем вызови " +
        "build-program action='apply_times' с ответом.",
    };
  },
});
