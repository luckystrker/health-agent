// @ts-check
/**
 * FatSecret REST-клиент (§6.2, §8, §16; PHASE-2 §6.3).
 *
 * Два вида вызовов к https://platform.fatsecret.com/rest/server.api:
 *  - **app-level** (OAuth 2.0 client-credentials, Bearer) — публичный поиск:
 *    `foods.search`, `food.get`, `food.find_id_for_barcode`;
 *  - **user-level** (OAuth 1.0a подпись per-user токеном) — дневник:
 *    `food_entries.create`, `food_entries.get`, `food_entries.get_month`.
 *
 * `region=RU`, `language=ru`, `format=json` добавляются ЦЕНТРАЛЬНО здесь, а не
 * в LLM-инструкциях и не в tool-вводе (§6.2 «гарантирована на уровне кода»).
 * ⚠️ Замечание о тире: в доках v1 параметры region/language помечены Premier-
 * exclusive — на free-тарифе FatSecret может их игнорировать (деградация до US-
 * базы, НЕ ошибка). Риск зафиксирован в STATUS.md; константы — в одном месте.
 *
 * Обработка ошибок (§16): 429 → friendly «перегружен» (без ретрая); 401 →
 * «переподключить FatSecret»; сеть/5xx → retry с экспоненциальным backoff
 * (3 попытки); JSON `{error:{code,message}}` → код FatSecret наружу.
 *
 * Json-специфика FatSecret: элементы-одиночки приходят объектом, а не массивом
 * («array only when more than one object») — нормализуем везде.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "./db/client";
import { fatsecretTokens } from "./db/schema";
import {
  FS_FETCH_TIMEOUT_MS,
  getAppToken,
  requireConsumer,
  signOauth1,
  FsOauthError,
} from "./fatsecret-oauth";
import { log, type Component } from "./log";

export const FS_REST_URL = "https://platform.fatsecret.com/rest/server.api";
export const FS_REGION = "RU";
export const FS_LANGUAGE = "ru";

/** Локаль, принудительно добавляемая в каждый поисковый запрос (§6.2). */
const LOCALE_PARAMS: Record<string, string> = {
  region: FS_REGION,
  language: FS_LANGUAGE,
  format: "json",
};

// ─────────────────────────────────────────────────────────────────────────────
// Ошибки (§16)
// ─────────────────────────────────────────────────────────────────────────────

export type FsErrorKind =
  | "rate_limited" // HTTP 429: лимит 5000/day — friendly «попробуй позже»
  | "unauthorized" // HTTP 401: токен отозван — нужен перезапуск OAuth flow
  | "network" // сеть/5xx после ретраев — FatSecret недоступен
  | "not_configured" // нет FATSECRET_* env
  | "not_connected" // у юзера нет подключённого FatSecret (user-level вызов)
  | "api"; // ошибка FatSecret с кодом (error.code)

export class FsApiError extends Error {
  readonly kind: FsErrorKind;
  readonly fsCode?: number;
  constructor(message: string, kind: FsErrorKind, fsCode?: number) {
    super(message);
    this.name = "FsApiError";
    this.kind = kind;
    this.fsCode = fsCode;
  }
}

