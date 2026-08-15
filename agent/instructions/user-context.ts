// @ts-check
/**
 * Динамический контекст пользователя (§4) — на `turn.started`.
 *
 * Подставляет краткое досье пользователя в системный промпт: профиль, цель,
 * timezone, уровень активности + тренды за неделю (фаза 3: сон/шаги/вес/
 * калории/тренировки из `lib/weekly-digest`).
 *
 * Применяется ТОЛЬКО к онборженным пользователям (не онборженных ведёт
 * `onboarding-guard`). Не дублирует tone-инструкцию (она — в `tone.ts`).
 *
 * Digest — тяжеловат для каждого turn'а (7–14 дней чтения), поэтому кэшируется
 * в памяти на 10 минут per-user (семья из нескольких человек; паттерн §9
 * in-memory). Сбой трендов НЕ ломает интерактивный чат — try/catch.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { getChatId } from "../lib/tenant";
import { loadUserOverview } from "../lib/user-status";
import { buildDigestTrendLines, buildWeeklyDigest, type WeekDigest } from "../lib/weekly-digest";

/** TTL кэша digest (мс): тренды в системном промпте могут отставать ≤10 мин. */
const DIGEST_TTL_MS = 10 * 60_000;

const digestCache = new Map<string, { expiresAt: number; digest: WeekDigest }>();

async function digestCached(userId: string): Promise<WeekDigest> {
  const cached = digestCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.digest;
  const digest = await buildWeeklyDigest(userId);
  digestCache.set(userId, { expiresAt: Date.now() + DIGEST_TTL_MS, digest });
  return digest;
}

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const chatId = getChatId(ctx);
      if (chatId === null) return null;

      const o = await loadUserOverview(chatId);
      if (!o || o.onboardedAt === null) return null; // не онборжен — контекст не нужен (режим онбординга)

      const lines: string[] = ["## Контекст пользователя (verified from DB)"];
      lines.push(`- timezone: ${o.timezone}`);
      lines.push(`- tone: ${o.tonePreset}`);

      if (o.profile) {
        const ageYears = ageFromBirth(o.profile.birthDate);
        lines.push(
          `- профиль: ${sexRu(o.profile.sex)}, ${ageYears} лет, рост ${o.profile.heightCm} см` +
            (o.profile.currentWeightKg != null ? `, вес ${o.profile.currentWeightKg} кг` : "") +
            `, активность: ${o.profile.selfReportedActivityLevel}`,
        );
      }
      if (o.activeGoal) {
        const g = o.activeGoal;
        const detail =
          g.kind === "maintenance"
            ? "удержание веса"
            : [
                g.targetWeightKg != null ? `цель ${g.targetWeightKg} кг` : null,
                g.tempoKgPerWeek != null ? `темп ${g.tempoKgPerWeek} кг/нед` : null,
                g.targetDate != null ? `дедлайн ${g.targetDate.toISOString().slice(0, 10)}` : null,
              ]
                .filter(Boolean)
                .join(", ");
        lines.push(`- цель: ${g.kind} (${detail})`);
      }
      if (o.reminders) {
        const r = o.reminders;
        const times = [r.morningLocal, r.middayLocal, r.eveningLocal]
          .filter(Boolean)
          .map((t) => String(t).slice(0, 5))
          .join(" / ");
        if (times) lines.push(`- напоминания: ${times} (локальное время)`);
      }

      // Тренды недели (фаза 3) — необязательная часть: сбой не ломает turn.
      try {
        const trends = buildDigestTrendLines(await digestCached(o.userId));
        if (trends.length > 0) {
          lines.push("");
          lines.push("## Тренды за последние 7 завершённых дней");
          lines.push(...trends);
        }
      } catch {
        // тихо: тренды — обогащение, не критичный контекст
      }

      return defineInstructions({ markdown: lines.join("\n") });
    },
  },
});

function sexRu(sex: string): string {
  if (sex === "male") return "муж";
  if (sex === "female") return "жен";
  return sex;
}

function ageFromBirth(birth: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}
