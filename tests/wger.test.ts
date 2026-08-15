// @ts-check
/**
 * Юнит-тесты wger-клиента (§6.3; PHASE-5 §5.1, §6, §8).
 *
 * Pure-часть: stripHtml, нормализация exerciseinfo (RU-приоритет переводов),
 * clampText. Контракты HTTP (fetch-mock, без сети): фильтры/пагинация в URL,
 * retry на 5xx/429/сеть, 404 → not_found, не-JSON → parse, кэш таксономий/языков.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampText,
  getExerciseInfo,
  getTaxonomies,
  normalizeExerciseInfo,
  resetWgerCachesForTests,
  searchExercises,
  stripHtml,
  WGER_API_BASE,
  wgerErrorPayload,
  WgerError,
} from "../agent/lib/wger";

// ─────────────────────────────────────────────────────────────────────────────
// Фикстуры (форма — как у живого API, см. докстринг lib/wger.ts)
// ─────────────────────────────────────────────────────────────────────────────

function exerciseinfoRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 57,
    category: { id: 11, name: "Chest" },
    muscles: [
      { id: 4, name: "Pectoralis major", name_en: "Chest", is_front: true },
      { id: 3, name: "Serratus anterior", name_en: "", is_front: true },
    ],
    muscles_secondary: [],
    equipment: [{ id: 7, name: "none (bodyweight exercise)" }],
    images: [
      { image: "https://wger.de/media/a.png", is_main: false },
      { image: "https://wger.de/media/b.png", is_main: true },
    ],
    translations: [
      { id: 718, name: "Bear Walk", language: 1, description: "<p>Bär</p>" },
      { id: 719, name: "Bear Walk EN", language: 2, description: "<p>Walk like a<br>bear</p>" },
      { id: 720, name: "Медвежья ходьба", language: 5, description: "<p>Ходьба как медведь</p>" },
    ],
    ...over,
  };
}

describe("stripHtml", () => {
  it("теги → текст, li → буллеты, сущности раскрываются", () => {
    expect(stripHtml("<p>Line1</p><ul><li>a</li><li>b</li></ul>")).toBe("Line1\n• a\n• b");
    expect(stripHtml("a &amp; b &lt;c&gt; &nbsp;")).toBe("a & b <c>");
    expect(stripHtml("x<br>y")).toBe("x\ny");
  });
  it("не-строка → пусто", () => {
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml(42)).toBe("");
  });
});

describe("normalizeExerciseInfo", () => {
  it("RU-перевод приоритетнее; EN — сырье для LLM-перевода", () => {
    const e = normalizeExerciseInfo(exerciseinfoRaw());
    expect(e.id).toBe(57);
    expect(e.nameRu).toBe("Медвежья ходьба");
    expect(e.descriptionRu).toBe("Ходьба как медведь");
    expect(e.nameEn).toBe("Bear Walk EN");
    expect(e.descriptionEn).toBe("Walk like a\nbear");
    expect(e.category).toBe("Chest");
    expect(e.muscles).toEqual(["Chest", "Serratus anterior"]); // name_en || name
    expect(e.equipment).toEqual(["none (bodyweight exercise)"]);
    expect(e.imageUrl).toBe("https://wger.de/media/b.png"); // is_main
  });

  it("без RU — nameRu null; без EN — берётся любой перевод", () => {
    const noRu = normalizeExerciseInfo({
      ...exerciseinfoRaw(),
      translations: [{ id: 1, name: "Nur DE", language: 1, description: "" }],
    });
    expect(noRu.nameRu).toBeNull();
    expect(noRu.descriptionRu).toBeNull();
    expect(noRu.nameEn).toBe("Nur DE"); // fallback на первый доступный
  });

  it("без переводов — заглушка Exercise #id; без id — parse-ошибка", () => {
    const empty = normalizeExerciseInfo({ ...exerciseinfoRaw(), translations: [] });
    expect(empty.nameEn).toBe("Exercise #57");
    expect(() => normalizeExerciseInfo({ category: { id: 1, name: "x" } })).toThrow(WgerError);
  });
});

describe("clampText", () => {
  it("обрезает с многоточием, короткое не трогает, null остаётся null", () => {
    expect(clampText(null)).toBeNull();
    expect(clampText("abc", 5)).toBe("abc");
    expect(clampText("abcdefg", 5)).toBe("abcd…");
  });
});

describe("wgerErrorPayload", () => {
  it("каждый kind → user-friendly код без стека", () => {
    expect(wgerErrorPayload(new WgerError("x", "network")).error).toBe("wger_unavailable");
    expect(wgerErrorPayload(new WgerError("x", "rate_limited")).error).toBe("wger_rate_limited");
    expect(wgerErrorPayload(new WgerError("x", "not_found")).error).toBe("wger_not_found");
    expect(wgerErrorPayload(new WgerError("x", "parse")).error).toBe("wger_unexpected");
    expect(wgerErrorPayload(new WgerError("x", "http", 502)).error).toBe("wger_http_error");
    expect(wgerErrorPayload(new Error("boom")).error).toBe("wger_unexpected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Контракты HTTP (fetch-mock, без сети)
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Роутер-mock: язык → en=2/ru=5; /exerciseinfo/ список и /exerciseinfo/{id}/
 * карточка. Возвращает список захваченных вызовов.
 */
