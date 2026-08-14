// @ts-check
/**
 * Юнит-тесты fatsecret-api.ts (нормализация ответов FatSecret, epoch-days,
 * штрихкод-парсер OFF) + mapping sync-fatsecret-diary (§18.1–18.2; PHASE-2 §8).
 *
 * Json-специфика FatSecret: одиночный элемент — объект, список — массив.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  asArray,
  createFoodEntry,
  dateToEpochDay,
  epochDayToDate,
  fsErrorPayload,
  FsApiError,
  FS_REST_URL,
  mealDefaultLocalTime,
  mealForCreate,
  normalizeFoodEntry,
  normalizeMeal,
  normalizeServings,
  parseDayEntries,
  parseEntryId,
  parseMonthDays,
  searchFoods,
} from "../agent/lib/fatsecret-api";
import { FsOauthError, resetAppTokenCache, setAppTokenCacheForTests } from "../agent/lib/fatsecret-oauth";
import { entryToRowValues } from "../agent/schedules/sync-fatsecret-diary";
import { parseOffProduct } from "../agent/tools/nutrition/lookup-barcode";
import { localTimeToUtc } from "../agent/lib/time";

const MSK = "Europe/Moscow";

describe("epoch-days (формат дат FatSecret)", () => {
  it("1970-01-01 → 0; 2024-01-01 → 19723 (54 года + 13 високосных)", () => {
    expect(dateToEpochDay("1970-01-01")).toBe(0);
    expect(dateToEpochDay("2024-01-01")).toBe(19723);
  });

  it("round-trip", () => {
    for (const day of ["2026-08-14", "2000-02-29", "1999-12-31"]) {
      expect(epochDayToDate(dateToEpochDay(day))).toBe(day);
    }
  });
});

describe("normalizeMeal / mealForCreate / mealDefaultLocalTime", () => {
  it("'other' и 'Snack' → snack; регистр не важен", () => {
    expect(normalizeMeal("other")).toBe("snack");
    expect(normalizeMeal("Snack")).toBe("snack");
    expect(normalizeMeal("Breakfast")).toBe("breakfast");
    expect(normalizeMeal("LUNCH")).toBe("lunch");
    expect(normalizeMeal("Dinner")).toBe("dinner");
  });

  it("meal для create — с заглавной; дефолтные времена приёма", () => {
    expect(mealForCreate("breakfast")).toBe("Breakfast");
    expect(mealDefaultLocalTime("breakfast")).toBe("09:00");
    expect(mealDefaultLocalTime("lunch")).toBe("13:00");
    expect(mealDefaultLocalTime("dinner")).toBe("19:00");
    expect(mealDefaultLocalTime("snack")).toBe("16:00");
  });
});

describe("normalizeServings (object | array)", () => {
  it("одна порция приходит объектом → массив из 1", () => {
    const food = {
      servings: {
        serving: {
          serving_id: "8130",
          serving_description: "100 g",
          number_of_units: "100.000",
          calories: "195.33",
          protein: "4.31",
          fat: "1.35",
          carbohydrate: "42.41",
        },
      },
    };
    const s = normalizeServings(food);
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({
      servingId: "8130",
      description: "100 g",
      numberUnits: 100,
      kcal: 195.33,
      proteinG: 4.31,
      fatG: 1.35,
      carbsG: 42.41,
    });
  });

  it("несколько порций — массив", () => {
    const food = {
      servings: {
        serving: [
          { serving_id: "1", serving_description: "1 slice", calories: "80" },
          { serving_id: "2", serving_description: "100 g", calories: "264" },
        ],
      },
    };
    expect(normalizeServings(food).map((s) => s.servingId)).toEqual(["1", "2"]);
  });

  it("servings отсутствует → []", () => {
    expect(normalizeServings({})).toEqual([]);
    expect(normalizeServings(undefined)).toEqual([]);
  });
});

describe("normalizeFoodEntry / parseDayEntries", () => {
  it("строки → числа, date_int → дата, meal other → snack", () => {
    const e = normalizeFoodEntry({
      food_entry_id: "38398263",
      date_int: "19723",
      meal: "other",
      food_id: "4384",
      food_entry_name: "Plain French Toast",
      number_of_units: "1.000",
      calories: "74.33",
      protein: "2.15",
      fat: "3.04",
      carbohydrate: "9.50",
    });
    expect(e).toEqual({
      foodEntryId: "38398263",
      day: "2024-01-01",
      meal: "snack",
      foodId: "4384",
      name: "Plain French Toast",
      units: 1,
      kcal: 74.33,
      proteinG: 2.15,
      fatG: 3.04,
      carbsG: 9.5,
    });
  });

  it("fallback на строковую дату; невалидные записи отсеиваются", () => {
    expect(normalizeFoodEntry({ food_entry_id: "1", date: "2026-08-13", meal: "Breakfast" })?.day).toBe(
      "2026-08-13",
    );
    expect(normalizeFoodEntry({ food_entry_id: "1", date_int: "x" })).toBeNull();
    expect(normalizeFoodEntry({ meal: "x" })).toBeNull();
  });

  it("parseDayEntries: одиночный объект и массив", () => {
    expect(parseDayEntries({ food_entries: { food_entry: { food_entry_id: "1", date_int: "1", meal: "" } } })).toHaveLength(1);
    expect(
      parseDayEntries({
        food_entries: {
          food_entry: [
            { food_entry_id: "1", date_int: "1", meal: "" },
            { food_entry_id: "2", date_int: "1", meal: "" },
          ],
        },
      }),
    ).toHaveLength(2);
    expect(parseDayEntries({})).toEqual([]);
  });
});

describe("parseMonthDays", () => {
  it("дневные итоги месяца; одиночный day — объект", () => {
    const days = parseMonthDays({
      month: {
        from_date_int: "20665",
        to_date_int: "20695",
        day: { date_int: "20672", calories: "1821.60", protein: "100.10", fat: "60.20", carbohydrate: "200.30" },
      },
    });
    expect(days).toEqual([
      { day: "2026-08-07", kcal: 1821.6, proteinG: 100.1, fatG: 60.2, carbsG: 200.3 },
    ]);
  });
});

describe("parseEntryId (food_entries.create)", () => {
  it("варианты ответа: строка / число / {value}", () => {
    expect(parseEntryId({ food_entry_id: "123" })).toBe("123");
    expect(parseEntryId({ food_entry_id: 123 })).toBe("123");
    expect(parseEntryId({ food_entry_id: { value: "123" } })).toBe("123");
    expect(parseEntryId({})).toBeNull();
  });
});

describe("entryToRowValues (sync-fatsecret-diary)", () => {
  it("FsFoodEntry → food_entries-строка: consumed_at = каноническое время приёма", () => {
    const row = entryToRowValues(
      "u1",
      {
        foodEntryId: "42",
        day: "2026-08-14",
        meal: "dinner",
        foodId: "7",
        name: "Овсянка",
        units: 2,
        kcal: 300,
        proteinG: 10,
        fatG: 5,
        carbsG: 50,
      },
      MSK,
    );
    // 19:00 MSK = 16:00 UTC
    expect(row.consumedAt.toISOString()).toBe("2026-08-14T16:00:00.000Z");
    expect(row.externalId).toBe("42");
    expect(row.day.toISOString()).toBe("2026-08-14T00:00:00.000Z");
    expect(row.source).toBe("fatsecret");
    expect(row.servings).toBe(2);
    expect(row.userId).toBe("u1");
  });
});

describe("parseOffProduct (Open Food Facts)", () => {
  it("статус 1 + нутрименты на 100 г; предпочитает русское имя", () => {
    const p = parseOffProduct({
      status: 1,
      product: {
        product_name: "Milk",
        product_name_ru: "Молоко",
        brands: "Domik v Derevne, Another",
        nutriments: {
          "energy-kcal_100g": 60.5,
          proteins_100g: 3.2,
          fat_100g: 3.5,
          carbohydrates_100g: 4.7,
        },
      },
    });
    expect(p).toEqual({
      name: "Молоко",
      brand: "Domik v Derevne",
      kcal100: 60.5,
      protein100: 3.2,
      fat100: 3.5,
      carbs100: 4.7,
    });
  });

  it("status 0 → null; без имени → null", () => {
    expect(parseOffProduct({ status: 0 })).toBeNull();
    expect(
      parseOffProduct({ status: 1, product: { nutriments: { proteins_100g: 1 } } }),
    ).toBeNull();
  });
});

describe("asArray", () => {
  it("null/undefined → []; одиночка оборачивается", () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray(5)).toEqual([5]);
    expect(asArray([1, 2])).toEqual([1, 2]);
  });
});

describe("localTimeToUtc (время приёма пищи)", () => {
  it("13:00 MSK → 10:00 UTC", () => {
    expect(localTimeToUtc("2026-08-14", "13:00", MSK).toISOString()).toBe("2026-08-14T10:00:00.000Z");
  });

  it("DST-корректная полночь (America/New_York, лето −4)", () => {
    expect(localTimeToUtc("2026-07-01", "09:00", "America/New_York").toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Контракт HTTP-запросов (fetch-mock, без сети): DoD PHASE-2 §8 —
// «region=RU, language=ru, format=json присутствует в каждом поисковом запросе»
// и подпись OAuth 1.0a уходит заголовком с per-user токеном.
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(responseJson: unknown, status = 200): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(responseJson), { status });
    }),
  );
  return calls;
}

describe("fsRest-контракт (fetch-mock)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAppTokenCache();
  });

  it("searchFoods: Bearer app-токен + region=RU, language=ru, format=json в теле", async () => {
    setAppTokenCacheForTests("test-app-token", Date.now() + 2 * 3_600_000);
    const calls = stubFetch({ foods: { total_results: "0" } });

    const r = await searchFoods("овсянка");
    expect(r.totalResults).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(FS_REST_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal); // P1: таймаут на каждую попытку
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-app-token",
    );
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("method")).toBe("foods.search");
    expect(body.get("region")).toBe("RU"); // §6.2: гарантировано кодом, не LLM
    expect(body.get("language")).toBe("ru");
    expect(body.get("format")).toBe("json");
    expect(body.get("search_expression")).toBe("овсянка");
  });

  it("createFoodEntry: OAuth 1.0a Authorization-заголовок с user-токеном; date → epoch-days", async () => {
    const calls = stubFetch({ food_entry_id: "42" });

    const entryId = await createFoodEntry(
      { accessToken: "user-tok", accessTokenSecret: "user-sec" },
      { foodId: "4384", servingId: "8130", units: 1.5, meal: "breakfast", day: "2026-08-14" },
    );
    expect(entryId).toBe("42");
    expect(calls).toHaveLength(1);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization.startsWith("OAuth ")).toBe(true);
    expect(headers.Authorization).toContain('oauth_consumer_key="test-key"'); // env из vitest-конфига
    expect(headers.Authorization).toContain('oauth_token="user-tok"');
    expect(headers.Authorization).toMatch(/oauth_signature="[^"]+"/);

    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("method")).toBe("food_entries.create");
    expect(body.get("food_id")).toBe("4384");
    expect(body.get("serving_id")).toBe("8130");
    expect(body.get("number_of_units")).toBe("1.5");
    expect(body.get("meal")).toBe("Breakfast");
    expect(body.get("date")).toBe(String(dateToEpochDay("2026-08-14"))); // 20679
    expect(body.get("format")).toBe("json");
  });
});

describe("fsErrorPayload: коды FsOauthError → user-friendly (review P1)", () => {
  it("fs_auth_failed ≠ fs_not_configured; сеть → fs_unavailable", () => {
    expect(fsErrorPayload(new FsOauthError("x", "fs_auth_failed"))).toMatchObject({
      error: "fs_auth_failed",
    });
    expect(
      fsErrorPayload(new FsOauthError("app token failed: HTTP 500", "fs_unavailable")).error,
    ).toBe("fs_unavailable");

    // Раньше 401 getAppToken сообщался как «не настроено» — теперь раздельно:
    const auth = fsErrorPayload(new FsOauthError("invalid_client", "fs_auth_failed"));
    expect(auth.message).toContain("ключи");
    expect(auth.error).not.toBe("fs_not_configured");
    const cfg = fsErrorPayload(new FsOauthError("no env", "fs_not_configured"));
    expect(cfg.error).toBe("fs_not_configured");
  });

  it("FsApiError kind → friendly-коды (429/401/сеть)", () => {
    expect(fsErrorPayload(new FsApiError("rl", "rate_limited")).error).toBe("fs_rate_limited");
    expect(fsErrorPayload(new FsApiError("401", "unauthorized")).error).toBe("fs_unauthorized");
    expect(fsErrorPayload(new FsApiError("net", "network")).error).toBe("fs_unavailable");
  });

  it("неизвестное → fs_unexpected", () => {
    expect(fsErrorPayload(new Error("boom")).error).toBe("fs_unexpected");
  });
});
