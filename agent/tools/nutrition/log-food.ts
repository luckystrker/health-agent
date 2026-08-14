// @ts-check
/**
 * Tool `log-food` — питание: поиск FatSecret → запись в дневник юзера → копия в
 * `food_entries` (§6.2, §8; PHASE-2 §6.3).
 *
 * Четыре действия (дискриминированы по `action`):
 *  - `search`  — поиск продуктов (OAuth 2.0 app-токен; region=RU принудительно);
 *  - `details` — карточка продукта с порциями (для выбора serving);
 *  - `log`     — запись выбранной порции в дневник FatSecret (OAuth 1.0a per-user)
 *               + копия строки в нашу `food_entries` (source='fatsecret');
 *  - `manual`  — быстрая запись без FatSecret (source='manual' или 'barcode_off',
 *               если продукт найден в Open Food Facts через lookup-barcode).
 *
 * Ошибки §16: 429 → «сервис перегружен»; 401 → токен отозван (помечаем
 * revoked_at, предлагаем переподключение); сеть → retry уже в lib (3 попытки).
 */
import { defineTool } from "eve/tools";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db/client";
import { fatsecretTokens, foodEntries } from "../../lib/db/schema";
import {
  createFoodEntry,
  fsErrorPayload,
  FsApiError,
  getFood,
  getUserFsToken,
  mealDefaultLocalTime,
  searchFoods,
  type Meal,
} from "../../lib/fatsecret-api";
import { log } from "../../lib/log";
import { getUserTimezone, requireUser } from "../../lib/tenant";
import { localDay, localTimeToUtc } from "../../lib/time";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const mealSchema = z
  .enum(["breakfast", "lunch", "dinner", "snack"])
  .default("snack")
  .describe("Приём пищи. Если пользователь не уточнял — выбери по контексту времени.");

const daySchema = z
  .string()
  .regex(DAY_RE)
  .optional()
  .describe("Локальный день 'YYYY-MM-DD'. По умолчанию — сегодня (по tz пользователя).");

const timeSchema = z
  .string()
  .regex(TIME_RE)
  .optional()
  .describe("Локальное время приёма 'HH:MM' (если известно). По умолчанию — типичное время приёма.");

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    query: z.string().trim().min(2).max(120).describe("Поисковый запрос (название продукта)."),
    page: z.number().int().min(0).max(10).default(0).describe("Страница результатов (0-based)."),
  }),
  z.object({
    action: z.literal("details"),
    food_id: z.string().min(1).describe("food_id из результатов поиска."),
  }),
  z.object({
    action: z.literal("log"),
    food_id: z.string().min(1),
    serving_id: z.string().min(1).describe("serving_id из details."),
    number_of_units: z.number().positive().max(1000).describe("Количество порций."),
    meal: mealSchema,
    day: daySchema,
    time: timeSchema,
    food_name: z.string().trim().min(1).max(200).describe("Название продукта (для нашей копии записи)."),
    brand_name: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal("manual"),
    description: z.string().trim().min(1).max(200).describe("Что съел (для истории и отчётов)."),
    kcal: z.number().min(0).max(20000).describe("Калорийность записи, ккал."),
    protein_g: z.number().min(0).max(2000).optional(),
    fat_g: z.number().min(0).max(2000).optional(),
    carbs_g: z.number().min(0).max(2000).optional(),
    meal: mealSchema,
    day: daySchema,
    time: timeSchema,
    from_barcode: z
      .boolean()
      .default(false)
      .describe("true — продукт найден в Open Food Facts (lookup-barcode), не в FatSecret."),
  }),
]);

/** День/время приёма → consumed_at (UTC). День по умолчанию — сегодня локально. */
async function resolveConsumedAt(
  userId: string,
  meal: Meal,
  day?: string,
  time?: string,
): Promise<{ tz: string; day: string; consumedAt: Date }> {
  const tz = await getUserTimezone(userId);
  const resolvedDay = day ?? localDay(new Date(), tz);
  const consumedAt = localTimeToUtc(resolvedDay, time ?? mealDefaultLocalTime(meal), tz);
  return { tz, day: resolvedDay, consumedAt };
}

/** 401 на user-level вызове → пометить токен отозванным (нужно переподключение). */
async function revokeToken(userId: string): Promise<void> {
  await db
    .update(fatsecretTokens)
    .set({ revokedAt: new Date() })
    .where(eq(fatsecretTokens.userId, userId));
  log("oauth", "fs-token-revoked-401", "warn", { user_id: userId });
}

