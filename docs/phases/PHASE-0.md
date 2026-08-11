# Фаза 0 — Скелет eve: Telegram, БД, schema, онбординг

> Спецификация фазы. Источник правды — [`../SPECIFICATION.md`](../SPECIFICATION.md).
> Состав фазы — из §19. Перед стартом прочитай [`../../AGENTS.md`](../../AGENTS.md) и
> актуальное состояние в [`../STATUS.md`](../STATUS.md).

**Статус:** 🔲 не начата.

---

## 1. Цели и границы

### Что входит в фазу
- Перевести проект с дефолтного Vercel-скелета на health-структуру: Telegram-канал,
  Postgres-клиент (drizzle), schema всех таблиц, базовый агент и системный промпт.
- Полная схема БД (`agent/lib/db/schema.ts`) + миграции (`drizzle/`) — **все таблицы
  проекта**, а не только фазы-0-специфичные (schema — единый артефакт; фазы заполняют её
  по частям при имплементации, но типы/индексы фиксируются здесь).
- Онбординг (10 шагов, inline-кнопки) + `onboarding-guard` хук.
- `tenant.ts` (`requireUser`), `user-auth.ts` (`userAuthFor`), настройки tone-пресетов.
- `.env.example`, `.gitignore`, `tsconfig.json` (уточнить paths).
- Локальный dev-сетап: `docker compose` с Postgres 16, `eve dev` + туннель.

### Что НЕ входит (откладывается на следующие фазы)
- Phone-hub ingestion и запись `raw_samples` → **фаза 1**.
- FatSecret, food_entries, расчёт калорий → **фаза 2**.
- Недельный отчёт, графики, расписание schedules → **фаза 3+**.
- Инструменты чтения БД (`get-sleep` и пр.) — те из них, что нужны онбордингу и базовому
  агенту, идут здесь; аналитические — в своих фазах.

### Ключевое архитектурное решение фазы
На этом этапе фиксируются **глобальные** контракты: идентификация юзера через Telegram
principal (`requireUser`), синтезированный user-auth для schedules (`userAuthFor`),
timezone-aware «локальный день», тон-пресеты как динамическая инструкция. Все следующие
фазы на них опираются.

---

## 2. Зависимости

- Нет (стартовая фаза). Все остальные фазы зависят от этой.

---

## 3. Создаваемые/изменяемые файлы

| Путь | Назначение | Спека |
|------|------------|-------|
| `agent/agent.ts` | `defineAgent` под health: модель, limits, channels, hooks | §4 |
| `agent/instructions.md` | Базовый системный промпт health-агента (русский, общие правила) | §4, §11 |
| `agent/instructions/user-context.ts` | Динамическая инструкция: профиль+тренды юзера на `turn.started` | §4 |
| `agent/instructions/tone.ts` | Динамическая инструкция: подстановка tone-пресета на `turn.started` | §11.3 |
| `agent/channels/telegram.ts` | `telegramChannel({ botUsername })`, allowlist по `ALLOWED_CHAT_IDS` | §7.1 |
| `agent/channels/eve.ts` | **УДАЛИТЬ** (Vercel-скелет) | — |
| `agent/lib/db/client.ts` | Postgres-клиент (drizzle-orm) | §4, §14 |
| `agent/lib/db/schema.ts` | drizzle-схема всех таблиц проекта | §5 |
| `agent/lib/tenant.ts` | `requireUser(ctx)` → `user_id` из `ctx.session.auth.current` | §7 «Идентификация юзера» |
| `agent/lib/user-auth.ts` | `userAuthFor(u)` — синтезированный principal для schedules | §9 |
| `agent/lib/tone-presets.ts` | 4 пресета: supportive / sarcastic / strict / neutral | §11.3 |
| `agent/hooks/onboarding-guard.ts` | `turn.started`: если юзер не онборжен — направить в онбординг | §10 |
| `agent/tools/goals/update-profile.ts` | Запись пол/возраст/рост/вес/уровень активности | §8 |
| `agent/tools/goals/set-goal.ts` | Цель по весу/темпу/дедлайну | §8 |
| `agent/tools/settings/set-tone.ts` | Смена tone-пресета | §8, §11.3 |
| `agent/tools/settings/set-reminders.ts` | Время напоминаний | §8 |
| `agent/tools/settings/set-tz.ts` | Часовой пояс | §8 |
| `drizzle/` | Каталог миграций (`drizzle-kit generate`) | §14 |
| `docker-compose.yml` | Postgres 16, `127.0.0.1:5432`, named volume `pgdata`, `pgcrypto` | §14 |
| `.env.example` | Все env-переменные (см. §5 ниже) | §14 |
| `.gitignore` | `.env`, `node_modules`, `.eve/builds`, build artefacts | §4 |
| `tsconfig.json` | Уточнить `paths` под `#*`-импорты (уже есть в `package.json`) | §4 |
| `agent/schedules/` | Каталог (пустой на фазе 0, заполняется в фазах 1/3/4) | §4 |