/** Маппинг FsApiError/FsOauthError → user-friendly код для результата tool'а. */
export function fsErrorPayload(e: unknown): { error: string; message: string } {
  if (e instanceof FsApiError) {
    switch (e.kind) {
      case "rate_limited":
        return { error: "fs_rate_limited", message: "Сервис питания перегружен — попробуй через минуту." };
      case "unauthorized":
        return {
          error: "fs_unauthorized",
          message: "FatSecret-подключение сброшено — нужно переподключить (connect-fatsecret).",
        };
      case "network":
        return { error: "fs_unavailable", message: "FatSecret недоступен — попробуй ещё раз чуть позже." };
      case "not_configured":
        return { error: "fs_not_configured", message: "Сервер не настроен: отсутствуют FATSECRET_CLIENT_ID/SECRET." };
      case "not_connected":
        return { error: "fs_not_connected", message: "FatSecret не подключён — сначала вызови connect-fatsecret." };
    }
    return { error: "fs_api_error", message: e.message };
  }
  if (e instanceof FsOauthError) {
    switch (e.code) {
      case "fs_not_configured":
        return { error: "fs_not_configured", message: "Сервер не настроен: отсутствуют FATSECRET_CLIENT_ID/SECRET." };
      case "fs_auth_failed":
        // Ключи приложения отвергнуты сервером — это про конфиг VPS, не про юзера.
        return { error: "fs_auth_failed", message: "FatSecret отклонил ключи приложения — проверь FATSECRET_CLIENT_ID/SECRET на сервере." };
      case "fs_unavailable":
        return { error: "fs_unavailable", message: "FatSecret недоступен — попробуй ещё раз чуть позже." };
      case "fs_invalid_pin":
        return { error: "fs_invalid_pin", message: "PIN не принят — проверь код и попробуй снова (или начни подключение заново)." };
      default:
        return { error: e.code, message: e.message };
    }
  }
  return { error: "fs_unexpected", message: "Неожиданная ошибка FatSecret-вызова." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Дата-формат FatSecret: epoch-days (int, дней с 1970-01-01 UTC)
// ─────────────────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" → int дней с 1970-01-01 (формат date-параметров дневника). */
export function dateToEpochDay(day: string): number {
  return Math.floor(new Date(`${day}T00:00:00.000Z`).getTime() / 86_400_000);
}

/** Epoch-days → "YYYY-MM-DD" (локальный день не теряется: UTC-полночь). */
export function epochDayToDate(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

/** Терпимый к мусору вариант: NaN/нечисловой date_int → null (не бросает). */
function epochDayToDateSafe(raw: unknown): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return epochDayToDate(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Низкоуровневый вызов с retry (§16: сеть/5xx → backoff; 429/401 → сразу ошибка)
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [400, 1200, 3600];

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  component: Component,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    try {
      // Таймаут на каждую попытку (review P1): signal покрывает и чтение тела.
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FS_FETCH_TIMEOUT_MS) });
      // 5xx — единственный ретраимый статус (429/401 не ретраим — см. §16).
      if (res.status >= 500) {
        lastError = new FsApiError(`HTTP ${res.status}`, "network");
        log(component, "fs-5xx-retry", "warn", { status: res.status, attempt });
        continue;
      }
      return res;
    } catch (e) {
      // Сетевой сбой/таймаут fetch (ECONNRESET/DNS/TimeoutError) — ретраим.
      lastError = e;
      log(component, "fs-network-retry", "warn", { attempt, error: e instanceof Error ? e.message : String(e) });
    }
  }
  throw lastError instanceof FsApiError
    ? lastError
    : new FsApiError("network failure", "network");
}

/** Разобрать ответ FatSecret: `{error:{code,message}}` → FsApiError('api'). */
function parseFsJson(text: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new FsApiError(`non-JSON response: ${text.slice(0, 120)}`, "api");
  }
  const obj = json as Record<string, unknown>;
  const err = obj?.error as Record<string, unknown> | undefined;
  if (err && typeof err === "object") {
    const code = Number(err.code ?? 0);
    // OAuth-коды FatSecret 2–9 (5 invalid signature / 6 invalid token) на
    // user-level вызове приравниваем к unauthorized → юзеру предложат reconnect.
    if (code >= 2 && code <= 9) {
      throw new FsApiError(String(err.message ?? "oauth error"), "unauthorized", code);
    }
    if (code === 211) {
      // 211 = «No food item detected» (штрихкод не найден) — не ошибка для юзера.
      throw new FsApiError(String(err.message ?? "not found"), "api", 211);
    }
    throw new FsApiError(String(err.message ?? "api error"), "api", code);
  }
  return obj;
}

