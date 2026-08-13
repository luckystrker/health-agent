// @ts-check
import { defineTool } from "eve/tools";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { goals } from "../../lib/db/schema";
import { requireUser } from "../../lib/tenant";

const inputSchema = z
  .object({
    kind: z.enum(["weight_loss", "maintenance", "muscle_gain"]).describe("Тип цели"),
    target_weight_kg: z
      .number()
      .min(30)
      .max(300)
      .optional()
      .describe("Целевой вес в кг (для weight_loss/muscle_gain)"),
    target_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Дедлайн в формате YYYY-MM-DD (альтернатива темпу)"),
    tempo_kg_per_week: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe("Темп изменения веса, кг/неделю (альтернатива дедлайну)"),
    calorie_source: z
      .enum(["hybrid", "device", "manual"])
      .default("hybrid")
      .describe("Источник целевого калоража: hybrid (расчёт ботом) / device / manual"),
    manual_target_kcal: z
      .number()
      .int()
      .min(800)
      .max(6000)
      .optional()
      .describe("Ручной целевой калораж в ккал/день (обязателен, если calorie_source='manual')"),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "maintenance") {
      if (v.target_weight_kg !== undefined) {
        ctx.addIssue({ code: "custom", message: "Для maintenance целевой вес не нужен", path: ["target_weight_kg"] });
      }
      if (v.tempo_kg_per_week !== undefined) {
        ctx.addIssue({ code: "custom", message: "Для maintenance темп не нужен", path: ["tempo_kg_per_week"] });
      }
      if (v.target_date !== undefined) {
        ctx.addIssue({ code: "custom", message: "Для maintenance дедлайн не нужен", path: ["target_date"] });
      }
    } else {
      // weight_loss / muscle_gain
      if (v.target_weight_kg === undefined) {
        ctx.addIssue({ code: "custom", message: "Для weight_loss/muscle_gain нужен target_weight_kg", path: ["target_weight_kg"] });
      }
      const hasTempo = v.tempo_kg_per_week !== undefined;
      const hasDate = v.target_date !== undefined;
      if (hasTempo && hasDate) {
        ctx.addIssue({ code: "custom", message: "Укажи либо tempo_kg_per_week, либо target_date — не оба", path: ["target_date"] });
      }
      if (!hasTempo && !hasDate) {
        ctx.addIssue({ code: "custom", message: "Нужен либо tempo_kg_per_week, либо target_date", path: ["tempo_kg_per_week"] });
      }
      if (hasDate) {
        const [y, m, d] = v.target_date!.split("-").map(Number);
        const targetDate = new Date(Date.UTC(y, m - 1, d));
        const now = new Date();
        const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        if (targetDate.getTime() <= todayUtc.getTime()) {
          ctx.addIssue({ code: "custom", message: "Дедлайн должен быть в будущем", path: ["target_date"] });
        }
      }
    }
    if (v.calorie_source === "manual" && v.manual_target_kcal === undefined) {
      ctx.addIssue({ code: "custom", message: "При calorie_source='manual' нужен manual_target_kcal", path: ["manual_target_kcal"] });
    }
  });

export default defineTool({
  description:
    "Поставить новую цель по весу/телосложению. Деактивирует предыдущую активную цель " +
    "и делает новую активной. Используется на онбординге (шаг 4) и при смене цели. " +
    "Для weight_loss/muscle_gain укажи target_weight_kg и либо tempo_kg_per_week, " +
    "либо target_date.",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);

    let targetDate: Date | null = null;
    if (input.target_date) {
      const [y, m, d] = input.target_date.split("-").map(Number);
      targetDate = new Date(Date.UTC(y, m - 1, d));
    }

    await db.transaction(async (tx) => {
      // Снять активность с прежних целей.
      await tx
        .update(goals)
        .set({ active: false })
        .where(and(eq(goals.userId, userId), eq(goals.active, true)));
      // Вставить новую активную.
      await tx.insert(goals).values({
        userId,
        kind: input.kind,
        targetWeightKg: input.target_weight_kg ?? null,
        targetDate,
        tempoKgPerWeek: input.tempo_kg_per_week ?? null,
        calorieSource: input.calorie_source,
        manualTargetKcal: input.manual_target_kcal ?? null,
        active: true,
      });
    });

    return {
      ok: true,
      goal: {
        kind: input.kind,
        target_weight_kg: input.target_weight_kg ?? null,
        target_date: input.target_date ?? null,
        tempo_kg_per_week: input.tempo_kg_per_week ?? null,
        calorie_source: input.calorie_source,
        manual_target_kcal: input.manual_target_kcal ?? null,
      },
    };
  },
});
