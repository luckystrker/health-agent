// @ts-check
/**
 * `userAuthFor` — синтезированный Telegram user-principal для proactive-сообщений
 * из schedules (§9).
 *
 * Schedules в eve запускаются от appAuth (`principalType: "runtime"`,
 * `principalId: "eve:app"`) — это НЕ пользовательский principal, и `requireUser`
 * упадёт. Поэтому per-user сообщения (отчёт, напоминалки, алерты) отправляются
 * через dispatcher, который для каждого юзера синтезирует user-auth отдельной
 * proactive-сессии. Внутри такой сессии `requireUser(ctx)` отработает корректно.
 *
 * На фазе 0 — экспортируется и unit-тестируется на формат (PHASE-0 §6.3).
 * Потребляется schedules в фазах 3/4.
 */

export interface SynthesizedUserPrincipal {
  readonly authenticator: "telegram-webhook";
  readonly principalId: string;
  readonly principalType: "user";
  readonly attributes: {
    readonly chat_id: string;
    readonly user_id: string;
  };
}

/**
 * @param u — `{ telegram_chat_id: bigint; user_id: string }` (из таблицы users).
 * @returns синтезированный principal для `to(telegram, {chatId}).send(msg, {auth})`.
 */
export function userAuthFor(u: {
  telegram_chat_id: bigint;
  user_id: string;
}): SynthesizedUserPrincipal {
  return {
    authenticator: "telegram-webhook",
    principalId: `telegram:${u.telegram_chat_id}`,
    principalType: "user",
    attributes: {
      chat_id: String(u.telegram_chat_id),
      user_id: u.user_id,
    },
  };
}
