# Health Agent — спецификация проекта

> Статус: черновик спецификации (без кода). Дата: 2026-08-11.
> Назначение: зафиксировать архитектуру, модель данных, интеграции, поведение и edge-cases
> до начала реализации. Код пишется после утверждения этого документа.

---

## 1. Обзор и цели

**Health Agent** — персональный Telegram-бот для трекинга здоровья на базе фреймворка **eve**
(Vercel). Аудитория: один автор + его семья (по одному профилю на человека, без шеринга данных
между собой).

### Что делает бот
- Собирает данные о сне, активности (включая шаги), пульсе и тренировках с носимых устройств
  (Amazfit, Huawei) через единый «phone-hub» путь.
- Логгирует питание (FatSecret, русская база продуктов) и считает калории/БЖУ.
- Хранит и обрабатывает данные в Postgres, анализирует тренды.
- Раз в неделю присылает отчёт с графиками и выводами агента.
- Ежедневно: напоминалки о внесении данных, напоминалки о тренировках, алерты об аномалиях
  (сон, перебор калорий).
- Строит и адаптирует тренировочную программу под цель (похудение/поддержание/набор).
- Помогает с целью по весу: считает целевые калории, предупреждает (вплоть до «ругани»,
  в зависимости от выбранного пресета тона).

### Что НЕ входит в первый релиз
- CMF by Nothing (нет ни агрегатора, ни API — отложен до отдельной фазы «мобильный мост»).
- Прямые вендор-API и платные агрегаторы (Terra/Spike — $399+/мес, отменены в пользу phone-hub).
- Исторический бэкфилл (бот начинает вести данные с момента подключения).
- Шеринг данных / общий leaderboard между членами семьи.

---

## 2. Архитектура (поток данных)

```
                          ┌─────────────────────────────────────┐
   Amazfit ─► Zepp app ──►│  Apple Health (iOS)                 │
   Huawei  ─► Huawei app ►│  / Health Connect (Android)         │
                          └──────────────┬──────────────────────┘
                                         │ (forwarder-приложение)
            ┌────────────────────────────┴───────────────────────────┐
            │  iOS:  Health Webhook (коммерч.) или мини-SwiftUI       │
            │  Android: mcnaveen/health-connect-webhook (AGPL, free) │
            └────────────────────────────┬───────────────────────────┘
                                         │ HTTP POST (webhook + токен)
                                         ▼
            ┌────────────────────────────────────────────────────────┐
            │  VPS  (eve start — долгоживущий Nitro/Node)             │
            │  ┌──────────────────────────────────────────────────┐  │
            │  │ agent/channels/phone-hub.ts  (defineChannel,     │  │
            │  │   POST /eve/v1/phone-hub)                        │  │
            │  │   → валидация токена → запись в БД (сырые сэмплы)│  │
            │  └──────────────────────────────────────────────────┘  │
            │  ┌───────────────────────┐  ┌────────────────────────┐ │
            │  │ agent/channels/       │  │ agent/connections/     │ │
            │  │   telegram.ts         │  │   fatsecret.ts (MCP)   │ │
            │  │   (двусторонний чат)  │  │   wger.ts (OpenAPI)    │ │
            │  └───────────────────────┘  └────────────────────────┘ │
            │  ┌───────────────────────┐  ┌────────────────────────┐ │
            │  │ agent/schedules/      │  │ agent/tools/           │ │
            │  │   weekly-report.ts    │  │   (манипуляция БД,     │ │
            │  │   daily-*.ts          │  │    цели, тренировки)   │ │
            │  └───────────────────────┘  └────────────────────────┘ │
            └────────────────────────────┬───────────────────────────┘
                                         ▼
                          ┌──────────────────────────────┐
                          │  Postgres 16 (локально на    │
                          │  том же VPS, Docker)         │
                          │  • users / profiles / goals  │
                          │  • raw_samples (30 дней)     │
                          │  • daily_aggregates (навсегда)│
                          │  • food_entries              │
                          │  • workouts / program        │
                          │  • settings                  │
                          └──────────────────────────────┘
```

### Ключевое архитектурное решение
Все данные с часов приходят **одним путём** — через phone-hub: вендор-приложение пишет в
Apple Health / Health Connect, отдельное forwarder-приложение читает и POSTит на наш webhook.
Это унифицирует ingestion для Amazfit и Huawei и не требует ни платных агрегаторов, ни
вендор-специфичных интеграций. Telegram-чат — отдельный канал (двусторонний диалог с агентом).

---

## 3. Стек технологий

| Компонент           | Выбор                                  | Обоснование                                            |
|---------------------|----------------------------------------|--------------------------------------------------------|
| Фреймворк агента    | **eve** ^0.31                          | Требование; встроенные Telegram, schedules, MCP        |
| Язык                | **TypeScript** (Node 24)               | Стандарт eve                                           |
| Канал пользователя  | **Telegram** (`eve/channels/telegram`) | Требование; inline-кнопки для HITL/онбординга          |
| Ingestion-канал     | **Custom channel** (`defineChannel`)   | Приём webhook'ов от phone-hub forwarder'ов             |
| БД                  | **Postgres 16** (локально на VPS)       | 0 внешних зависимостей, данные не покидают сервер (privacy), нет лимитов/пауз free-tier; см. §14 |
| ORM/миграции        | `drizzle-orm` + `drizzle-kit`           | Типобезопасные запросы + версионные миграции из коробки |
| Расширения Postgres | `pgcrypto` (`gen_random_uuid`)          | Без pgvector — семантический поиск в v1 не нужен |
| Питание             | **FatSecret** через MCP-мост           | Единственный с полноценной русской БД + дневник        |
| Штрихкоды (фолбэк)  | **Open Food Facts** REST               | Бесплатный русский подмножество                        |
| Упражнения          | **wger** REST API (без ключа)          | Структурированная база; LLM переводит на русский       |
| Графики             | **chartjs-node-canvas** (локально)     | Данные не покидают сервер                              |
| OAuth 1.0a signing  | `oauth-1.0a` (npm) или ручной HMAC-SHA1 | Подпись FatSecret-запросов к дневнику (~15 строк)      |
| Деплой              | **VPS** через `eve start`              | Требование; долгоживущий процесс, in-process cron      |
| Обратный прокси     | Caddy (auto-TLS)                       | terminate TLS для Telegram webhook + phone-hub         |
| Менеджер процесса   | systemd                                | Перезапуск, логи                                       |

---

## 4. Структура проекта (eve)