export default defineTool({
  description:
    "Запись еды. ПОРЯДОК РАБОТЫ: (1) search — найди продукты, покажи пользователю варианты " +
    "(3–5, с брендом); (2) после выбора — details по food_id, покажи порции (serving_id, " +
    "ккал/БЖУ на порцию) и спроси количество; (3) log — запиши выбранную порцию в дневник " +
    "FatSecret (нужен подключённый FatSecret). Если продукта нет/пользователь называет еду " +
    "с готовыми ккал — используй manual (без FatSecret). Для штрихкода сначала lookup-barcode.",
  inputSchema,
  async execute(input, ctx) {
    const { userId } = await requireUser(ctx);

    // ── search ───────────────────────────────────────────────────────────────
    if (input.action === "search") {
      try {
        const r = await searchFoods(input.query, input.page);
        return {
          ok: true,
          total_results: r.totalResults,
          page: r.page,
          foods: r.foods,
          hint:
            "Покажи варианты пользователю. После выбора вызови log-food action='details' " +
            "с food_id — вернёт порции для записи.",
        };
      } catch (e) {
        return { ok: false, ...fsErrorPayload(e) };
      }
    }

    // ── details ──────────────────────────────────────────────────────────────
    if (input.action === "details") {
      try {
        const food = await getFood(input.food_id);
        return {
          ok: true,
          food_id: food.foodId,
          name: food.name,
          brand: food.brand,
          servings: food.servings,
          hint:
            "Покажи порции и их ккал/БЖУ. Уточни количество порций и приём пищи, затем " +
            "вызови log-food action='log' с food_id + serving_id + number_of_units.",
        };
      } catch (e) {
        return { ok: false, ...fsErrorPayload(e) };
      }
    }

    // ── log (FatSecret-дневник) ──────────────────────────────────────────────
    if (input.action === "log") {
      const token = await getUserFsToken(userId);
      if (!token) {
        return {
          ok: false,
          error: "fs_not_connected",
          message: "FatSecret не подключён. Предложи пользователю подключить (connect-fatsecret) " +
            "или запиши еду через action='manual'.",
        };
      }
      const { day, consumedAt } = await resolveConsumedAt(
        userId,
        input.meal,
        input.day,
        input.time,
      );
      try {
        // Питание порции — из авторитетного food.get (не из ввода модели).
        const food = await getFood(input.food_id);
        const serving = food.servings.find((s) => s.servingId === input.serving_id);
        if (!serving) {
          return {
            ok: false,
            error: "fs_unknown_serving",
            message: "Порция не найдена — вызови action='details' и выбери serving_id из списка.",
          };
        }
        const units = input.number_of_units;
        const kcal = Math.round(serving.kcal * units * 10) / 10;
        const macros = {
          proteinG: Math.round(serving.proteinG * units * 10) / 10,
          fatG: Math.round(serving.fatG * units * 10) / 10,
          carbsG: Math.round(serving.carbsG * units * 10) / 10,
        };

        const entryId = await createFoodEntry(token, {
          foodId: input.food_id,
          servingId: input.serving_id,
          units,
          meal: input.meal,
          day,
        });

        // Копия строки в нашу БД (§6.2: аналитика + независимость от лимитов).
        const description = input.brand_name
          ? `${input.food_name} (${input.brand_name})`
          : input.food_name;
        await db.insert(foodEntries).values({
          userId,
          externalId: entryId,
          consumedAt,
          day: new Date(`${day}T00:00:00.000Z`),
          description,
          foodId: input.food_id,
          servings: units,
          kcal,
          ...macros,
          source: "fatsecret",
        });

        log("tool", "log-food-fatsecret", "info", { user_id: userId, external_id: entryId, kcal });
        return { ok: true, food_entry_id: entryId, day, meal: input.meal, kcal, ...macros, description };
      } catch (e) {
        if (e instanceof FsApiError && e.kind === "unauthorized") {
          await revokeToken(userId);
        }
        return { ok: false, ...fsErrorPayload(e) };
      }
    }

    // ── manual (без FatSecret) ───────────────────────────────────────────────
    const { day, consumedAt } = await resolveConsumedAt(userId, input.meal, input.day, input.time);
    const inserted = await db
      .insert(foodEntries)
      .values({
        userId,
        externalId: null,
        consumedAt,
        day: new Date(`${day}T00:00:00.000Z`),
        description: input.description,
        foodId: null,
        servings: null,
        kcal: input.kcal,
        proteinG: input.protein_g ?? null,
        fatG: input.fat_g ?? null,
        carbsG: input.carbs_g ?? null,
        source: input.from_barcode ? "barcode_off" : "manual",
      })
      .returning({ id: foodEntries.id });

    log("tool", "log-food-manual", "info", {
      user_id: userId,
      source: input.from_barcode ? "barcode_off" : "manual",
      kcal: input.kcal,
    });
    return {
      ok: true,
      id: inserted[0].id,
      day,
      meal: input.meal,
      kcal: input.kcal,
      description: input.description,
    };
  },
});