/** App-level вызов (OAuth 2.0 Bearer). `method` — имя FatSecret-метода. */
async function fsRestApp(
  method: string,
  params: Readonly<Record<string, string | number>> = {},
  component: Component = "tool",
): Promise<Record<string, unknown>> {
  const token = await getAppToken();
  const body = new URLSearchParams({ method, ...LOCALE_PARAMS });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));

  const res = await fetchWithRetry(
    FS_REST_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    component,
  );
  if (res.status === 429) throw new FsApiError("rate limited", "rate_limited");
  if (res.status === 401) throw new FsApiError("app token rejected", "unauthorized");
  if (!res.ok) throw new FsApiError(`HTTP ${res.status}`, "api");
  return parseFsJson(await res.text());
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-user токен из БД
// ─────────────────────────────────────────────────────────────────────────────

/** Активный (не отозванный) per-user токен или null (§5.7). */
export async function getUserFsToken(userId: string): Promise<{
  accessToken: string;
  accessTokenSecret: string;
} | null> {
  const row = await db
    .select({ accessToken: fatsecretTokens.accessToken, accessTokenSecret: fatsecretTokens.accessTokenSecret })
    .from(fatsecretTokens)
    .where(and(eq(fatsecretTokens.userId, userId), isNull(fatsecretTokens.revokedAt)))
    .limit(1);
  return row[0] ?? null;
}

/** User-level вызов (OAuth 1.0a подпись per-user токеном). */
async function fsRestUser(
  token: { accessToken: string; accessTokenSecret: string },
  method: string,
  params: Readonly<Record<string, string | number>> = {},
  component: Component = "tool",
): Promise<Record<string, unknown>> {
  const creds = requireConsumer();
  const strParams: Record<string, string> = { method, format: "json" };
  for (const [k, v] of Object.entries(params)) strParams[k] = String(v);

  const { authorization } = signOauth1("POST", FS_REST_URL, {
    consumerKey: creds.consumerKey,
    consumerSecret: creds.consumerSecret,
    token: token.accessToken,
    tokenSecret: token.accessTokenSecret,
  }, strParams);

  const res = await fetchWithRetry(
    FS_REST_URL,
    {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(strParams).toString(),
    },
    component,
  );
  if (res.status === 429) throw new FsApiError("rate limited", "rate_limited");
  if (res.status === 401) throw new FsApiError("token rejected", "unauthorized");
  if (!res.ok) throw new FsApiError(`HTTP ${res.status}`, "api");
  return parseFsJson(await res.text());
}

// ─────────────────────────────────────────────────────────────────────────────
// Json-нормализация (чистые функции — unit-тестируемые)
// ─────────────────────────────────────────────────────────────────────────────

/** Элемент-одиночка FatSecret приходит объектом, список — массивом. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export interface FsServing {
  servingId: string;
  description: string; // напр. "100 g" / "1 slice"
  numberUnits: number; // сколько единиц в порции (Generic); у Brand всегда 1
  kcal: number; // на порцию
  proteinG: number;
  fatG: number;
  carbsG: number;
}

/** servings.serving из food.get → плоский массив порций. */
export function normalizeServings(foodJson: unknown): FsServing[] {
  const food = foodJson as { servings?: { serving?: unknown } } | undefined;
  return asArray(food?.servings?.serving as Record<string, unknown> | Record<string, unknown>[]).map((s) => ({
    servingId: String(s.serving_id ?? ""),
    description: String(s.serving_description ?? ""),
    numberUnits: Number(s.number_of_units ?? 1) || 1,
    kcal: Number(s.calories ?? 0) || 0,
    proteinG: Number(s.protein ?? 0) || 0,
    fatG: Number(s.fat ?? 0) || 0,
    carbsG: Number(s.carbohydrate ?? 0) || 0,
  }));
}

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";

/** FatSecret возвращает «other» для перекуса; регистр может гулять. */
export function normalizeMeal(raw: string): Meal {
  const m = raw.toLowerCase();
  if (m === "breakfast") return "breakfast";
  if (m === "lunch") return "lunch";
  if (m === "dinner") return "dinner";
  return "snack"; // "snack" | "other" | прочее
}