```text
health-agent/
├── package.json
├── tsconfig.json
├── .env.example                    # TELEGRAM_*, DATABASE_URL, FATSECRET_*, PHONE_HUB_TOKENS
├── .gitignore                      # .env, node_modules, build artefacts
├── AGENTS.md                       # (есть)
├── docs/
│   └── SPECIFICATION.md            # этот документ
├── agent/
│   ├── agent.ts                    # defineAgent: модель, limits, subagents?
│   ├── instructions.md             # базовый системный промпт
│   ├── instructions/               # динамические инструкции (пер-user контекст)
│   │   ├── user-context.ts         # на turn.started подгружает профиль+тренды юзера
│   │   └── tone.ts                 # на turn.started подставляет tone-пресет
│   ├── channels/
│   │   ├── telegram.ts             # telegramChannel({ botUsername })
│   │   └── phone-hub.ts            # defineChannel, POST-приёмник данных с часов
│   ├── tools/
│   │   ├── db/
│   │   │   ├── get-sleep.ts        # чтение сна за период
│   │   │   ├── get-activity.ts     # шаги/калории/HR за период
│   │   │   ├── get-workouts.ts
│   │   │   ├── get-food.ts         # food_entries за период + суммарные БЖУ/ккал
│   │   │   ├── get-calorie-balance.ts
│   │   │   └── add-manual-data.ts  # ручная фиксация сна/активности юзером
│   │   ├── goals/
│   │   │   ├── set-goal.ts         # цель по весу/темпу/дедлайну
│   │   │   ├── get-target-calories.ts  # гибридный расчёт (вариант C) + cold-start fallback
│   │   │   └── update-profile.ts   # вес/рост/возраст/пол/уровень активности
│   │   ├── training/
│   │   │   ├── build-program.ts    # построение плана (wger fetch + перевод на RU)
│   │   │   ├── reschedule.ts       # перенос/облегчение тренировки
│   │   │   └── log-workout.ts      # отметить выполненную
│   │   ├── settings/
│   │   │   ├── set-tone.ts         # смена tone-пресета
│   │   │   ├── set-reminders.ts    # время утро/день/вечер/треньки
│   │   │   ├── set-tz.ts
│   │   │   └── rotate-phone-hub-token.ts  # перевыпуск токена forwarder'а
│   │   ├── nutrition/
│   │   │   ├── log-food.ts         # прямой подписанный fetch к FatSecret (region=RU принудительно)
│   │   │   ├── lookup-barcode.ts   # Open Food Facts фолбэк
│   │   │   ├── connect-fatsecret.ts # запуск OAuth 1.0a 3-legged PIN-flow
│   │   │   └── complete-fatsecret.ts # обмен PIN на access-токен
│   │   ├── account/
│   │   │   └── delete-my-data.ts   # GDPR-style каскадное удаление
│   │   └── report/
│   │       └── render-chart.ts     # chartjs-node-canvas → PNG (для отправки в Telegram)
│   ├── schedules/
│   │   ├── weekly-report.ts        # раз в неделю: per-user user-auth сессия + анализ + график
│   │   ├── daily-morning.ts        # напоминалка утром (loop по users, fuzzy-окно)
│   │   ├── daily-midday.ts         # напоминалка днём
│   │   ├── daily-evening.ts        # напоминалка вечером
│   │   ├── workout-reminder.ts     # почасовой: сверка reminder_settings с локальным временем
│   │   ├── anomaly-check.ts        # каждые 30 мин: проверка порогов аномалий
│   │   ├── aggregate-raw.ts        # ежедневный: raw → daily_aggregates (cutoff-snapshot)
│   │   └── sync-fatsecret-diary.ts # ежедневный: food_entries.get_month → upsert food_entries
│   ├── hooks/
│   │   └── onboarding-guard.ts     # turn.started: если юзер не онборжен — направить на онбординг
│   └── lib/
│       ├── db/
│       │   ├── client.ts           # клиент Postgres (drizzle-orm)
│       │   └── schema.ts           # drizzle-схема всех таблиц (источник для миграций)
│       ├── tenant.ts               # ctx.session.auth.current → user_id (requireUser)
│       ├── user-auth.ts            # userAuthFor(user) — синтез principal для schedules
│       ├── fatsecret-oauth.ts      # OAuth 1.0a signing + PIN-flow helpers
│       ├── calories.ts             # BMR (Mifflin-St Jeor) + активность + cold-start fallback
│       ├── aggregates.ts           # логика схлопывания сырых → дневные
│       ├── dedup.ts                # дедупликация по типу метрики
│       ├── anomalies.ts            # пороги для алертов
│       └── tone-presets.ts         # 4 пресета системного промпта
└── evals/
    └── (позже: проверки корректности расчётов, тона, отчётов)
```

---

## 5. Модель данных (Postgres, локально)

Все таблицы изолированы по `user_id`. Timestamp'ы хранятся в **UTC**; per-user timezone
(`users.timezone`) применяется при выводе и в расчётах «дня». Сон относится к **дате пробуждения**.

### 5.1 Профили и настройки

```sql
users (
  id              uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint unique not null,       -- ключ из Telegram-канала
  timezone        text not null,                 -- напр. 'Europe/Moscow'
  tone_preset     text not null default 'supportive',  -- supportive|sarcastic|strict|neutral
  onboarded_at    timestamptz,                   -- null = онбординг не завершён
  blocked         boolean not null default false,-- true = юзер заблокировал бота (Telegram 403); schedules пропускают
  created_at      timestamptz not null default now()
)

profiles (
  user_id         uuid primary key references users(id),
  sex             text not null,                 -- 'male' | 'female'
  birth_date      date not null,
  height_cm       int not null,
  current_weight_kg numeric(5,2),                -- последнее измерение
  self_reported_activity_level text not null,    -- 'sedentary' | 'light' | 'moderate' | 'active'
                                                  -- спрашивается на онбординге; fallback для
                                                  -- расчёта калоража при <14 днях истории (§11.2)
  updated_at      timestamptz not null default now()
)

weight_log (                                     -- история взвешиваний (только вручную в v1)
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id),
  weight_kg       numeric(5,2) not null,
  measured_at     timestamptz not null,
  source          text not null default 'manual', -- 'manual' (умные весы — отдельной фазой)
  unique (user_id, measured_at)
)

phone_hub_tokens (                               -- токены webhook-приёмника
  token_hash      text primary key,              -- SHA-256(salt + token), salt в env
  user_id         uuid not null references users(id),
  device_label    text not null,                 -- 'amazfit', 'huawei' и т.д.
  platform        text not null,                 -- 'ios' | 'android'
  created_at      timestamptz not null default now(),
  rotated_from    text,                          -- token_hash предыдущего токена (при ротации)
  unique (user_id, platform, device_label)       -- один device_label на платформу на юзера
)
```

### 5.2 Цели

```sql
goals (
  user_id         uuid not null references users(id),
  kind            text not null,                 -- 'weight_loss' | 'maintenance' | 'muscle_gain'
  target_weight_kg numeric(5,2),                 -- для weight_loss / muscle_gain
  target_date     date,                          -- дедлайн (nullable)
  tempo_kg_per_week numeric(4,2),                -- либо темп, если без дедлайна
  calorie_source  text not null default 'hybrid',-- 'hybrid' (по боту) | 'device' | 'manual'
  manual_target_kcal int,                        -- если calorie_source='manual'
  created_at      timestamptz not null default now(),
  active          boolean not null default true
)
```

### 5.3 Данные с часов — двухуровневое хранение

> Политика: 30 дней храним детальные сэмплы, затем схлопываем в дневные агрегаты
> (см. schedule `aggregate-raw.ts`). Дневные агрегаты хранятся бесконечно.

```sql
raw_samples (                                    -- TTL 30 дней
  id              bigint generated always as identity primary key,
  user_id         uuid not null references users(id),
  metric          text not null,                 -- 'sleep_session' | 'steps' | 'heart_rate' |
                                                  --   'active_calories' | 'workout'
  recorded_at     timestamptz not null,          -- UTC, реальное время измерения
  payload         jsonb not null,                -- сырой payload от forwarder'а (нормализованный)
  received_at     timestamptz not null default now()
)
-- индексы: (user_id, metric, recorded_at), (received_at) для очистки

daily_aggregates (                               -- навсегда; одна строка на user×day×metric
  user_id         uuid not null references users(id),
  day             date not null,                 -- ЛОКАЛЬНАЯ дата юзера (по timezone)
  metric          text not null,                 -- 'sleep' | 'steps' | 'heart_rate' | 'activity' | 'workouts'
  value           jsonb not null,                -- агрегат (см. формат ниже)
  computed_at     timestamptz not null default now(),
  primary key (user_id, day, metric)
)
```

**Формат `value` для дневных агрегатов:**
- `sleep`: `{ total_minutes, bedtime_local, wake_local, efficiency_pct, deep_min, light_min, rem_min, awake_min, source }`
  — `bedtime_local`/`wake_local` — строки "HH:MM" в tz юзера; дата дня = **дата пробуждения**.
- `steps`: `{ total_steps, by_hour: [..24] }`
- `heart_rate`: `{ resting_bpm, avg_bpm, min_bpm, max_bpm }`
- `activity`: `{ active_calories_kcal, total_calories_kcal, active_minutes }`
- `workouts`: `{ count, items: [{ type, duration_min, calories_kgl, start_local }] }`

### 5.4 Питание

```sql
food_entries (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references users(id),
  external_id     text,                          -- FatSecret food_entry_id; для dedup при sync
  consumed_at     timestamptz not null,          -- локальное время приёма пищи → UTC
  day             date not null,                 -- локальный день юзера (для группировки)
  description     text not null,                 -- что съел (текст юзера / FatSecret-описание)
  food_id         text,                          -- FatSecret food_id
  servings        numeric(6,2),
  kcal            numeric(7,1) not null,
  protein_g       numeric(6,1),
  fat_g           numeric(6,1),
  carbs_g         numeric(6,1),
  source          text not null default 'fatsecret',  -- 'fatsecret' | 'manual' | 'barcode_off'
  created_at      timestamptz not null default now(),
  unique (user_id, external_id) where external_id is not null  -- один импорт на FatSecret-запись
)
-- индекс: (user_id, day)
```

> Дневник FatSecret остаётся источником правды при поиске продуктов; в нашу БД копируем
> посчитанные строки (для аналитики и независимости от лимитов FatSecret 5000/day).

### 5.5 Тренировки и программа

