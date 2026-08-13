// @ts-check
/**
 * Загрузка среза состояния пользователя (профиль + активная цель + напоминания).
 * Общая для динамической инструкции `user-context.ts` и инструмента
 * `get-my-status`, чтобы не дублировать JOIN-логику.
 *
 * Ключ — `chatId` (строка Telegram chat id), т.к. именно он доступен из сессии
 * и в `requireUser`, и в динамических инструкциях.
 */
import { and, eq } from "drizzle-orm";

import { db } from "./db/client";
import { goals, profiles, reminderSettings, users } from "./db/schema";

export interface UserOverview {
  userId: string;
  chatId: string;
  timezone: string;
  timezoneSetAt: Date | null;
  tonePreset: string;
  onboardedAt: Date | null;
  blocked: boolean;
  profile: {
    sex: string;
    birthDate: Date;
    heightCm: number;
    currentWeightKg: number | null;
    selfReportedActivityLevel: string;
  } | null;
  activeGoal: {
    kind: string;
    targetWeightKg: number | null;
    targetDate: Date | null;
    tempoKgPerWeek: number | null;
    calorieSource: string;
    manualTargetKcal: number | null;
  } | null;
  reminders: {
    morningLocal: string | null;
    middayLocal: string | null;
    eveningLocal: string | null;
    workoutTimes: { day_of_week: number; local_time: string }[] | null;
  } | null;
}

export async function loadUserOverview(chatId: string): Promise<UserOverview | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.telegramChatId, BigInt(chatId)),
  });
  if (!user) return null;

  const [profile, activeGoal, reminders] = await Promise.all([
    db.query.profiles.findFirst({ where: eq(profiles.userId, user.id) }),
    db.query.goals.findFirst({
      where: and(eq(goals.userId, user.id), eq(goals.active, true)),
    }),
    db.query.reminderSettings.findFirst({ where: eq(reminderSettings.userId, user.id) }),
  ]);

  return {
    userId: user.id,
    chatId,
    timezone: user.timezone,
    timezoneSetAt: user.timezoneSetAt,
    tonePreset: user.tonePreset,
    onboardedAt: user.onboardedAt,
    blocked: user.blocked,
    profile: profile
      ? {
          sex: profile.sex,
          birthDate: profile.birthDate,
          heightCm: profile.heightCm,
          currentWeightKg: profile.currentWeightKg,
          selfReportedActivityLevel: profile.selfReportedActivityLevel,
        }
      : null,
    activeGoal: activeGoal
      ? {
          kind: activeGoal.kind,
          targetWeightKg: activeGoal.targetWeightKg,
          targetDate: activeGoal.targetDate,
          tempoKgPerWeek: activeGoal.tempoKgPerWeek,
          calorieSource: activeGoal.calorieSource,
          manualTargetKcal: activeGoal.manualTargetKcal,
        }
      : null,
    reminders: reminders
      ? {
          morningLocal: reminders.morningLocal,
          middayLocal: reminders.middayLocal,
          eveningLocal: reminders.eveningLocal,
          workoutTimes: reminders.workoutTimes ?? null,
        }
      : null,
  };
}

/** Прогресс онбординга: какие ключевые шаги уже выполнены. */
export function onboardingStepsDone(o: UserOverview): {
  profile: boolean;
  timezone: boolean;
  goal: boolean;
  activity: boolean;
  tone: boolean;
  reminders: boolean;
  onboarded: boolean;
} {
  return {
    profile: o.profile !== null,
    // Шаг 3 (tz) пройден, только если юзер явно выбирал пояс (set-tz). Колонка
    // timezone_set_at — честный маркер; tz-значение всегда заполнено (default),
    // поэтому проверять само поле нельзя.
    timezone: o.timezoneSetAt !== null,
    goal: o.activeGoal !== null,
    activity: o.profile?.selfReportedActivityLevel != null,
    tone: true, // tone всегда задан (default supportive); шаг считаем пройденным
    reminders: o.reminders !== null,
    onboarded: o.onboardedAt !== null,
  };
}
