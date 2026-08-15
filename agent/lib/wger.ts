// @ts-check
/**
 * wger REST-клиент (§6.3, §8, §16; PHASE-5 §5.1, §6).
 *
 * https://wger.de/api/v2/ — бесплатный REST, без ключа, без auth (на чтение).
 * Свои tools с прямыми fetch (решение §6.3/§20.4 — без OpenAPI-коннекции):
 * чище для перевода и фильтрации.
 *
 * Эндпоинты (контракт сверен с живым API 2026-08-15):
 *  - `/exerciseinfo/?category=&equipment=&language=&limit=&offset=` — список
 *    упражнений с вложениями (category/muscles/equipment/images/translations);
 *    поддерживает пагинацию DRF `{count, next, previous, results}`;
 *  - `/exerciseinfo/{id}/` — карточка одного упражнения (ВСЕ переводы — из него
 *    берём русский, если он у wger есть);
 *  - `/exercisecategory/`, `/equipment/`, `/muscle/`, `/language/` — таксономии
 *    (кэшируются в памяти процесса).
 *
 * Перевод (§6.3): русский ≈1% покрытия wger. Приоритет: готовый wger-RU
 * translation (language id 5) → английское имя/описание (агент переводит на
 * русский на лету, правило в instructions.md). Английское имя кэшируется в
 * `program_sessions.exercise_name_en`.
 *
 * Ошибки (§16): 429/5xx/сеть → retry с экспоненциальным backoff (3 попытки);
 * при провале — user-friendly сообщение без стека.
 */
import { log, type Component } from "./log";

export const WGER_API_BASE = "https://wger.de/api/v2";
export const WGER_FETCH_TIMEOUT_MS = 15_000;