```sql
workout_programs (                                -- мета-версия программы
  user_id         uuid not null references users(id),
  version         int not null,
  goal_kind       text not null,
  frequency_per_week int not null,
  equipment       text[],                         -- ['home'] | ['gym'] | ['outdoor'] | combo
  session_duration_min int,
  constraints     text,                           -- травмы/ограничения (свободный текст)
  created_at      timestamptz not null default now(),
  active          boolean not null default true,
  primary key (user_id, version)
)

program_sessions (                                -- плоская разбивка активной программы на сессии
  id              bigint generated always as identity primary key,
  user_id         uuid not null references users(id),
  program_version int not null,
  day_of_week     smallint not null,              -- 0=вс ... 6=сб
  wger_exercise_id int not null,                  -- ссылка на wger exercise
  exercise_name_en text not null,                 -- кэш имени (wger отдаёт EN)
  sets            int,
  reps            text,                           -- '8-12' / '30s' и т.п.
  sort_order      int not null default 0,
  foreign key (user_id, program_version) references workout_programs(user_id, version)
)
-- индекс: (user_id, program_version, day_of_week, sort_order)

workout_logs (                                    -- выполнение (одна строка = одна сессия плана)
  id              bigint generated always as identity primary key,
  user_id         uuid not null references users(id),
  program_version int,
  scheduled_day   date,                           -- к какому дню плана относится
  performed_at    timestamptz,
  status          text not null,                  -- 'completed' | 'skipped' | 'rescheduled' | 'partial'
  notes           text,
  source          text not null default 'manual'  -- 'manual' (device_detected — отдельной фазой)
)
```

### 5.6 Напоминания

```sql
reminder_settings (
  user_id         uuid primary key references users(id),
  morning_local   time,                           -- время (в tz юзера) утренней напоминалки
  midday_local    time,
  evening_local   time,
  workout_times   jsonb                           -- [{day_of_week, local_time}] под программу;
                                                  -- day_of_week: 0=вс … 6=сб (как program_sessions §5.5);
                                                  -- local_time: "HH:MM" в tz юзера (как morning_local)
)
```

### 5.7 Учётные данные FatSecret (OAuth 1.0a per-user)

```sql
fatsecret_tokens (                                -- per-user access-токены FatSecret (OAuth 1.0a)
  user_id         uuid primary key references users(id),
  access_token    text not null,
  access_token_secret text not null,              -- OAuth 1.0a: token + secret
  connected_at    timestamptz not null default now(),
  revoked_at      timestamptz                     -- если юзер отвязал / пересвязал аккаунт
)
-- access-токен FatSecret бессрочный, refresh-flow отсутствует; при отзыве — перезапуск
-- 3-legged flow и замена строки.
```

> App-level OAuth 2.0 client-credentials токен (для публичного поиска продуктов) НЕ хранится
> в БД — живёт в памяти процесса с refresh за ~час до истечения (24ч TTL), ключи в env.

---

## 6. Интеграции

### 6.1 Носимые устройства — phone-hub

**Паттерн:** вендор-приложение (Zepp / Huawei Health) пишет данные в Apple Health (iOS) или
Health Connect (Android). Forwarder-приложение читает эти хранилища и POSTит на наш webhook.

**Forwarder'ы:**
- **Android:** `mcnaveen/health-connect-webhook` (AGPL-3.0, 139★, активно поддерживается;
  31 метрика: steps, HR, sleep, nutrition и т.д.; фон по WorkManager ≥15 мин). Бесплатно,
  turnkey. Health Connect — Android-only API, на iOS не существует.
- **iOS:** бесплатно + OSS + production-ready варианта **нет**. Реалистичные пути:
  1. **«Health Webhook» того же автора (MC Naveen), App Store — $14.99, closed-source.**
     Самый зрелый, feature-parity с Android-версией (steps, sleep, HR, workouts, retry,
     multi-webhook). Рекомендуемый путь для быстрого старта на iOS.
  2. **`iicodemai-wq/health-bridge-for-ha`** (MIT, Swift, 101 метрика, webhook-native) —
     бесплатно и OSS, но **новый репозиторий (0★, без App Store)** → self-build через Xcode
     + самостоятельная поддержка/тестирование. Рассмотреть, если $14.99 неприемлемо.
- В спеке зафиксирован **Android-first**: iOS-юзеры подключаются по пути (1) выше (платный
  app) либо (2) по запросу. В онбординге (§10) бот спрашивает платформу и выдаёт нужную инструкцию.

**Webhook-приёмник (`agent/channels/phone-hub.ts`):**
- Маршрут `POST /eve/v1/phone-hub` через `defineChannel({ routes: [POST(...)] })`.
- Заголовок `Authorization: Bearer <token>` → ищем `phone_hub_tokens.token_hash`.
- Тело: нормализованный payload `{ device_label, metric, recorded_at, payload }`.
- Логика: валидация → запись в `raw_samples`. Инкрементальный агрегат в webhook'е НЕ
  считается — агрегация идёт scheduled-джобом `aggregate-raw` (см. §12.3). Свежесть данных
  для алертов/сводок по текущему дню — из `raw_samples` напрямую (см. §12.3 «Свежесть для
  anomaly-check»). Никаких сообщений юзеру при нормальном потоке.
- Дедупликация по `(user_id, metric, recorded_at, payload-hash)` чтобы избежать дублей при
  ретраях forwarder'а.
- CORS не нужен (запросы от phone, не браузер).

**Onboarding устройства:** бот выдаёт юзеру уникальный токен + URL webhook'а; юзер вписывает
их в forwarder-приложение.

**Что НЕ делаем:** без агрегаторов (Terra/Spike — платные), без прямого вендор-API
(Huawei Health Kit REST бесплатен, но добавляет вторую точку ingestion; отложен —
phone-hub покрывает оба бренда единообразно). CMF — за рамками первого релиза.

### 6.2 Питание — FatSecret (русская база)

FatSecret использует **два разных OAuth** для разных классов операций:
- **OAuth 2.0 Client Credentials** — для публичного поиска продуктов (`foods.search`,
  `food.get`, `food.find_id_for_barcode`). App-scoped, один токен на приложение, без участия юзера.
- **OAuth 1.0a 3-legged** — для чтения/записи **дневника юзера** (`food_entry.*`,
  `food_entries.get_month`). Per-user, токен бессрочный, **refresh-flow отсутствует**
  (при отзыве юзером — перезапуск всего 3-legged flow).

> ⚠️ Архитектурное решение: **не использовать MCP-сервер `fliptheweb/fatsecret-mcp` как
> primary-путь.** Причины: (1) `defineInteractiveAuthorization` из eve рассчитан на
> OAuth2/PKCE с code-exchange и refresh, что не ложится на FatSecret OAuth 1.0a 3-legged
> (PIN/out-of-band, нет refresh); (2) контроль `region=RU` через LLM-инструкции хрупок
> (модель забывает прокинуть параметр); (3) stdio→HTTP-мост под systemd — лишний процесс.
> MCP-сервер оставлен как опция для быстрого старта на фазе 2 (только публичный поиск), но
> primary-путь — собственные tools с прямыми подписанными запросами.

**Архитектура FatSecret-интеграции:**

1. **Свой tool `log-food`** (`agent/tools/nutrition/log-food.ts`) с **прямым подписанным fetch**
   к FatSecret REST API:
   - **Поиск продуктов** — OAuth 2.0 client credentials (app-scoped, токен в env
     `FATSECRET_CLIENT_ID` / `FATSECRET_CLIENT_SECRET`, кэшируется до истечения 24ч).
     Принудительно `region=RU, language=ru, format=json` в каждом запросе.
   - **Запись в дневник** — OAuth 1.0a подписанный запрос с per-user access-токеном
     (из таблицы `fatsecret_tokens`, см. ниже). OAuth 1.0a signing — это ~15 строк
     (`oauth-1.0a` пакет или ручная подпись HMAC-SHA1).
   - После каждой успешной записи — копирование строки в нашу `food_entries` (для аналитики,
     независимости от лимитов 5000/day, и для работы schedules без user-principal — см. §9).
2. **Связка access-токена с юзером — таблица `fatsecret_tokens`** (см. §5.6).
3. **OAuth 1.0a 3-legged flow** через **свой route + HITL** (а НЕ `defineInteractiveAuthorization`):
   - Юзер жмёт «Подключить FatSecret» (inline-кнопка в Telegram).
   - Бот получает **request token** (signed POST к `oauth/request_token`), редиректит юзера
     на `oauth/authorize?oauth_token=...`. FatSecret показывает **PIN** (out-of-band flow).
   - Бот просит юзера ввести PIN через **`input.requested`** HITL (`ForceReply` в Telegram).
   - Получив PIN (= `oauth_verifier`), бот обменивает request token + verifier на access token
     (signed POST к `oauth/access_token`) и сохраняет в `fatsecret_tokens`.
   - Запаркованный turn возобновляется и подтверждает подключение.
   - `resume`-значение park-хука: `{ request_token, request_token_secret }` (НЕ PKCE verifier).