> **Модель агента.** В дефолтном скелете `model: "anthropic/claude-sonnet-5"`. Подтвердить,
> что эта модель подходит для русскоязычного health-агента с tone-вариациями, либо сменить.
> Записать выбор в STATUS.md.

---

## 4. Таблицы БД и миграции

`agent/lib/db/schema.ts` описывает **все** таблицы из SPECIFICATION.md §5. На фазе 0
создаются миграции под все таблицы сразу (единый снимок schema); в коде они наполняются
по фазам. На фазе 0 **активно используются** таблицы онбординга/профиля/целей/настроек.

Таблицы (спека — §5):
- **§5.1 Профили и настройки:** `users` (включая `blocked boolean default false` — флаг
  выставляется при Telegram 403, см. §16; применяется в schedules фаз 3/4), `profiles`,
  `weight_log`, `phone_hub_tokens`.
- **§5.2 Цели:** `goals`.
- **§5.3 Данные с часов:** `raw_samples`, `daily_aggregates` (+ индексы).
- **§5.4 Питание:** `food_entries` (+ индекс `(user_id, day)` + partial-unique по
  `external_id`).
- **§5.5 Тренировки:** `workout_programs`, `program_sessions`, `workout_logs`.
- **§5.6 Напоминания:** `reminder_settings`.
- **§5.7 FatSecret:** `fatsecret_tokens`.

Особенности миграций:
- `CREATE EXTENSION pgcrypto;` — в первой миграции (для `gen_random_uuid()`).
- Timestamp'ы — `timestamptz`, всё в UTC.
- `bigint generated always as identity` для id-таблиц без UUID (§5.3, §5.4, §5.5).
- Индексы: `(user_id, metric, recorded_at)` и `(received_at)` на `raw_samples`;
  `(user_id, day)` на `food_entries`; `(user_id, program_version, day_of_week, sort_order)`
  на `program_sessions` — см. §5.

---

## 5. Env-переменные (`.env.example`)

Из SPECIFICATION.md §14. На фазе 0 достаточно.Telegram+DB;остальные — комментарием «фаза N».

```
# Telegram (фаза 0)
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET_TOKEN=
ALLOWED_CHAT_IDS=           # через запятую: 123456789,987654321

# БД (фаза 0)
DATABASE_URL=postgres://health:PASSWORD@127.0.0.1:5432/health
POSTGRES_PASSWORD=

# FatSecret (фаза 2)
FATSECRET_CLIENT_ID=
FATSECRET_CLIENT_SECRET=

# Phone-hub (фаза 1)
PHONE_HUB_TOKEN_SALT=

# Модель (фаза 0)
MODEL_API_KEY=
```

---

## 6. Детали реализации

### 6.1 Telegram-канал и allowlist
- `agent/channels/telegram.ts`: `telegramChannel({ botUsername: env.TELEGRAM_BOT_USERNAME })`.
- Allowlist: на `turn.started` сверять `attributes.chat_id` с `ALLOWED_CHAT_IDS`
  (split по `,`, trim). Чужой — молча игнорировать (§7.1).
- Удалить `agent/channels/eve.ts` (Vercel-скелет), убрать `@vercel/connect` из
  зависимостей, если он больше нигде не нужен.

### 6.2 `requireUser` (`agent/lib/tenant.ts`)
- Читает `ctx.session.auth.current` (НЕ парсит continuation-токен).
- Проверяет `principalType === "user"` и `authenticator === "telegram-webhook"`.
- Достаёт `chat_id` из `attributes.chat_id`, находит `user_id` по `users.telegram_chat_id`.
- Бросает `authenticated user required`, если principal отсутствует или юзер не найден.
- Юнит-тесты: разные principal-форматы (приватный чат), отстутствие principal,
  неизвестный chat_id. (См. §18.1.)

### 6.3 `userAuthFor` (`agent/lib/user-auth.ts`)
- Сигнатура и формат — §9 (код-блок в спеке).
- Используется всеми schedules в фазах 3/4. На фазе 0 — экспортируется и
  unit-тестируется на формат.

### 6.4 Онбординг (10 шагов)
Последовательность из §10. Реализация — через inline-кнопки Telegram HITL
(`choice`/`input.requested`). Шаги:
1. Приветствие («Начать»).
2. Базовый профиль: пол, дата рождения, рост, текущий вес.
3. Часовой пояс (auto-detect, дефолт `Europe/Moscow`, кнопки смены).
4. Цель (weight_loss/maintenance/muscle_gain; целевой вес; темп/дедлайн).
5. Уровень активности (sedentary/light/moderate/active) — для cold-start калоража.
6. Tone-пресет (4 кнопки).
7. Подключение часов (Android/iOS + выдача токена phone-hub) — **заглушка шага**:
   выдаётся токен, но ingestion ещё не работает (фаза 1). Юзер может нажать «Позже».