/** Дефолты language-id (en=2, ru=5), если /language/ недоступен. */
export const WGER_LANG_FALLBACK = { en: 2, ru: 5 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Ошибки (§16)
// ─────────────────────────────────────────────────────────────────────────────

export type WgerErrorKind =
  | "network" // сеть/таймаут/5xx после ретраев — wger недоступен
  | "rate_limited" // 429 после ретраев
  | "not_found" // 404 — упражнение не найдено
  | "http" // прочие не-2xx
  | "parse"; // не-JSON / кривое тело

export class WgerError extends Error {
  readonly kind: WgerErrorKind;
  readonly status?: number;
  constructor(message: string, kind: WgerErrorKind, status?: number) {
    super(message);
    this.name = "WgerError";
    this.kind = kind;
    this.status = status;
  }
}

/** Маппинг WgerError → user-friendly код для результата tool'а. */
export function wgerErrorPayload(e: unknown): { error: string; message: string } {
  if (e instanceof WgerError) {
    switch (e.kind) {
      case "network":
        return { error: "wger_unavailable", message: "База упражнений недоступна — попробуй ещё раз чуть позже." };
      case "rate_limited":
        return { error: "wger_rate_limited", message: "База упражнений перегружена — попробуй через минуту." };
      case "not_found":
        return { error: "wger_not_found", message: "Упражнение не найдено в базе wger." };
      case "parse":
        return { error: "wger_unexpected", message: "База упражнений вернула неожиданный ответ — попробуй ещё раз." };
    }
    return { error: "wger_http_error", message: `База упражнений ответила ошибкой (HTTP ${e.status ?? "?"}).` };
  }
  return { error: "wger_unexpected", message: "Неожиданная ошибка обращения к базе упражнений." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Низкоуровневый вызов с retry (§6 PHASE-5: 429/5xx/сеть → backoff;
// review P2: для 429 — заметно больший backoff + уважение Retry-After)
// ─────────────────────────────────────────────────────────────────────────────

/** Задержки для 5xx/сети (как у FatSecret-клиента). */
const RETRY_DELAYS_MS = [400, 1200, 3600];
/** Задержки для 429 без Retry-After — rate-limit «острее» серверной ошибки. */
const RATE_LIMIT_DELAYS_MS = [2000, 8000, 20000];
/** Cap на задержку из Retry-After (не виснуть на абсурдных значениях). */
const RETRY_AFTER_CAP_MS = 30_000;

/** Retry-After (секунды или HTTP-date) → задержка мс; null — заголовка нет. */
function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw == null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(raw); // редкая HTTP-date форма
  if (Number.isFinite(dateMs)) return dateMs - Date.now();
  return null;
}

/** Задержка перед следующей попыткой: Retry-After (429) > таблица по типу сбоя. */
function retryDelayMs(res: Response | null, attempt: number): number {
  if (res != null && res.status === 429) {
    const ra = parseRetryAfterMs(res);
    if (ra != null && ra > 0) return Math.min(ra, RETRY_AFTER_CAP_MS);
    return RATE_LIMIT_DELAYS_MS[attempt] ?? RATE_LIMIT_DELAYS_MS[RATE_LIMIT_DELAYS_MS.length - 1];
  }
  return RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

async function fetchWgerJson(
  path: string,
  params: Record<string, string | number | undefined>,
  component: Component,
): Promise<unknown> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const url = qs.size > 0 ? `${WGER_API_BASE}${path}?${qs.toString()}` : `${WGER_API_BASE}${path}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      // Таймаут на каждую попытку (паттерн FatSecret-фикса P1): signal покрывает
      // и чтение тела.
      const res = await fetch(url, { signal: AbortSignal.timeout(WGER_FETCH_TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) {
        lastError = new WgerError(`HTTP ${res.status}`, res.status === 429 ? "rate_limited" : "network", res.status);
        log(component, "wger-retry", "warn", { status: res.status, attempt });
        if (attempt < RETRY_DELAYS_MS.length) {
          const delay = retryDelayMs(res, attempt);
          log(component, "wger-retry-wait", "warn", { attempt, delay_ms: delay });
          await new Promise((r) => setTimeout(r, delay));
        }
        continue;
      }
      if (!res.ok) {
        throw new WgerError(`HTTP ${res.status}`, res.status === 404 ? "not_found" : "http", res.status);
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new WgerError(`non-JSON response: ${text.slice(0, 120)}`, "parse");
      }
    } catch (e) {
      if (e instanceof WgerError) throw e; // не-ретраимые уже классифицированы
      // Сетевой сбой/таймаут fetch (DNS/ECONNRESET/TimeoutError) — ретраим.
      lastError = e;
      log(component, "wger-network-retry", "warn", {
        attempt,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  throw lastError instanceof WgerError ? lastError : new WgerError("network failure", "network");
}

// ─────────────────────────────────────────────────────────────────────────────
// Нормализация (pure — unit-тестируется)
// ─────────────────────────────────────────────────────────────────────────────

/** HTML-описание wger → читаемый текст (переводы строк, сущности). */
export function stripHtml(html: unknown): string {
  if (typeof html !== "string") return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li\s*>/gi, "• ")
    .replace(/<\s*\/\s*(p|li|ul|ol|h\d+)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface WgerTranslation {
  languageId: number;
  name: string;
  description: string;
}

export interface WgerExercise {
  id: number;
  nameEn: string;
  nameRu: string | null;
  /** Описание на русском, если у wger есть RU-перевод. */
  descriptionRu: string | null;
  /** Английское описание (сырьё для LLM-перевода агентом). */
  descriptionEn: string | null;
  category: string;
  muscles: string[];
  equipment: string[];
  imageUrl: string | null;
}

interface RawTranslation {
  language?: unknown;
  name?: unknown;
  description?: unknown;
}

function normalizeTranslations(rawList: unknown): WgerTranslation[] {
  if (!Array.isArray(rawList)) return [];
  const out: WgerTranslation[] = [];
  for (const t of rawList as RawTranslation[]) {
    const languageId = Number(t?.language);
    const name = typeof t?.name === "string" ? t.name.trim() : "";
    if (!Number.isFinite(languageId) || !name) continue;
    out.push({ languageId, name, description: stripHtml(t?.description) });
  }
  return out;
}

function pickTranslation(
  translations: WgerTranslation[],
  langId: number,
): WgerTranslation | null {
  return translations.find((t) => t.languageId === langId && t.name) ?? null;
}

function nameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    const nameEn = typeof m?.name_en === "string" ? m.name_en.trim() : "";
    const name = typeof m?.name === "string" ? m.name.trim() : "";
    const label = nameEn || name;
    if (label) out.push(label);
  }
  return out;
}

function mainImage(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const main = (raw as Record<string, unknown>[]).find((i) => i?.is_main === true);
  const chosen = main ?? raw[0];
  return typeof chosen?.image === "string" ? chosen.image : null;
}

/**
 * Нормализация одного `/exerciseinfo`-объекта (pure). `langIds` — динамически
 * разрешённые language-id (fallback: en=2, ru=5).
 */
export function normalizeExerciseInfo(
  raw: unknown,
  langIds: { en: number; ru: number } = WGER_LANG_FALLBACK,
): WgerExercise {
  const obj = raw as Record<string, unknown> | null;
  const id = Number(obj?.id);
  if (!Number.isFinite(id)) throw new WgerError("exerciseinfo: no id", "parse");
  const translations = normalizeTranslations(obj?.translations);
  const en = pickTranslation(translations, langIds.en);
  const ru = pickTranslation(translations, langIds.ru);
  const any = en ?? ru ?? translations[0] ?? null;
  const category = (obj?.category as Record<string, unknown> | undefined) ?? undefined;
  return {
    id,
    nameEn: en?.name ?? any?.name ?? `Exercise #${id}`,
    nameRu: ru?.name ?? null,
    descriptionRu: ru?.description ? ru.description : null,
    descriptionEn: en?.description ? en.description : null,
    category: typeof category?.name === "string" ? category.name : "",
    muscles: nameList(obj?.muscles),
    equipment: nameList(obj?.equipment),
    imageUrl: mainImage(obj?.images),
  };
}

/** Обрезать описание до разумной длины (для контекста модели). */
export function clampText(text: string | null, max = 500): string | null {
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Таксономии и языки (кэш в памяти процесса)
// ─────────────────────────────────────────────────────────────────────────────

export interface WgerTaxonomies {
  categories: { id: number; name: string }[];
  equipment: { id: number; name: string }[];
  muscles: { id: number; nameEn: string; isFront: boolean }[];
}

function nameIdList(raw: unknown): { id: number; name: string }[] {
  const results = (raw as Record<string, unknown> | undefined)?.results;
  if (!Array.isArray(results)) return [];
  const out: { id: number; name: string }[] = [];
  for (const r of results as Record<string, unknown>[]) {
    const id = Number(r?.id);
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    if (Number.isFinite(id) && name) out.push({ id, name });
  }
  return out;
}

let languagesPromise: Promise<Map<string, number>> | null = null;
let taxonomiesPromise: Promise<WgerTaxonomies> | null = null;

/** language short_name ('en'/'ru') → id. Кэш; fetch /language/ один раз. */
export async function getLanguageIds(component: Component = "tool"): Promise<Map<string, number>> {
  if (!languagesPromise) {
    languagesPromise = (async () => {
      const raw = await fetchWgerJson("/language/", { limit: 100 }, component);
      const results = (raw as Record<string, unknown> | undefined)?.results;
      const map = new Map<string, number>();
      if (Array.isArray(results)) {
        for (const l of results as Record<string, unknown>[]) {
          const id = Number(l?.id);
          const short = typeof l?.short_name === "string" ? l.short_name.trim().toLowerCase() : "";
          if (Number.isFinite(id) && short) map.set(short, id);
        }
      }
      return map;
    })().catch((e) => {
      languagesPromise = null; // сбой не кэшируем — следующий вызов повторит
      throw e;
    });
  }
  return languagesPromise;
}

async function resolveLangIds(component: Component): Promise<{ en: number; ru: number }> {
  try {
    const ids = await getLanguageIds(component);
    return {
      en: ids.get("en") ?? WGER_LANG_FALLBACK.en,
      ru: ids.get("ru") ?? WGER_LANG_FALLBACK.ru,
    };
  } catch {
    return { ...WGER_LANG_FALLBACK }; // таксономия недоступна — работаем на дефолтах
  }
}

/** Категории/оборудование/мышцы (для маппинга «дом/зал» → id). Кэш. */
export async function getTaxonomies(component: Component = "tool"): Promise<WgerTaxonomies> {
  if (!taxonomiesPromise) {
    taxonomiesPromise = (async () => {
      const [catRaw, eqRaw, muscRaw] = await Promise.all([
        fetchWgerJson("/exercisecategory/", { limit: 50 }, component),
        fetchWgerJson("/equipment/", { limit: 50 }, component),
        fetchWgerJson("/muscle/", { limit: 50 }, component),
      ]);
      const musclesRaw = (muscRaw as Record<string, unknown> | undefined)?.results;
      const muscles: { id: number; nameEn: string; isFront: boolean }[] = [];
      if (Array.isArray(musclesRaw)) {
        for (const m of musclesRaw as Record<string, unknown>[]) {
          const id = Number(m?.id);
          const nameEn = typeof m?.name_en === "string" && m.name_en.trim() ? m.name_en.trim()
            : typeof m?.name === "string" ? m.name.trim() : "";
          if (Number.isFinite(id) && nameEn) {
            muscles.push({ id, nameEn, isFront: m?.is_front === true });
          }
        }
      }
      return { categories: nameIdList(catRaw), equipment: nameIdList(eqRaw), muscles };
    })().catch((e) => {
      taxonomiesPromise = null;
      throw e;
    });
  }
  return taxonomiesPromise;
}

/** Сброс кэшей (для unit-тестов; в рантайме не вызывать). */
export function resetWgerCachesForTests(): void {
  languagesPromise = null;
  taxonomiesPromise = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Публичные вызовы
// ─────────────────────────────────────────────────────────────────────────────

export interface WgerPage<T> {
  count: number;
  results: T[];
}

export interface SearchExercisesOpts {
  categoryId?: number;
  equipmentId?: number;
  limit?: number;
  offset?: number;
}

/**
 * Поиск упражнений: `/exerciseinfo/` с фильтрами (category/equipment/language).
 * Английский language-фильтр гарантирует наличие EN-имени (сырьё для перевода);
 * RU-перевод, если есть у wger, приходит в translations.
 */
export async function searchExercises(
  opts: SearchExercisesOpts,
  component: Component = "tool",
): Promise<WgerPage<WgerExercise>> {
  const limit = opts.limit ?? 10;
  const langIds = await resolveLangIds(component);
  const raw = await fetchWgerJson(
    "/exerciseinfo/",
    {
      category: opts.categoryId,
      equipment: opts.equipmentId,
      language: langIds.en,
      limit,
      offset: opts.offset ?? 0,
    },
    component,
  );
  const page = raw as Record<string, unknown> | null;
  const results = Array.isArray(page?.results) ? (page!.results as unknown[]) : [];
  return {
    count: Number(page?.count ?? results.length) || results.length,
    results: results.map((r) => normalizeExerciseInfo(r, langIds)),
  };
}

/** Карточка упражнения (ВСЕ переводы — отсюда берём русский). 404 → not_found. */
export async function getExerciseInfo(
  id: number,
  component: Component = "tool",
): Promise<WgerExercise> {
  const langIds = await resolveLangIds(component);
  const raw = await fetchWgerJson(`/exerciseinfo/${id}/`, {}, component);
  return normalizeExerciseInfo(raw, langIds);
}