4. **Локаль `region=RU` гарантирована** на уровне tool'а (не на уровне LLM-инструкций):
   каждый fetch принудительно содержит эти параметры.

**Фолбэк штрихкодов:** Open Food Facts REST (`https://world.openfoodfacts.org/api/v2/product/<barcode>`,
русская подмножество ~35k продуктов) — отдельная tool `lookup-barcode`, вызывается если в
FatSecret по штрихкоду пусто.

**Синхронизация дневника (критично — см. §16, edge-case):** юзер может вносить еду напрямую
в FatSecret-приложении/сайте, минуя бота. Schedule `sync-fatsecret-diary` (раз в сутки)
читает `food_entries.get_month` по каждому онборженному юзеру и upsert'ит в нашу
`food_entries` по `external_id` (= FatSecret `food_entry_id`). Без этого калораж в отчётах врёт.

### 6.3 Упражнения — wger

- `https://wger.de/api/v2/` — бесплатный REST, без ключа, без auth (на чтение).
- Богатые эндпоинты: `/exerciseinfo/{id}/` (вложения: muscles, equipment, images, translations).
- **Русский ≈ 1%** покрытия → агент переводит английское имя+описание на русский на лету
  (LLM-перевод; для русской аудитории это надёжно). В `instructions` явно указать: при выдаче
  упражнения юзеру переводить название и описание.
- Подключение: **OpenAPI-коннекция** eve (`defineOpenAPIConnection`). Спецификация wger
  формально есть (drf-spectacular), но страница защищена anti-bot; на старте готовим локальный
  OpenAPI-документ руками по Read-the-Docs, либо оборачиваем нужные эндпоинты в свои tools
  (проще и контролируемее). Решение: **свои tools** (`build-program`, `log-workout`) с прямыми
  `fetch` к wger, без OpenAPI-коннекции — так чище для перевода и фильтрации.

---

## 7. Каналы