function stubWgerFetch(opts: { list?: unknown; detail?: unknown; listStatus?: number } = {}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.startsWith(`${WGER_API_BASE}/language/`)) {
        return jsonResponse({
          results: [
            { id: 2, short_name: "en", full_name: "English" },
            { id: 5, short_name: "ru", full_name: "Русский" },
          ],
        });
      }
      if (u.startsWith(`${WGER_API_BASE}/exerciseinfo/`)) {
        if (opts.listStatus !== undefined && opts.listStatus !== 200) {
          return jsonResponse({}, opts.listStatus);
        }
        return jsonResponse(opts.list ?? { count: 0, results: [] });
      }
      throw new Error(`unexpected url: ${u}`);
    }),
  );
  return calls;
}

beforeEach(() => {
  resetWgerCachesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetWgerCachesForTests();
  vi.useRealTimers();
});

describe("searchExercises (fetch-mock)", () => {
  it("фильтры/пагинация в URL, language=en (2) из /language/, нормализация результатов", async () => {
    const calls = stubWgerFetch({ list: { count: 1, results: [exerciseinfoRaw()] } });
    const page = await searchExercises({ categoryId: 11, equipmentId: 3, limit: 10, offset: 20 });

    expect(page.count).toBe(1);
    expect(page.results[0].nameEn).toBe("Bear Walk EN");
    expect(page.results[0].nameRu).toBe("Медвежья ходьба");

    const infoUrl = calls.find((c) => c.url.includes("/exerciseinfo/?"))!.url;
    expect(infoUrl).toContain("category=11");
    expect(infoUrl).toContain("equipment=3");
    expect(infoUrl).toContain("language=2");
    expect(infoUrl).toContain("limit=10");
    expect(infoUrl).toContain("offset=20");
    // языки кэшируются: ровно один запрос /language/
    expect(calls.filter((c) => c.url.includes("/language/"))).toHaveLength(1);
  });

  it("повторный поиск не дёргает /language/ (кэш процесса)", async () => {
    const calls = stubWgerFetch({ list: { count: 0, results: [] } });
    await searchExercises({});
    await searchExercises({});
    expect(calls.filter((c) => c.url.includes("/language/"))).toHaveLength(1);
  });

  it("таймаут-сигнал на каждую попытку", async () => {
    const calls = stubWgerFetch({ list: { count: 0, results: [] } });
    await searchExercises({});
    const info = calls.find((c) => c.url.includes("/exerciseinfo/?"))!;
    expect(info.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("getExerciseInfo (fetch-mock)", () => {
  it("карточка по id: /exerciseinfo/57/ без language-фильтра (все переводы)", async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push({ url: String(url), init: undefined });
        if (String(url).startsWith(`${WGER_API_BASE}/language/`)) {
          return jsonResponse({
            results: [
              { id: 2, short_name: "en" },
              { id: 5, short_name: "ru" },
            ],
          });
        }
        return jsonResponse(exerciseinfoRaw());
      }),
    );
    const e = await getExerciseInfo(57);
    expect(e.id).toBe(57);
    expect(e.nameRu).toBe("Медвежья ходьба");
    expect(calls.some((c) => c.url === `${WGER_API_BASE}/exerciseinfo/57/`)).toBe(true);
  });
});

describe("retry/ошибки (§16, fake timers на backoff)", () => {
  it("5xx → retry с backoff → успех на второй попытке", async () => {
    const calls: CapturedCall[] = [];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const u = String(url);
        if (u.startsWith(`${WGER_API_BASE}/language/`)) {
          return jsonResponse({
            results: [
              { id: 2, short_name: "en" },
              { id: 5, short_name: "ru" },
            ],
          });
        }
        attempt++;
        if (attempt === 1) return jsonResponse({}, 500);
        return jsonResponse(exerciseinfoRaw());
      }),
    );
    vi.useFakeTimers();

    const p = getExerciseInfo(57);
    const e = await vi.runAllTimersAsync().then(() => p);
    expect(e.id).toBe(57);
    expect(calls.filter((c) => c.url.includes("/exerciseinfo/57/"))).toHaveLength(2);
  });

  it("429 с Retry-After: пауза из заголовка, а не из дефолтного backoff (review P2)", async () => {
    const calls: CapturedCall[] = [];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const u = String(url);
        if (u.startsWith(`${WGER_API_BASE}/language/`)) {
          return jsonResponse({
            results: [
              { id: 2, short_name: "en" },
              { id: 5, short_name: "ru" },
            ],
          });
        }
        attempt++;
        if (attempt === 1) {
          return new Response(JSON.stringify({}), { status: 429, headers: { "retry-after": "5" } });
        }
        return jsonResponse(exerciseinfoRaw());
      }),
    );
    vi.useFakeTimers();

    const p = getExerciseInfo(57);
    await vi.advanceTimersByTimeAsync(4_999);
    // 4.999с от 5с Retry-After — вторая попытка ещё не началась (дефолтные
    // 400мс/2с давно бы прошли).
    expect(calls.filter((c) => c.url.includes("/exerciseinfo/57/"))).toHaveLength(1);
    const e = await vi.advanceTimersByTimeAsync(1).then(() => p);
    expect(e.id).toBe(57);
    expect(calls.filter((c) => c.url.includes("/exerciseinfo/57/"))).toHaveLength(2);
  });

  it("429 без Retry-After: увеличенный backoff (2с на первую паузу, не 400мс)", async () => {
    const calls: CapturedCall[] = [];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const u = String(url);
        if (u.startsWith(`${WGER_API_BASE}/language/`)) {
          return jsonResponse({
            results: [
              { id: 2, short_name: "en" },
              { id: 5, short_name: "ru" },
            ],
          });
        }
        attempt++;
        if (attempt === 1) return jsonResponse({}, 429);
        return jsonResponse(exerciseinfoRaw());
      }),
    );
    vi.useFakeTimers();

    const p = getExerciseInfo(57);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls.filter((c) => c.url.includes("/exerciseinfo/57/"))).toHaveLength(1); // ждём 2с
    const e = await vi.advanceTimersByTimeAsync(1).then(() => p);
    expect(e.id).toBe(57);
    expect(calls.filter((c) => c.url.includes("/exerciseinfo/57/"))).toHaveLength(2);
  });

  it("сеть падает все попытки → wger_unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    vi.useFakeTimers();

    const p = getExerciseInfo(57).catch((e) => e);
    const err = await vi.runAllTimersAsync().then(() => p);
    expect(err).toBeInstanceOf(WgerError);
    expect(wgerErrorPayload(err).error).toBe("wger_unavailable");
  });

  it("404 → not_found сразу (без ретраев)", async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ detail: "No Exercise matches the given query." }, 404);
      }),
    );
    const err = await getExerciseInfo(999).catch((e) => e);
    expect(err).toBeInstanceOf(WgerError);
    expect((err as InstanceType<typeof WgerError>).kind).toBe("not_found");
    // язык (1) + карточка (1); ретраев карточки нет
    expect(calls.filter((c) => c.url.includes("/exerciseinfo/999/"))).toHaveLength(1);
  });

  it("не-JSON 200 → parse-ошибка", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>wger maintenance</html>", { status: 200 })),
    );
    const err = await getExerciseInfo(57).catch((e) => e);
    expect(err).toBeInstanceOf(WgerError);
    expect((err as InstanceType<typeof WgerError>).kind).toBe("parse");
  });
});

describe("getTaxonomies (fetch-mock)", () => {
  it("категории/оборудование/мышцы одним заходом, кэшируется", async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push({ url: String(url), init: undefined });
        const u = String(url);
        if (u.includes("/exercisecategory/")) {
          return jsonResponse({ results: [{ id: 11, name: "Chest" }] });
        }
        if (u.includes("/equipment/")) {
          return jsonResponse({ results: [{ id: 3, name: "Dumbbell" }] });
        }
        if (u.includes("/muscle/")) {
          return jsonResponse({
            results: [{ id: 4, name: "Pectoralis major", name_en: "Chest", is_front: true }],
          });
        }
        throw new Error(`unexpected url: ${u}`);
      }),
    );

    const t = await getTaxonomies();
    expect(t.categories).toEqual([{ id: 11, name: "Chest" }]);
    expect(t.equipment).toEqual([{ id: 3, name: "Dumbbell" }]);
    expect(t.muscles).toEqual([{ id: 4, nameEn: "Chest", isFront: true }]);

    await getTaxonomies();
    expect(calls).toHaveLength(3); // кэш: второй вызов без сети
  });
});
