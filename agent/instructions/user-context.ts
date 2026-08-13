// @ts-check
/**
 * Динамический контекст пользователя (§4) — на `turn.started`.
 *
 * Подставляет краткое досье пользователя в системный промпт: профиль, цель,
 * timezone, уровень активности. Тренды/агрегаты добавятся в фазах 1–3.
 *
 * Применяется ТОЛЬКО к онборженным пользователям (не онборженных ведёт
 * `onboarding-guard`).
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { getChatId } from "../lib/tenant";
import { loadUserOverview } from "../lib/user-status";

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