### 7.1 Telegram (`agent/channels/telegram.ts`)
- `telegramChannel({ botUsername })`.
- Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`.
- Регистрация webhook'а (`setWebhook`) вручную после деплоя.
- **Allowlist:** `ALLOWED_CHAT_IDS` в `.env` (через запятую) — обязательный фильтр с релиза.
  При `/start` бот сверяет `attributes.chat_id` со списком и молча игнорирует чужих.
  BotFather **не** фильтрует писавших; для health-данных доверять секретности `@username`
  недостаточно (боты сканятся BotFinder-сервисами). Список хранится только на VPS в env, в
  репо не попадает. Для family-of-2 — это 2 значения, 1 строка конфигурации.
- Inline-кнопки для онбординга, выбора tone-пресета, подтверждения тренировок, OAuth-ссылок.
- Проактивная отправка: `to(telegram, { chatId }).send(...)` из schedules.

### 7.2 Phone-hub webhook (`agent/channels/phone-hub.ts`)
- См. §6.1. Только приём данных, без диалога с юзером.

### Идентификация юзера (`agent/lib/tenant.ts`)
- **Telegram-канал:** eve сам формирует верифицированный user principal и кладёт его в
  `ctx.session.auth.current`:
  - приватный чат: `principalId = "telegram:" + from.id`, где `from.id === chat.id`;
  - `authenticator = "telegram-webhook"`, `principalType = "user"`;
  - `attributes = { chat_id, chat_type, message_id, user_id, username }`.
  (Источник: `node_modules/eve/dist/src/public/channels/telegram/defaults.js`,
  `defaultTelegramAuth`; доки `guides/auth-and-route-protection.md`, `patterns/multi-tenant-memory.md`.)
- `requireUser(ctx)` читает **`ctx.session.auth.current`** (а НЕ парсит continuation-токен):
  проверяет `principalType === "user"` и `authenticator === "telegram-webhook"`, достаёт
  `chat_id` из `attributes.chat_id` и находит `user_id` по `users.telegram_chat_id`. Бросает
  «authenticated user required», если principal отсутствует.
- **Phone-hub-канал:** идентификация по `Bearer`-токену forwarder'а → `phone_hub_tokens` → `user_id`.
  В route-хендлере формируется синтезированный principal для последующих tool-вызовов (см. §9).

---

## 8. Инструменты агента (`agent/tools/`)

Полный список инструментов, которые модель может вызывать. Все БД-операции строго
`requireUser(ctx)` — юзер никогда не передаётся моделью.

| Tool                     | Назначение                                                     |
|--------------------------|----------------------------------------------------------------|
| `get-sleep`              | Сон за период (из daily_aggregates, фолбэк на raw за последние дни) |
| `get-activity`           | Шаги/калории/HR за период                                      |
| `get-workouts`           | Тренировки за период (из БД + логов)                           |
| `get-food`               | Пищевые записи за период, суммарные БЖУ/ккал                   |
| `get-calorie-balance`    | Потреблено vs цель/расход за период                            |
| `add-manual-data`        | Ручная фиксация сна/активности («спал 6ч, лёг 00:30, встал 06:30») |
| `log-food`               | Прямой подписанный fetch к FatSecret (`region=RU` принудительно) → food_entries |
| `lookup-barcode`         | Open Food Facts фолбэк                                          |
| `connect-fatsecret`      | Запуск OAuth 1.0a 3-legged PIN-flow                            |
| `complete-fatsecret`     | Обмен PIN на access-токен (финал PIN-flow)                     |
| `set-goal`               | Цель по весу/темпу/дедлайну                                    |
| `get-target-calories`    | Гибридный расчёт нормы (вариант C) + cold-start fallback        |
| `update-profile`         | Вес/рост/возраст/пол/уровень активности                        |
| `build-program`          | Построение тренировочного плана (wger fetch + перевод на RU)   |
| `reschedule`             | Перенос/облегчение тренировки                                  |
| `log-workout`            | Отметить выполнение (completed/skipped/partial)               |
| `set-tone`               | Смена tone-пресета                                             |
| `set-reminders`          | Время напоминалок                                              |
| `set-tz`                 | Часовой пояс                                                   |
| `rotate-phone-hub-token` | Перевыпуск токена forwarder'а (замена телефона)                |
| `delete-my-data`         | Каскадное удаление данных юзера + отзыв FatSecret-токена       |
| `render-chart`           | Сборка PNG-графика (chartjs-node-canvas) для отправки          |

> Все FatSecret-операции — через собственные tools с прямыми подписанными fetch'ами
> (OAuth 2.0 client-credentials для поиска, OAuth 1.0a для дневника), НЕ через MCP-connection.
> Это гарантирует `region=RU` на уровне кода и убирает зависимость от stdio→HTTP-моста.

---

## 9. Проактивные сообщения (`agent/schedules/`)

### Принцип: schedule ≠ user principal

**Критичный архитектурный момент.** Schedules в eve запускаются от `appAuth`
(`principalType: "runtime"`, `principalId: "eve:app"`) — это НЕ пользовательский principal.
Любой tool с `requireUser(ctx)` (чтение `ctx.session.auth.current`) упадёт с
`principal_required`/кастомной ошибкой. Поэтому **все per-user сообщения** (отчёт,
напоминалки, алерты) отправляются через единый dispatcher, который для каждого юзера
**синтезирует user-auth** и шлёт отдельную proactive-сессию.

Синтезированный auth (паттерн из `patterns/dynamic-scheduling.md`):
```ts
function userAuthFor(u: { telegram_chat_id: bigint; user_id: string }) {
  return {
    authenticator: "telegram-webhook",
    principalId: `telegram:${u.telegram_chat_id}`,
    principalType: "user" as const,
    attributes: {
      chat_id: String(u.telegram_chat_id),
      user_id: u.user_id,
    },
  };
}
// dispatcher:
for (const u of onboardedUsers()) {
  waitUntil(
    to(telegram, { chatId: String(u.telegram_chat_id) }).send(prompt, {
      auth: userAuthFor(u),
    }),
  );
}
```
Внутри такой сессии `requireUser(ctx)` отработает корректно — `principalType: "user"` и
`attributes.user_id` на месте.

> Важное следствие: данные для отчётов/напоминалок бот читает из **нашей БД**
> (`daily_aggregates`, `food_entries`, копии логов тренировок), а НЕ дёргает FatSecret
> user-connection в фоне — именно поэтому мы копируем food_entries и тренировки в свои таблицы.
> FatSecret user-API дёргается только в интерактивных tool'ах (`log-food`).

### Расписание schedules

Для family-of-2 (2 юзера) полный dynamic-scheduling (schedule-store с `nextRunAt`/lease) —
избыточен. На v1 — **статичные cron'ы + loop по `users`** с синтезированным auth.

| Schedule              | Cron              | Что делает                                              |
|-----------------------|-------------------|---------------------------------------------------------|
| `weekly-report`       | `0 10 * * 1`      | По каждому онборженному юзеру: сессия с user-auth → анализ недели → текст + PNG-график |
| `daily-morning`       | `0 * * * *` (UTC) | Почасовой джоб: для каждого онборженного юзера — fuzzy-сверка morning slot (см. ниже) → напоминалка «внести ужин/взвеситься» |
| `daily-midday`        | `0 * * * *`       | Аналогично для midday slot                              |
| `daily-evening`       | `0 * * * *`       | Аналогично для evening slot (итог дня по калориям/шагам)|
| `workout-reminder`    | `0 * * * *`       | Почасовой джоб: для каждого онборженного юзера сверяет `reminder_settings.workout_times` с текущим локальным временем (fuzzy) → напоминалка о тренировке |
| `anomaly-check`       | `*/30 * * * *`    | Для каждого онборженного юзера: проверка порогов аномалий → алерт   |
| `aggregate-raw`       | `0 3 * * *`       | Сырые сэмплы → daily_aggregates (см. §12.3, edge-cases) |
| `sync-fatsecret-diary`| `0 4 * * *`       | Чтение дневника FatSecret (`food_entries.get_month`) → upsert в `food_entries` по `external_id` |

> **Почему daily-джобы ходят каждый час, а не раз в сутки.** Разовый тик в фиксированный
> UTC-час не покрывает слоты юзеров в разных tz (напр. morning 08:00 Europe/Moscow = 05:00 UTC
> никогда не совпадёт с тиком 07:00 UTC). Поэтому daily-{morning,midday,evening} тикают
> каждый час и применяют fuzzy-сверку по локальному времени юзера (см. ниже). Для family-of-2
> это 24 тика/сутки × 3 джоба = копейки нагрузки; при росте аудитории — перейти на
> динамический schedule-store (`patterns/dynamic-scheduling.md`, §20.5).

**Окно совпадения времени (fuzzy, симметричное):** daily-напоминалки и workout-reminder при
каждом тике (UTC) для каждого онборженного юзера:
1. Вычисляют локальное время юзера `LT = now() AT TIME ZONE users.timezone` (с днём недели и
   локальной датой).
2. Сравнивают со слотом по модулю суток: срабатывают, если `min(|LT − slot|, 24h − |LT − slot|) ≤ δ`,
   где `δ = 30 мин` на v1. Симметричное окно `[slot − δ, slot + δ)` гарантирует, что слот
   срабатывает **до ±30 мин**, а не «после тика с опозданием».
3. **Dedup (обязателен):** хранят «дату+kind последнего срабатывания» (напр. в памяти процесса
   `(user_id, kind, local_date)` для daily-джобов; `(user_id, program_version, scheduled_local_date)`
   для workout-reminder) и не шлют повторно в ту же локальную дату. При рестарте процесса
   счётчик теряется — допустимо получить второй алерт в день рестарта (лучше_than_пропуск).

При `δ = 30 мин` и тике каждый час (минута 0) соседние окна `[HH:00 − 30, HH:00 + 30]`
стыкуются ровно в `HH:30` — покрытие 100%, дублей нет (с учётом dedup). Альтернатива для
минутной точности — динамический schedule-store (§20.5) при масштабировании.

> Данные FatSecret в `sync-fatsecret-diary`: schedule ходит от `appAuth`, но подписанный
> OAuth 1.0a-запрос к `food_entries.get_month` использует per-user access-токен из таблицы
> `fatsecret_tokens` (app-level fetch, не через user-connection eve) — поэтому principal не нужен.

---

## 10. Онбординг

Последовательность при первом `/start` (inline-кнопки через Telegram HITL):

1. **Приветствие** — кратко, что умеет бот. Кнопка «Начать».
2. **Базовый профиль** (inline-выбор + ввод):
   - пол, дата рождения, рост, текущий вес.
3. **Часовой пояс** — auto-detect по языку/дефолт Europe/Moscow, кнопки смены.
4. **Цель** — weight_loss / maintenance / muscle_gain; целевой вес; темп или дедлайн.
5. **Уровень активности** — self_reported_activity_level (sedentary / light / moderate /
   active) — нужен как fallback для расчёта калоража на старте (см. §11.2). 4 inline-кнопки
   с описанием каждого уровня.
6. **Tone-пресет** — 4 кнопки с описанием (см. §11.3).
7. **Подключение часов** — выбор платформы (Android/iOS), инструкция + генерация токена
   phone-hub:
   - Android: «Установи mcnaveen/health-connect-webhook, впиши URL и токен».
   - iOS: «Купи/установи Health Webhook ($14.99) либо собери из open-source, впиши URL и
     токен». Кнопка «Готово» / «Позже».
8. **Подключение FatSecret** — кнопка запускает OAuth 1.0a 3-legged flow (PIN-шаг, см. §6.2).
9. **Напоминания** — время утро/день/вечер (дефолты), дни/время тренировок.
10. **Готово** — `users.onboarded_at = now()`. Первое приветственное сообщение от агента.

**Onboarding-guard (`hooks/onboarding-guard.ts`):** на `turn.started`, если юзер не онборжен
и не находится в потоке онбординга — направить его туда.

---

## 11. Логика агента

### 11.1 Недельный отчёт
- Сбор данных за последние 7 завершённых локальных дней по `daily_aggregates`.
- Если данных < N из 7 дней (порог ниже — отчёт всё равно строится, но с пометкой о неполноте;
  по умолчанию N=4) — отчёт генерируется, но содержит явное «нет данных за X дней».
- **Содержание:** сводка трендов (сон: средняя длительность, тренд vs предыдущая неделя;
  шаги: среднее; вес: дельта; калории: средний баланс vs цель; тренировки: выполнено/пропущено).
- **Выводы и советы** — анализ агентом (LLM) на основе трендов и цели.
- **График:** один-два PNG (напр. сон по дням + тренд веса) через `render-chart` → `sendPhoto`.
- Формат: **тренды + выводы**, без разбора каждого дня по отдельности.

### 11.2 Расчёт калорий (гибрид, вариант C)
- **BMR:** Mifflin-St Jeor (пол/возраст/рост/вес из профиля).
- **Активность (независимая оценка):** фактор активности выводится из средней активности за
  последние 14 дней (шаги + active_minutes + HR-паттерн). TDEE_бот = BMR × фактор.
- **Cold-start fallback (критично):** при **<14 днях** истории (новый юзер) фактор активности
  берётся из `profiles.self_reported_activity_level` (запрашивается на онбординге: sedentary
  1.2 / light 1.375 / moderate 1.55 / active 1.725). Как только накапливается ≥14 дней реальных
  данных — переключаемся на вычисленный фактор, юзеру приходит уведомление «теперь считаю
  калории по твоим реальным данным».
- **TDEE_по_часам:** BMR + active_calories из часов за те же 14 дней (для справки).
- **Целевой калораж** = TDEE_бот ± дефицит/профицит под цель (`goals.tempo_kg_per_week` →
  ~7700 ккал/кг жира).
- **Юзеру показываются оба числа** («по боту» — для расчёта; «по часам» — для справки).
- **Поведение при систематическом расхождении:** если фактический калораж за неделю
  расходится с целью в «плохую» сторону — бот предупреждает (тон зависит от пресета),
  корректирует рекомендации, не меняет цель молча.

### 11.3 Tone-пресеты (`agent/lib/tone-presets.ts`)
Выбирается при онбординге, меняется через `set-tone`. Одинаковый набор из 4 для всех юзеров.

| Пресет        | Идентификатор   | Стиль                                                  |
|---------------|-----------------|--------------------------------------------------------|
| Поддерживающий| `supportive`    | Мягкий, подбадривает («небольшой перебор, завтра выровняем») |
| Саркастичный  | `sarcastic`     | Подкалывает, прямолинейный (ближе к «жрешь слишком много») |
| Строгий тренер| `strict`        | Требовательный, по делу, без подколок, жёстко          |
| Нейтральный   | `neutral`       | Только факты и рекомендации, без эмоций                |

Реализуется как динамическая инструкция на `turn.started`: подставляет соответствующий
блок в системный промпт. Язык — русский для всех пресетов.

### 11.4 Тренировочная программа
- **Вход:** цель, частота/нед, длительность сессии, оборудование (дом/зал/улица), ограничения,
  история активности (из часов за N недель).
- **Источник упражнений:** wger (структура: мышцы, оборудование, картинки); имена/описания
  переводятся агентом на русский.
- **План:** недельная структура (дни → упражнения → подходы/повторы). Мета-версия программы —
  в `workout_programs` (см. §5.5), плоская разбивка на сессии — в `program_sessions`
  (по дням недели). **Колонки `workout_programs.plan` не существует** (план = совокупность
  строк `program_sessions` для данного `program_version`). Новая версия = новая строка в
  `workout_programs` + новый набор строк `program_sessions`, прежняя версия → `active=false`.
- **Адаптация программы (триггер):** адаптация проактивная и должна быть **явно
  запланирована** — без schedule/хука она не запустится. На v1:
  - **Триггер `program-check`** — ежедневный schedule (cron `0 5 * * *`, идёт в общем
    dispatcher'е с `userAuthFor`, как остальные schedules §9): для каждого онборженного
    юзера с активной программой проверяет `workout_logs` — есть ли запланированные на
    прошедшие дни сессии без лога (`status IS NULL`), либо со `status='skipped'/'partial'`,
    либо с накопленным отставанием (≥2 пропуска за последние 7 дней).
  - При срабатывании — proactive-сессия с user-auth: агент решает (перенести / облегчить /
    пересобрать новую `version`) на основе логов и цели, и вызывает `reschedule` (§8).
  - Альтернатива/дополнение: блок «как идёт программа» в недельном отчёте (фаза 3) с
    рекомендацией адаптации.
  - anomaly-check (§11.5) адаптацию программы **не** покрывает (там сон/калории/шаги/вес).
- **Напоминания:** per-user cron через dispatcher (см. §9); `reminder_settings.workout_times`
  наполняется `build-program` (с подтверждением юзера — см. ниже) и обновляется `reschedule`
  при переносе.

### 11.5 Детектор аномалий (`agent/lib/anomalies.ts`)
Проверяется каждые 30 мин, алерт шлётся при срабатывании (с rate-limit: не чаще 1 алерта
типа на юзер×день, чтобы не спамить). Тон алерта — по пресету юзера.

**Источники данных** (фиксация — см. также §12.3 «Свежесть для anomaly-check»):
- **Текущий день (сон за прошлую ночь, шаги/активность/калории «сегодня»):** `raw_samples`,
  отфильтрованные по локальному дню юзера (`users.timezone`). Агрегат текущего дня НЕ
  существует (см. §12.3).
- **Завершённые дни (базовая линия, скользящие средние):** `daily_aggregates`.
- **Вес:** `weight_log` (только manual на v1). `daily_aggregates` метрики веса не содержит.
- **Цель по калориям:** `lib/calories.ts` (фаза 2), НЕ LLM-tools (tools вызывает модель,
  anomaly-check — чистый код).

**Пороги (дефолты; настраиваются в коде; для всех — guard на минимальное число измерений):**
- **Сон:** длительность < 5ч **или** `bedtime_local > "02:00"`. Считается по завершённой
  сессии за прошлую ночь (`wake_at` есть). Source: `raw_samples` metric=`sleep_session`.
  Guard: срабатывает только если есть валидная сессия (не алертим «нет данных» — это §12.2).
- **Калории:** `sum(food_entries.kcal, day=today_local) > target_kcal × 1.25` **и** текущий
  локальный день ещё не окончен (время < конца суток в tz юзера). `target_kcal` — из
  `lib/calories.ts` (`get-target-calories`, «по боту»). Source: `food_entries`.
- **Активность:** шаги сегодня (`raw_samples`, metric=`steps`, sum по buckets за текущий
  локальный день) **< 50%** от медианы шагов за последние 7 завершённых локальных дней
  (по доступным дням, медиана по `daily_aggregates`). Guard: алерт только после 18:00
  локального времени (день в основном прожит) и при наличии ≥3 дней в базовой линии.
- **Вес:** `|weight_now − prev| / prev > 2.5%` (или `|delta| > 1 кг` при малом весе),
  где `weight_now` — последнее взвешивание сегодня/вчера, `prev` — медиана последних 7
  измерений (или хотя бы 3, иначе алерт не срабатывает). Source: `weight_log`. Guard: ≥3
  измерений за последние 30 дней. Информационно, не тревожно.
- **Rate-limit:** не чаще 1 алерта типа на `(user_id, type, local_date)`. Счётчик — в памяти
  процесса (см. §9 fuzzy dedup); при рестарте обнуляется (допустим редкий повторный алерт в
  день рестарта — лучше, чем пропуск). При масштабировании (>~10 юзеров) — таблица.

---

## 12. Edge-cases и политика данных

### 12.1 Время и сон
- Сон через полночь (лёг 23:30 → встал 07:00) относится к **дате пробуждения**.
- Переход на летнее/зимнее время: всё хранится в UTC, tz применяется при выводе; длительность
  сна считается по абсолютным timestamp'ам (не по разнице локальных часов).
- Все «дни» в отчётах и агрегатах — локальные дни юзера (`users.timezone`).
- **Смена tz юзером (поездка):** tz — текущее значение; **исторические агрегаты не
  пересчитываются** (зафиксированы на tz дня измерения). При смене tz бот уведомляет: «данные
  за переходный день могут быть дробными». Напоминания (`reminder_settings`) хранятся в local
  time и применяются к новому tz без изменений.

### 12.2 Пропуски данных
- Если за день нет данных с часов — в отчёте/анализе день помечается «нет данных».
- Юзер может зафиксировать вручную через `add-manual-data` («спал 6ч, лёг 00:30, встал 06:30»);
  manual-запись имеет приоритет при отсутствии автоматических.
- Для трендов используются медианы по доступным дням (не выбрасываются).
- **Поздние сэмплы после офлайна телефона:** forwarder шлёт ≥15 мин, но батчи могут прийти с
  `recorded_at` глубоко в прошлом. Все поздние сэмплы попадают в `raw_samples` и подхватываются
  следующим запуском `aggregate-raw` (cutoff считается по `recorded_at`, см. 12.3).

### 12.3 Хранение и агрегация (без race-condition; свежие дни доступны сразу)
- **Сырые сэмплы (`raw_samples`):** TTL 30 дней. `daily_aggregates` наполняется ежедневно
  (включая вчерашний/текущий день), а сырые сэмплы старше 30 дней удаляются. Агрегация и
  удаление — **разные шаги** (см. алгоритм ниже): cutoff используется только для удаления,
  а в агрегацию попадают все завершённые локальные дни.
- **Алгоритм `aggregate-raw` (без потерь при гонках, со свежими днями):**
  1. На старте джоба фиксируется snapshot-момент `now0 = now()`.
  2. **Агрегация:** для каждого онборженного юзера, для каждого `(user_id, day, metric)`,
     где `day` — локальный день юзера (`users.timezone`), **полностью завершённый** к
     `now0` (т.е. `day < local_date(now0, tz)`; текущий локальный день НЕ агрегируется —
     он ещё идёт, кроме сна, см. ниже), и для которого есть сырые сэмплы — вычислить агрегат
     и **upsert** в `daily_aggregates`. Перебираются **все** завершённые дни с имеющимися
     сырыми сэмплами (不限 30 дней), чтобы (а) держать `daily_aggregates` свежим (вчерашний
     день) и (б) перевычислять агрегаты при поздних сэмплах (см. ниже).
     - **Сон — особый случай:** сон завершается в момент пробуждения, поэтому сессия,
       начатая вчера и завершённая сегодня, относится к `day = local_date(wake_at, tz)`
       и агрегируется, только если `wake_at < now0` (т.е. юзер уже проснулся). Незавершённая
       сессия (нет `wake_at`) ждёт следующего прогона.
     - **Оптимизация (необязательно, если(rawSamples за 30 дней ≤ N)):** повторно
       агрегировать только дни, у которых есть сэмплы, пришедшие после `computed_at`
       существующего агрегата (или агрегата ещё нет) — чтобы не перевычислять stable-дни.
  3. **Удаление сырых (отдельный шаг, после агрегации):** `cutoff = now0 - interval '30 days'`;
     удалить сэмплы с `received_at < cutoff` (по snapshot `now0`). Используем `received_at`
     (время приёма), а не `recorded_at` (время измерения) — поздние сэмплы могут иметь
     `recorded_at` глубоко в прошлом, но удаляются по возрасту приёма, чтобы успеть попасть
     в агрегацию. Новые сэмплы, пришедшие во время джоба, останутся → следующий прогон.
  4. **Гранулярность транзакции:** per `(user_id, day, metric)` — сбой одного дня не роняет
     весь джоб. Агрегация и удаление — в разных транзакциях (сбой удаления не отменяет
     агрегацию и наоборот).
- **upsert агрегата при поздних сэмплах:** если поздний сэмпл (напр. 35-дневной давности,
  пришедший после офлайна) относится к дню, уже агрегированному — шаг 2 перевычислит агрегат
  (upsert, `computed_at = now`), а шаг 3 удалит этот сэмпл, когда его `received_at` уйдёт за
  cutoff. Исторический агрегат обновляется. (Корректность данных приоритетнее «стабильности»
  исторических значений — см. §12.2 «поздние сэмплы».)
- **Свежесть для anomaly-check / evening-сводки (фаза 4):** `daily_aggregates` всегда
  содержит завершённые дни до вчерашнего включительно; текущий день НЕ агрегирован. Для
  алертов по «сегодня» (калории, шаги, активность) и вечерней сводки источник —
  **`raw_samples`** текущего локального дня (фильтр по tz юзера), а не `daily_aggregates`.
  Сон за прошлую ночь читается из `raw_samples` (или из `daily_aggregates`, если `aggregate-raw`
  уже успел прогнать этот день). Это явно зафиксировано, чтобы не полагаться на агрегат
  текущего дня, которого нет.
- **Дневные агрегаты, профиль, питание, тренировки, цели:** хранятся бессрочно.
- **Удаление по запросу:** tool `delete-my-data` (см. §13).

### 12.4 Дедупликация phone-hub payload (по типу метрики)
Разные метрики шлются по-разному, поэтому и дедупликация разная:
- **`sleep_session`:** дедупликация по `(user_id, metric, recorded_at)` с **upsert** — одна и
  та же ночь приходит несколько раз с уточнёнными границами, последняя версия выигрывает.
- **Потоковые bucket-метрики (`steps` почасово, `heart_rate` минутно):** дедупликация по
  `(user_id, metric, recorded_at, payload.bucket)` — каждый bucket уникален.
- **`workout`:** по `(user_id, metric, recorded_at)` + upsert.
- payload-hash как дополнительная защита от точных дублей ретраев forwarder'а.

### 12.5 Ротация токена forwarder'а (замена телефона / переустановка)
- Tool `rotate-phone-hub-token`: инвалидизирует старый токен (удаляет `phone_hub_tokens`
  запись, `rotated_from` = старый hash), генерирует новый, выдаёт юзеру URL+токен.
- POST'ы со старым токеном → 401 (forwarder увидит и перестанет слать после истощения ретраев).
- При нескольких устройствах одного бренда у одного юзера — каждое со своим `platform`+`device_label`
  (PK `phone_hub_tokens` это допускает, см. §5.1).

### 12.6 Изоляция
- Каждый юзер видит **только свои** данные. `requireUser(ctx)` обязательно во всех БД-tools.
  `user_id` — из сессии, никогда из ввода модели.

### 12.7 Шаги
- Включены в активность как отдельная метрика (`steps`), с почасовой разбивкой и дневной суммой.

---

## 13. Безопасность

- **Секреты:** только в `.env` на VPS (`TELEGRAM_*`, `DATABASE_URL`, `FATSECRET_*`,
  `PHONE_HUB_TOKEN_SALT`, `ALLOWED_CHAT_IDS`). В репозитории — только `.env.example`.
- **Phone-hub webhook:** авторизация по `Bearer`-токену. Токен хранится как
  `SHA-256(PHONE_HUB_TOKEN_SALT + token)`; проверка — **constant-time compare**.
  Дедупликация (см. §6.1, §12), валидация payload по zod-схеме, лимит размера тела (напр. 1 MB).
- **FatSecret OAuth 1.0a:** per-user access-токен + secret в таблице `fatsecret_tokens`.
  Токен **бессрочный, refresh-flow отсутствует** — при отзыве юзером перезапускается весь
  3-legged flow (см. §6.2). App-level client-credentials токен (публичный поиск) — в памяти
  процесса, ключи в env.
- **Allowlist Telegram:** `ALLOWED_CHAT_IDS` — обязательный фильтр с релиза (см. §7.1).
- **HTTPS:** Caddy terminate TLS; Telegram и phone-hub ходят только по https.
- **Модель:** никогда не получает токены соединений (eve держит их вне контекста модели).
  OAuth-токены FatSecret читаются tool'ом `log-food` напрямую из БД, в контекст LLM не попадают.
- **Данные питания/здоровья** в графике рендерятся локально (`chartjs-node-canvas`) —
  наружу не уходят.
- **Postgres:** слушает только `127.0.0.1`, порт не выставлен наружу; пароль в env.
- **GDPR-style удаление:** tool `delete-my-data` — каскадное удаление всех таблиц по `user_id`
  + отзыв FatSecret-токена. Контракт: подтверждение через inline-кнопку, удаляет
  users/profiles/goals/raw_samples/daily_aggregates/food_entries/program/logs/tokens,
  Telegram-сообщения уже ушедшие не возвращаются.

---

## 14. Инфраструктура и деплой (VPS)

- **Runtime:** Node 24 + `eve start` (долгоживущий процесс; in-process cron Nitro).
- **Менеджер:** systemd unit (`health-agent.service`): `Restart=always`, журналирование в journald.
- **Reverse proxy:** Caddy — auto-TLS (Let's Encrypt), раздаёт:
  - `POST /eve/v1/telegram` → бот
  - `POST /eve/v1/phone-hub` → ingestion
  - `GET /healthz` → healthcheck.
- **БД — Postgres 16 в Docker Compose** на том же VPS:
  - Слушает только `127.0.0.1:5432`, наружу не выставлен.
  - Named volume `pgdata` для персистентности; пароль в env `DATABASE_URL`.
  - Расширение `pgcrypto` (`CREATE EXTENSION pgcrypto;` для `gen_random_uuid`).
  - Без pgvector — в v1 семантический поиск не нужен.
  - 0 внешних зависимостей, 0 лимитов/пауз, данные не покидают сервер (privacy).
- **Миграции БД — `drizzle-kit`:** схема в `agent/lib/db/schema.ts` (TypeScript),
  миграции генерируются `drizzle-kit generate` и хранятся в `drizzle/`. Применяются при
  деплое через `drizzle-kit migrate` (или эквивалент в startup-хук'е).
- **Бэкап:** ежедневный `pg_dump` (cron на хосте или в отдельном контейнере) →
  `pgdata-backups/YYYY-MM-DD.sql.gz`, с ротацией (хранить последние 30 + первые числа
  каждого месяца). Копию offsite (напр. rsync в object storage или на другой хост) — на фазе 6.
- **MCP-мост FatSecret — НЕ нужен** (отказались от MCP-сервера как primary-пути, см. §6.2;
  прямые подписанные fetch'и из tool'а `log-food`).
- **Регистрация webhook'ов:** после деплоя — `setWebhook` для Telegram (curl, см. доку eve).
- **Мониторинг:** journald + `/healthz` (проверяет БД-соединение). Алерты — вручную на старте,
  структурное логирование — см. §15.

### Переменные окружения (`.env.example`)
```
# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET_TOKEN=
ALLOWED_CHAT_IDS=           # через запятую: 123456789,987654321
# БД (локальный Postgres в Docker)
DATABASE_URL=postgres://health:PASSWORD@127.0.0.1:5432/health
POSTGRES_PASSWORD=          # для контейнера
# FatSecret
FATSECRET_CLIENT_ID=
FATSECRET_CLIENT_SECRET=
# Phone-hub
PHONE_HUB_TOKEN_SALT=       # для хэширования токенов forwarder'ов
# Модель
MODEL_API_KEY=
```

---

## 15. Observability и логирование

- **Структурные логи (JSON)** в journald — структурированные поля, не plain text. Каждый
  log-entry содержит: `timestamp`, `level`, `component` (`ingestion` | `auth` | `tool` |
  `schedule` | `oauth`), `user_id` (где применимо), `event`, `message`, контекстные поля.
- Смотреть `guides/instrumentation.md` из eve для хуков инструментирования.
- **Логируемые события (минимум):**
  - Ingestion: phone-hub POST (metric, user_id, dedup-hit/miss), ошибка валидации payload.
  - Auth: OAuth FatSecret — старт flow, успех, отказ, истечение/отзыв токена.
  - Tool: имя, user_id, длительность, успех/ошибка (без аргументов — приватность).
  - Schedule: старт, завершение, кол-во обработанных юзеров, длительность.
- **Уровни:** `info` — нормальный поток (включая дубли forwarder'а — это норма, не warn);
  `warn` — ретраи, деградация (FatSecret 429, Telegram 429); `error` — провал операции.
- **Метрики (минимум, как счётчики в логах или простой `/metrics`-эндпоинт позже):**
  кол-во POSTов phone-hub за час, latency FatSecret-запросов, кол-во failed OAuth,
  кол-во обработанных daily-агрегатов. На v1 — достаточно логов, отдельный metrics-бэкенд
  избыточен для family-of-2.

---

## 16. Обработка ошибок по компонентам

| Компонент | Сбой | Поведение |
|-----------|------|-----------|
| Phone-hub webhook | Невалидный payload (zod-fail) | 400 + warn-лог; forwarder перестанет ретраить конкретный payload. Лимит тела 1 MB → 413. |
| Phone-hub webhook | Неизвестный токен | 401; forwarder истощит ретраи. |
| Phone-hub webhook | Ошибка БД при insert | 500 + error-лог; forwarder ретраит (это ок — дедупликация отловит дубль). |
| Tool `log-food` | FatSecret 429 (лимит 5000/day) | Tool возвращает юзеру дружелюбное «сервис питания перегружен, попробуй через минуту»; warn-лог. |
| Tool `log-food` | FatSecret 401 (токен отозван) | Иницировать перезапуск OAuth 1.0a flow (§6.2); уведомить юзера «нужно переподключить FatSecret». |
| Tool `log-food` | Сеть/FatSecret даун | Retry с экспоненциальным backoff (2-3 попытки); при провале — юзер-friendly сообщение. |
| Schedules | БД timeout | Retry на следующем тике cron; warn-лог. Не ронять весь процесс. |
| Schedules | Ошибка в одном user-loop | Изолировать: один сбойный юзер не роняет обработку остальных (try/catch per-user). |
| Telegram sendMessage | 429 (rate limit) | Экспоненциальный backoff; warn-лог. Не спамить. |
| Telegram sendMessage | 403 (юзер заблокировал бота) | Помечать юзера в БД (`blocked=true`), пропускать в будущих рассылках; info-лог. |
| aggregate-raw | Частичный сбой | Транзакция per `(user_id, day, metric)` — сбой одного дня не роняет джоб (см. §12.3). |
| OAuth FatSecret flow | Юзер не ввёл PIN / отказ | Запаркованный turn тайм-аутится (напр. 10 мин), бот сообщает «подключение отменено». |
| График (`render-chart`) | Ошибка рендера | Фолбэк на текстовую сводку без графика; error-лог. |

**Принцип:** ни одна ошибка не должна показывать юзеру stack trace или технические детали.
Все ошибки оборачиваются в user-friendly сообщения в tone-пресете юзера. Технические детали —
в логи. Алерты оператору — через логи на старте (внешний алертинг — фаза 6).

---

## 17. Локальная разработка (`eve dev`)

`eve dev` запускает агент локально, но **не запускает schedules на cron-каденце**
(`schedules.mdx:30`). Для дев-итераций:

- **Telegram-канал локально:** нужен публичный URL для webhook'а Telegram → используем
  **cloudflare-tunnel** (`cloudflared`) или **ngrok**. Регистрируем туннельный URL через
  `setWebhook`. Альтернатива — long-polling через локальный скрипт (но eve-канал — webhook).
- **Phone-hub локально:** мокаем POST'ы через `curl` к локальному эндпоинту
  (`http://localhost:2000/eve/v1/phone-hub`) с тестовым токеном и фиктивными payload'ами.
  Набор curl-скриптов в `dev/mock-forwarder/` для типичных метрик (sleep, steps, workout).