/** Значение meal для food_entries.create (формат, указанный в доке). */
export function mealForCreate(meal: Meal): string {
  return meal.charAt(0).toUpperCase() + meal.slice(1);
}

/** Каноническое локальное время приёма пищи, когда точное неизвестно (sync). */
export function mealDefaultLocalTime(meal: Meal): string {
  switch (meal) {
    case "breakfast":
      return "09:00";
    case "lunch":
      return "13:00";
    case "dinner":
      return "19:00";
    default:
      return "16:00"; // snack/other
  }
}

export interface FsFoodEntry {
  foodEntryId: string; // = external_id в food_entries (§5.4)
  day: string; // "YYYY-MM-DD"
  meal: Meal;
  foodId: string | null;
  name: string;
  units: number;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
}

/**
 * food_entry из food_entries.get → нормализованная запись (числа, snack, дата).
 * Дата: `date_int` (epoch-days); на случай `date` "yyyy-mm-dd" — оба варианта.
 */
export function normalizeFoodEntry(entry: unknown): FsFoodEntry | null {
  const e = entry as Record<string, unknown> | undefined;
  if (!e || e.food_entry_id == null) return null;
  // Дата: `date_int` (epoch-days); на случай `date` "yyyy-mm-dd" — оба варианта.
  let day: string | null;
  if (e.date_int != null) {
    day = epochDayToDateSafe(e.date_int);
  } else {
    day = String(e.date ?? "").slice(0, 10);
  }
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return {
    foodEntryId: String(e.food_entry_id),
    day,
    meal: normalizeMeal(String(e.meal ?? "other")),
    foodId: e.food_id != null ? String(e.food_id) : null,
    name: String(e.food_entry_name ?? e.food_entry_description ?? "Food"),
    units: Number(e.number_of_units ?? 1) || 1,
    kcal: Number(e.calories ?? 0) || 0,
    proteinG: Number(e.protein ?? 0) || 0,
    fatG: Number(e.fat ?? 0) || 0,
    carbsG: Number(e.carbohydrate ?? 0) || 0,
  };
}

/** food_entries.get → список записей дня. */
export function parseDayEntries(json: unknown): FsFoodEntry[] {
  const root = json as { food_entries?: { food_entry?: unknown } } | undefined;
  return asArray(root?.food_entries?.food_entry as unknown)
    .map(normalizeFoodEntry)
    .filter((x): x is FsFoodEntry => x !== null);
}

export interface FsMonthDay {
  day: string; // "YYYY-MM-DD"
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
}

/** food_entries.get_month → дневные итоги месяца (дни без записей отсутствуют). */
export function parseMonthDays(json: unknown): FsMonthDay[] {
  const root = json as { month?: { day?: unknown } } | undefined;
  return asArray(root?.month?.day as Record<string, unknown> | Record<string, unknown>[])
    .map((d) => ({
      day: epochDayToDateSafe(d.date_int),
      kcal: Number(d.calories ?? 0) || 0,
      proteinG: Number(d.protein ?? 0) || 0,
      fatG: Number(d.fat ?? 0) || 0,
      carbsG: Number(d.carbohydrate ?? 0) || 0,
    }))
    .filter((d): d is FsMonthDay & { day: string } => d.day !== null && /^\d{4}-\d{2}-\d{2}$/.test(d.day));
}

/**
 * food_entries.create возвращает id по-разному (`"123"` / `{value:"123"}`).
 */