8. Подключение FatSecret — **заглушка**: кнопка «Пропустить пока», flow в фазе 2.
9. Напоминания (время утро/день/вечер, дни/время тренировок).
10. Готово → `users.onboarded_at = now()` + приветственное сообщение от агента.

> Шаги 7–8 на фазе 0 — упрощённые/заглушечные. Полные flow — в фазах 1 и 2.

### 6.5 `onboarding-guard` (`agent/hooks/onboarding-guard.ts`)
- На `turn.started`: если `users.onboarded_at IS NULL` и turn не в потоке онбординга —
  направить юзера в онбординг (как именно — по гайдам eve на `turn.started` hooks).

### 6.6 Tone-пресеты (`agent/lib/tone-presets.ts`)
- 4 пресета из §11.3: `supportive`, `sarcastic`, `strict`, `neutral`.
- `instructions/tone.ts` на `turn.started` читает `users.tone_preset` и подставляет
  соответствующий блок системного промпта. Язык — русский для всех пресетов.

### 6.7 БД-клиент
- `agent/lib/db/client.ts`: drizzle-клиент из `DATABASE_URL`. Singleton.
- `pgcrypto` расширение — в первой миграции.

---

## 7. Edge-cases и нюансы

- **Чужой chat_id при `/start`** — молча игнорировать, не сообщать об allowlist
  (§7.1, безопасность).
- **Смена tz юзером** (поездка) — записать новое значение; исторические агрегаты не
  пересчитываются; напоминания применяются к новому tz (§12.1). Проверка на фазе 0 —
  только запись, данных с часов ещё нет.
- **DST** — все «дни» считаются через UTC-диапазоны для tz; длительность сна — по
  абсолютным timestamp'ам, не по разнице локальных часов (§12.1).
- **Прерывание онбординга** (юзер закрыл чат на шаге 4) — `onboarded_at` остаётся null;
  guard направит обратно при следующем сообщении.
- **Модель и tone** — подтвердить, что `claude-sonnet-5` держит саркастичный/строгий
  tone на русском без сбоев (см. §20, откр. вопрос — отметить в STATUS.md).

---

## 8. Критерии готовности (Definition of Done)

- [ ] Vercel-скелет удалён; Telegram-канал + allowlist работают (`eve dev` + туннель).
- [ ] `docker compose up postgres` поднимает Postgres 16 с `pgcrypto`; `drizzle-kit
      migrate` проходит чисто; все таблицы из §5 созданы.
- [ ] `requireUser` и `userAuthFor` реализованы и unit-покрыты (форматы principal,
      отсутствие principal, неизвестный chat_id).
- [ ] Онбординг (10 шагов) проходит end-to-end для тестового chat_id; `onboarded_at`
      выставляется; `onboarding-guard` направляет неонборженного юзера.
- [ ] 4 tone-пресета реализованы; переключение через `set-tone` меняет вывод агента.
- [ ] `update-profile`, `set-goal`, `set-reminders`, `set-tz` — реализованы и пишут в БД.
- [ ] `.env.example`, `.gitignore`, `docker-compose.yml` — в репо, секреты не утекли.
- [ ] Юнит-тесты: `tenant.ts` (principal-форматы), tz-конверсия (локальный день ↔ UTC
      для tz, переход DST), `calories` BMR (если уже завели `calories.ts` — см. §18.1).
- [ ] Журнальная запись в [`../STATUS.md`](../STATUS.md) о завершении фазы 0.

---

## 9. Риски и проверяемые гипотезы

- **Allowlist vs BotFather.** BotFather не фильтрует писавших; чужие сообщения могут
  доходить. Allowlist — обязательный фильтр с релиза (§7.1). Проверить: `/start` от
  chat_id вне `ALLOWED_CHAT_IDS` игнорируется молча.
- **HITL-механика онбординга в eve** — на старте прочитать гайд eve про inline-кнопки,
  `choice`, `input.requested`, парковку turn'а между шагами. Если гайд расходится с
  спекой — флагни в STATUS.md.
- **`requireUser` vs `ctx.session.auth.current`** — свериться с eve-докой
  (`guides/auth-and-route-protection.md`, `patterns/multi-tenant-memory.md`) что
  principal действительно кладётся туда в актуальной версии eve ^0.31.

---

## 10. Ссылки на спецификацию

- §4 Структура проекта (eve).
- §5 Модель данных.
- §7 Каналы (Telegram + идентификация юзера).
- §8 Инструменты (update-profile, set-goal, set-tone, set-reminders, set-tz).
- §10 Онбординг.
- §11.3 Tone-пресеты.
- §12.1 Время и сон (DST, смена tz).
- §14 Инфраструктура (Postgres, миграции, env).
- §17 Локальная разработка (`eve dev`, туннель).
- §18.1 Юнит-тесты.