- **FatSecret OAuth локально:** callback eve должен быть доступен FatSecret → тот же туннель.
  Для dev используем отдельный FatSecret-app с dev-credentials и `oauth_callback` на туннель.
- **Запуск schedules вручную:** dev-dispatch route
  `POST http://localhost:2000/eve/v1/dev/schedules/<name>` (см. `schedules.mdx:87-96`) —
  запускает schedule единожды, возвращает `sessionIds`.
- **БД локально:** тот же `docker compose up postgres` (Docker доступен на dev-машине).
  Для быстрых тестов — отдельная dev-БД (`health_dev`) или testcontainers.
- **Env:** отдельный `.env.local` с dev-токенами (свой тестовый бот через BotFather, dev-чат).

---

## 18. Тестирование и эвалы

### 18.1 Unit-тесты (детерминированная логика — с первого дня)
Покрывают чистую математику и преобразования, без БД/сети:
- `lib/calories.ts` — BMR (Mifflin-St Jeor), фактор активности из шагов/HR, cold-start
  fallback (<14 дней → self_reported_activity_level), целевой калораж под цель.
- `lib/aggregates.ts` — raw → daily для каждого metric-типа; sleep-through-midnight
  (отнесение к дате пробуждения); upsert при поздних сэмплах.
- `lib/dedup.ts` — дедупликация по типу метрики (sleep_session upsert vs bucket-метрики).
- `lib/anomalies.ts` — пороги срабатывания (сон <5ч, калории >125% цели и т.п.).
- `lib/tenant.ts` — извлечение user_id из разных principal-форматов (приватный чат).
- tz-конверсия: локальный день ↔ UTC-диапазон для данного tz; переход DST.