export function parseEntryId(json: unknown): string | null {
  const v = (json as { food_entry_id?: unknown } | undefined)?.food_entry_id;
  if (v == null) return null;
  if (typeof v === "object") {
    const val = (v as { value?: unknown }).value;
    return val != null ? String(val) : null;
  }
  return String(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Публичный API (вызывается tools/schedule)
// ─────────────────────────────────────────────────────────────────────────────

export interface FsFoodBrief {
  foodId: string;
  name: string;
  brand: string | null;
  type: string; // "Generic" | "Brand"
}

/** Поиск продуктов (app-level, region=RU принудительно). */
export async function searchFoods(
  query: string,
  page = 0,
  maxResults = 10,
): Promise<{ foods: FsFoodBrief[]; totalResults: number; page: number }> {
  const json = await fsRestApp("foods.search", {
    search_expression: query,
    page_number: page,
    max_results: Math.min(Math.max(maxResults, 1), 50),
  });
  const foods = json.foods as {
    total_results?: string | number;
    page_number?: string | number;
    food?: unknown;
  } | undefined;
  const list = asArray(foods?.food as Record<string, unknown> | Record<string, unknown>[]).map((f) => ({
    foodId: String(f.food_id ?? ""),
    name: String(f.food_name ?? ""),
    brand: f.brand_name != null ? String(f.brand_name) : null,
    type: String(f.food_type ?? "Generic"),
  }));
  return {
    foods: list,
    totalResults: Number(foods?.total_results ?? 0) || 0,
    page: Number(foods?.page_number ?? page) || page,
  };
}

/** Карточка продукта с порциями (app-level). */
export async function getFood(foodId: string): Promise<{
  foodId: string;
  name: string;
  brand: string | null;
  servings: FsServing[];
}> {
  const json = await fsRestApp("food.get", { food_id: foodId });
  const f = json.food as Record<string, unknown> | undefined;
  return {
    foodId: String(f?.food_id ?? foodId),
    name: String(f?.food_name ?? ""),
    brand: f?.brand_name != null ? String(f.brand_name) : null,
    servings: normalizeServings(f),
  };
}

/**
 * Штрихкод в FatSecret (app-level). Не найден → null (error 211 — штатно).
 * ⚠️ Метод помечен Premier в доках: на free-тарифе вернёт ошибку → тоже null
 * (фолбэк на Open Food Facts покрывает этот случай).
 */
export async function findFoodByBarcode(barcode: string): Promise<FsFoodBrief | null> {
  try {
    const json = await fsRestApp("food.find_id_for_barcode", { barcode });
    const foodId =
      typeof json.food_id === "object"
        ? (json.food_id as { value?: unknown }).value
        : json.food_id;
    return foodId != null ? { foodId: String(foodId), name: "", brand: null, type: "Brand" } : null;
  } catch (e) {
    if (e instanceof FsApiError && (e.kind === "api" || e.fsCode === 211)) return null;
    throw e;
  }
}

/** Запись в дневник юзера (user-level). Возвращает food_entry_id. */
export async function createFoodEntry(
  token: { accessToken: string; accessTokenSecret: string },
  input: { foodId: string; servingId: string; units: number; meal: Meal; day: string },
): Promise<string> {
  const json = await fsRestUser(token, "food_entries.create", {
    food_id: input.foodId,
    serving_id: input.servingId,
    number_of_units: input.units,
    meal: mealForCreate(input.meal),
    date: dateToEpochDay(input.day),
  });
  const id = parseEntryId(json);
  if (!id) throw new FsApiError("food_entries.create: no food_entry_id in response", "api");
  return id;
}

/** Все записи дневника за день (user-level). */
export async function getDayEntries(
  token: { accessToken: string; accessTokenSecret: string },
  day: string,
): Promise<FsFoodEntry[]> {
  const json = await fsRestUser(token, "food_entries.get", { date: dateToEpochDay(day) });
  return parseDayEntries(json);
}

/** Дневные итоги за месяц, содержащий day (user-level; §9 sync). */
export async function getMonthDays(
  token: { accessToken: string; accessTokenSecret: string },
  day: string,
): Promise<FsMonthDay[]> {
  const json = await fsRestUser(token, "food_entries.get_month", { date: dateToEpochDay(day) });
  return parseMonthDays(json);
}
