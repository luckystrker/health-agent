// @ts-check
import { defineTool } from "eve/tools";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { profiles, weightLog } from "../../lib/db/schema";
import { requireUser } from "../../lib/tenant";

const inputSchema = z.object({
  sex: z.enum(["male", "female"]).describe("Биологический пол"),
  birth_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Дата рождения в формате YYYY-MM-DD"),
  height_cm: z.number().int().min(100).max(250).describe("Рост в см"),
  current_weight_kg: z
    .number()
    .min(30)
    .max(300)
    .optional()
    .describe("Текущий вес в кг (если известно)"),
  self_reported_activity_level: z
    .enum(["sedentary", "light", "moderate", "active"])
    .describe("Уровень активности: sedentary/light/moderate/active"),
});

export default defineTool({
  description:
    "Записать/обновить профиль пользователя: пол, дату рождения, рост, уровень " +
    "активности и (опционально) текущий вес. Используется на онбординге (шаги 2 и 5) " +
    "и при изменении профиля. При указании веса он также попадает в историю взвешиваний.",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);

    const [y, m, d] = input.birth_date.split("-").map(Number);
    const birthDate = new Date(Date.UTC(y, m - 1, d));

    const setObj: Partial<typeof profiles.$inferInsert> = {
      sex: input.sex,
      birthDate,
      heightCm: input.height_cm,
      selfReportedActivityLevel: input.self_reported_activity_level,
      updatedAt: new Date(),
    };
    if (input.current_weight_kg !== undefined) {
      setObj.currentWeightKg = input.current_weight_kg;
    }

    await db
      .insert(profiles)
      .values({
        userId,
        sex: input.sex,
        birthDate,
        heightCm: input.height_cm,
        currentWeightKg: input.current_weight_kg ?? null,
        selfReportedActivityLevel: input.self_reported_activity_level,
      })
      .onConflictDoUpdate({ target: profiles.userId, set: setObj });

    // При указании веса — добавить в историю взвешиваний (current_weight_kg = "последнее",
    // weight_log = "история"; см. STATUS.md). onConflictDoNothing — защита от дубля
    // по (user_id, measured_at).
    if (input.current_weight_kg !== undefined) {
      await db
        .insert(weightLog)
        .values({
          userId,
          weightKg: input.current_weight_kg,
          measuredAt: new Date(),
          source: "manual",
        })
        .onConflictDoNothing();
    }

    return {
      ok: true,
      profile: {
        sex: input.sex,
        birth_date: input.birth_date,
        height_cm: input.height_cm,
        current_weight_kg: input.current_weight_kg ?? null,
        self_reported_activity_level: input.self_reported_activity_level,
      },
    };
  },
});