### 18.2 Интеграционные тесты
- Phone-hub webhook: валидный/невалидный токен, валидный/невалидный payload, дедупликация,
  multi-metric батч.
- `aggregate-raw` на тестовой БД: cutoff-snapshot, upsert, удаление, частичный сбой.
- `sync-fatsecret-diary`: upsert по `external_id` (новые + обновлённые + дубли).

### 18.3 Эвалы (LLM-поведение — позже)
- Качество недельного отчёта (тренды корректны, советы релевантны цели).
- Соблюдение tone-пресета (supportive не становится harsh и наоборот).
- Корректность перевода упражнений wger на русский.
- Соблюдение `region=RU` в FatSecret-вызовах (хотя это уже на уровне tool'а — эвал избыточен).

---

## 19. Roadmap / фазы

| Фаза | Содержание                                                         |
|------|--------------------------------------------------------------------|
| **0** | Скелет eve: Telegram-канал, БД-клиент, schema миграции, onboarding |
| **1** | Phone-hub ingestion + хранение (raw + daily aggregates)            |
| **2** | FatSecret (с OAuth) + food_entries; калории (вариант C)            |
| **3** | Недельный отчёт + графики; tone-пресеты                            |
| **4** | Проактивные сообщения (dispatcher, anomaly-check, workout)         |
| **5** | Тренировочная программа (wger + адаптация)                         |
| **6** | Полировка: edge-cases, удаление данных, healthcheck, мониторинг    |
| **7** (опц.) | Мобильный мост для CMF by Nothing (нативный forwarder)   |

---

## 20. Открытые вопросы / точки проверки при реализации

> Ранее блокирующие вопросы (идентификация юзера, OAuth FatSecret, principal в schedules)
> решены в §6.2, §7, §9. Ниже — оставшиеся, не-блокирующие.

1. **Маппинг полей forwarder'ов → `raw_samples.payload`.** Зафиксировать нормализованный
   формат payload для каждого `metric` исходя из того, что реально шлют:
   - Android `mcnaveen/health-connect-webhook` — какие имена полей у sleep/steps/HR/workout.
   - iOS «Health Webhook» — формат может отличаться; нужен нормализующий слой в
     route-хендлере phone-hub (маппинг полей по `platform`).
2. **Huawei Health → Health Connect на Android.** Huawei Health пишет в Health Connect не
   нативно (исторически); может потребоваться мост `Health Sync` (платный) либо подтверждение,
   что текущая версия Huawei Health уже пишет в Health Connect. Проверить при подключении жены.
3. **Стабильность iOS-форвардера.** Если выбирается платный «Health Webhook» ($14.99) —
   проверить покрытие нужных метрик (особенно sleep-стадии и HR) и надёжность retry.
   Если `iicodemai-wq/health-bridge-for-ha` (MIT, 0★) — заложить время на self-build/тесты.
4. **wger: OpenAPI-коннекция vs свои tools.** В спеке выбраны свои tools (`build-program` с
   прямыми `fetch`); при имплементации подтвердить, что этого достаточно, или завернуть
   `/api/v2/exerciseinfo/` в `defineOpenAPIConnection` если нужен более широкий поиск.
5. **Динамический schedule-store на фазе масштабирования.** На v1 — статичные cron'ы + loop
   по `users` (§9). При росте аудитории свыше ~10 юзеров — перейти на паттерн
   `patterns/dynamic-scheduling.md` (schedule-store с `nextRunAt`/lease) для точности
   per-user напоминаний и снижения нагрузки (не опрашивать всех каждый тик).
6. **Покрытие метрик на iOS.** Подтвердить, что iOS-форвардер отдаёт sleep-стадии (deep/rem/
   light), а не только total — иначе аналитика сна на iOS будет беднее, чем на Android.

---

*Документ готов к обсуждению и корректировке. После утверждения — переход к фазе 0
(скелет eve + schema).*
