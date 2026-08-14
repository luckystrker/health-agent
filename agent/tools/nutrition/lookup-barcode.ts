// @ts-check
/**
 * Tool `lookup-barcode` — продукт по штрихкоду (§6.2; PHASE-2 §6.4).
 *
 * Порядок: FatSecret `food.find_id_for_barcode` (app-токен) → если пусто
 * (error 211 или Premier-ограничение тира) → фолбэк Open Food Facts
 * (русская база ~35k, REST v2). Дальше модель ведёт юзера:
 *  - FatSecret-хит → log-food action='details'/'log' (обычный путь);
 *  - OFF-хит → уточнить граммовку → log-food action='manual' c from_barcode=true
 *    (пересчёт per-100g на порцию делает модель до вызова).
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  findFoodByBarcode,
  fsErrorPayload,
  FsApiError,
  getFood,
} from "../../lib/fatsecret-api";
import { log } from "../../lib/log";
import { requireUser } from "../../lib/tenant";

const OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product";

/** Ответ Open Food Facts (поля, которые читаем). */
export interface OffProduct {
  name: string;
  brand: string | null;
  kcal100: number | null;
  protein100: number | null;
  fat100: number | null;
  carbs100: number | null;
}

/** Парсинг OFF-ответа (чистая функция — unit-тестируется). */
export function parseOffProduct(json: unknown): OffProduct | null {
  const root = json as {
    status?: number;
    product?: {
      product_name?: string;
      product_name_ru?: string;
      product_name_en?: string;
      generic_name?: string;
      brands?: string;
      nutriments?: Record<string, unknown>;
    };
  } | null;
  if (!root || root.status !== 1 || !root.product) return null;
  const p = root.product;
  const name = (p.product_name_ru || p.product_name || p.product_name_en || p.generic_name || "")
    .trim();
  if (!name) return null;
  const n = p.nutriments ?? {};
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    name,
    brand: p.brands ? p.brands.split(",")[0].trim() || null : null,
    kcal100: num(n["energy-kcal_100g"]),
    protein100: num(n.proteins_100g),
    fat100: num(n.fat_100g),
    carbs100: num(n.carbohydrates_100g),
  };
}

const inputSchema = z.object({
  barcode: z
    .string()
    .trim()
    .regex(/^\d{8,14}$/, "Штрихкод — 8–14 цифр")
    .describe("Штрихкод (EAN-13/UPC), только цифры."),
});

export default defineTool({
  description:
    "Найти продукт по штрихкоду: сначала FatSecret, при пустом результате — Open Food " +
    "Facts (ккал/БЖУ на 100 г). Если найден в FatSecret — дальше log-food " +
    "action='details' по food_id. Если найден в OFF — уточни у пользователя вес порции, " +
    "пересчитай ккал/БЖУ на порцию и запиши через log-food action='manual' с " +
    "from_barcode=true. Если не найден нигде — предложи ввести еду вручную (manual).",
  inputSchema,
  async execute({ barcode }, ctx) {
    const { userId } = await requireUser(ctx);

    // 1) FatSecret (может не сработать на free-тарифе — метод Premier; это штатно).
    try {
      const brief = await findFoodByBarcode(barcode);
      if (brief) {
        const food = await getFood(brief.foodId);
        return {
          ok: true,
          source: "fatsecret",
          food_id: food.foodId,
          name: food.name,
          brand: food.brand,
          servings: food.servings,
          hint: "Продукт найден в FatSecret — продолжай через log-food action='details'/'log'.",
        };
      }
    } catch (e) {
      // Сетевые/лимитные ошибки FatSecret не должны блокировать OFF-фолбэк.
      const payload = fsErrorPayload(e);
      if (e instanceof FsApiError && (e.kind === "network" || e.kind === "rate_limited")) {
        log("tool", "lookup-barcode-fs-degraded", "warn", { user_id: userId, error: payload.error });
      }
    }

    // 2) Open Food Facts.
    try {
      const res = await fetch(`${OFF_PRODUCT_URL}/${encodeURIComponent(barcode)}.json`, {
        headers: { "User-Agent": "health-agent/0.2 (personal Telegram bot)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`OFF HTTP ${res.status}`);
      }
      const product = parseOffProduct(await res.json());
      if (!product) {
        return {
          ok: true,
          found: false,
          hint: "Штрихкод не найден ни в FatSecret, ни в Open Food Facts — предложи manual-запись.",
        };
      }
      log("tool", "lookup-barcode-off", "info", { user_id: userId });
      return {
        ok: true,
        found: true,
        source: "openfoodfacts",
        name: product.name,
        brand: product.brand,
        per_100g: {
          kcal: product.kcal100,
          protein_g: product.protein100,
          fat_g: product.fat100,
          carbs_g: product.carbs100,
        },
        hint:
          "Значения на 100 г. Уточни вес порции в граммах, пересчитай и запиши через " +
          "log-food action='manual' с from_barcode=true.",
      };
    } catch (e) {
      log("tool", "lookup-barcode-off-error", "warn", {
        user_id: userId,
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        error: "off_unavailable",
        message: "Сервис штрихкодов недоступен — попробуй ещё раз или запиши вручную (manual).",
      };
    }
  },
});
