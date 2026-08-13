# Health Agent — текущее состояние проекта

> **Этот файл — living-документ.** Сюда фиксируется: что сделано, что в работе, и **журнал
> всех правок** после доработок. Сюда же пишутся отклонения от
> [`SPECIFICATION.md`](./SPECIFICATION.md) и фазовых спецификаций (`docs/phases/PHASE-N.md`).
>
> **Правило (зафиксировано в [`AGENTS.md`](../AGENTS.md)):** каждая завершённая доработка
> (фаза, задача, багфикс, изменение модели/env/зависимостей, отклонение от спеки) — должна
> быть отражена здесь. Журнал правок — append-only, новые записи сверху.

Дата последнего обновления: **2026-08-14**.

---

## 1. Текущее состояние по фазам

Фазы соответствуют [`SPECIFICATION.md`](./SPECIFICATION.md), §19. Подробный состав каждой
фазы — в `docs/phases/PHASE-N.md`.

| Фаза | Название | Статус | Спецификация | Замечания |
|------|----------|--------|--------------|-----------|
| **0** | Скелет eve: Telegram, БД, schema, онбординг | ✅ завершена | [`PHASE-0.md`](./phases/PHASE-0.md) | Telegram-канал + allowlist, schema всех 13 таблиц + миграции (drizzle), онбординг (model-driven, 10 шагов), `requireUser`/`userAuthFor`, tone-пресеты, 5 settings-инструментов + complete-onboarding/get-my-status, unit-тесты (22 зелёных). **Модель:** `opencode-go/deepseek-v4-flash` (128k context, escape-hatch). Авто-верифицировано: typecheck, `eve build`, docker compose + `drizzle-kit migrate` (13 таблиц + pgcrypto), vitest. **Не авто-верифицировано** (нужны реальные креды/туннель): Telegram end-to-end онбординг — см. checklist в журнале. |
| **1** | Phone-hub ingestion + агрегаты | ✅ завершена | [`PHASE-1.md`](./phases/PHASE-1.md) | Custom channel `phone-hub` (`POST /eve/v1/phone-hub`, Bearer-токен, нормализация, дедуп, запись в `raw_samples`); schedule `aggregate-raw` (raw→daily, cutoff-snapshot, §12.3); libs `phone-hub-token`/`normalize`/`dedup`/`aggregates`/`log`/`daily-read`; tools `get-sleep`/`get-activity`/`get-workouts`/`add-manual-data`/`rotate-phone-hub-token`; dev/mock-forwarder. **Миграция 0002**: unique-индекс `raw_samples (user_id, metric, recorded_at)` (фикс гонки/двойного счёта). Unit-тесты (+52, всего 74 зелёных). Авто-верифицировано: typecheck, `eve build`, manifest (phone-hub route + schedule `0 3 * * *` + 12 tools), vitest. **Не авто-верифицировано** (нужны docker-БД + туннель): webhook end-to-end + apply миграций 0000–0002 — checklist ниже. |
| **2** | FatSecret (OAuth) + food_entries + калории | 🔲 не начата | [`PHASE-2.md`](./phases/PHASE-2.md) | Зависит от фазы 0; OAuth 1.0a 3-legged PIN-flow. |
| **3** | Недельный отчёт + графики + tone-пресеты | 🔲 не начата | [`PHASE-3.md`](./phases/PHASE-3.md) | Зависит от фаз 1–2 (нужны агрегаты + питание). |
| **4** | Проактивные сообщения (dispatcher, алерты, workout) | 🔲 не начата | [`PHASE-4.md`](./phases/PHASE-4.md) | Зависит от фаз 0–3. |
| **5** | Тренировочная программа (wger + адаптация) | 🔲 не начата | [`PHASE-5.md`](./phases/PHASE-5.md) | Зависит от фаз **0 и 4** (фаза 4 — `workout-reminder` потребляет `reminder_settings.workout_times`); wger REST без ключа. |
| **6** | Полировка: edge-cases, удаление данных, мониторинг | 🔲 не начата | [`PHASE-6.md`](./phases/PHASE-6.md) | Зависит от фаз 0–5. |
| **7** (опц.) | Мобильный мост для CMF by Nothing | 🔲 отложена | [`PHASE-7.md`](./phases/PHASE-7.md) | За рамками первого релиза; активируется по запросу. |

Легенда: 🔲 не начата · 🔄 в работе · ✅ завершена · ⏸️ заблокирована/отложена.

### Точка старта

- В репозитории сейчас дефолтный скелет eve (генерированный `eve init`): Vercel-канал
  (`agent/channels/eve.ts` с `vercelOidc` / `localDev` / `placeholderAuth`), пустой агент
  `defineAgent({ model: "anthropic/claude-sonnet-5" })`, инструкции-заглушка
  («You are a helpful assistant»).
- Никаких health-специфичных файлов, schema, миграций, .env.example — ещё нет.
- `node_modules/eve` доступен — доки eve можно читать локально (см. AGENTS.md).

---

## 2. Активные блокеры / открытые вопросы

Из [`SPECIFICATION.md`](./SPECIFICATION.md), §20 (не-блокирующие, проверяются при
имплементации соответствующих фаз):

1. **Маппинг полей forwarder'ов → `raw_samples.payload`** (фаза 1). Зафиксировать
   нормализованный формат payload для каждого `metric` (Android vs iOS).
2. **Huawei Health → Health Connect на Android** (фаза 1). Возможен мост `Health Sync`
   (платный) — проверить при подключении.
3. **Стабильность iOS-форвардера** (фаза 1). Платный «Health Webhook» ($14.99) vs
   `iicodemai-wq/health-bridge-for-ha` (MIT, self-build).
4. **wger: свои tools vs OpenAPI-коннекция** (фаза 5). В спеке выбраны свои tools —
   подтвердить при имплементации.
5. **Динамический schedule-store** при росте аудитории >~10 юзеров (фаза 4/масштабирование).
6. **Покрытие метрик на iOS** — sleep-стадии (deep/rem/light), а не только total (фаза 1).

Новые блокеры, обнаруженные в работе, добавляются сюда же с пометкой «🚧 Блокер» и датой.

---

## 3. Журнал правок

> Append-only: новые записи — **сверху**. Формат:
>
> ```
> ### YYYY-MM-DD — компонент — краткое описание
> - Что: ...
> - Затронутые файлы/артефакты: ...
> - Причина/контекст: ...
> - Спека: <ссылка на раздел SPECIFICATION.md или PHASE-N.md, если менялась>
> - Коммит: <hash или "не коммичено">
> ```

### 2026-08-14 — фаза 1 — правки по ревью (3 замечания, средние)

- **Что:** По итогам код-ревью фазы 1 исправлены 3 замечания. Авто-верификация после
  правок: `tsc --noEmit` чисто; `vitest run` — 74 теста; `eve build` проходит;
  миграция 0002 (unique-индекс) сгенерирована и зарегистрирована в journal/snapshot.
- **1. Гонка в `ingestSample` → двойной счёт.** Не было unique-ограничения на
  `(user_id, metric, recorded_at)` → два параллельных POST'а одного события (ретрай
  forwarder'а) оба проходили select→delete→insert → две строки → двойной счёт в
  `aggregateSteps`/`aggregateActivity`. **Фикс:** миграция `0002_bumpy_bruce_banner.sql`
  делает индекс `raw_samples_user_metric_recorded_idx` UNIQUE;
  `agent/lib/db/schema.ts` — `uniqueIndex`. `ingestSample` переписан на один atomic
  `INSERT ... ON CONFLICT (user_id, metric, recorded_at) DO UPDATE ... WHERE payload
  IS DISTINCT FROM EXCLUDED.payload ... RETURNING xmax`: unique-индекс исключает дубль
  при гонке, WHERE пропускает байт-в-байт ретраи (RETURNING пуст → `retry-dup`),
  `xmax` отличает new от upsert. Убраны select→delete→insert + явная транзакция.
- **2. Manual vs device для bucket-метрик.** §12.2 «manual имеет приоритет при
  отсутствии автоматических» расходился с кодом (для steps/HR/calories manual и device
  суммировались). **Решение:** задокументировано поведение — unique-индекс (из п.1)
  даёт один сэмпл на бакет → manual и device НЕ суммируются (last-write-wins;
  обычно синхронизация устройства приходит позже и перезаписывает placeholder).
  Обновлены `agent/tools/db/add-manual-data.ts` (description) и SPECIFICATION §12.2.
- **3. `get-activity` source-индикатор.** Брался только от steps → при наличии
  HR/калорий, но отсутствии шагов возвращал `source='none'`. **Фикс:** добавлен
  `combinedSource()` в `agent/lib/daily-read.ts` (aggregate > raw > none по трём
  метрикам); `agent/tools/db/get-activity.ts` использует его.
- **Затронутые файлы:** `agent/lib/db/schema.ts`, `agent/lib/dedup.ts`,
  `agent/channels/phone-hub.ts`, `agent/lib/daily-read.ts`,
  `agent/tools/db/{get-activity,add-manual-data}.ts`, `drizzle/0002_bumpy_bruce_banner.sql`
  + `drizzle/meta/*`; `docs/SPECIFICATION.md` (§12.2).
- **Спека:** §12.2 (поведение manual vs device уточнено). Модель: raw_samples индекс →
  unique (миграция 0002) — расширение §5.3.
- **Состояние проекта:** фаза 1 завершена + ревью-правки внесены.
- **Коммит:** _не коммичено._

### 2026-08-14 — фаза 1 — завершена реализация phone-hub ingestion + агрегатов

- **Что:** Реализована фаза 1 целиком по `PHASE-1.md`. Custom channel `phone-hub`
  (приём webhook'ов от forwarder'ов, Bearer-токен, нормализация payload, дедупликация,
  запись в `raw_samples`); schedule `aggregate-raw` (схлопывание сырых сэмплов в
  `daily_aggregates` по алгоритму §12.3 — cutoff-snapshot, upsert, удаление по TTL 30
  дней); libs (`phone-hub-token`, `normalize`, `dedup`, `aggregates`, `log`,
  `daily-read`) + `getUserTimezone`; инструменты `get-sleep`/`get-activity`/
  `get-workouts`/`add-manual-data`/`rotate-phone-hub-token`; dev/mock-forwarder.
- **Авто-верификация (✅):** `tsc --noEmit` чисто; `vitest run` — 74 теста зелёных
  (+52: агрегаты по всем metric с DST/sleep-through-midnight, нормализация с variant
  mapping, payload-hash/dedup, токен round-trip/constant-time); `eve build` проходит;
  манифест подтверждает регистрацию канала `POST /eve/v1/phone-hub`, schedule
  `aggregate-raw` (cron `0 3 * * *`, `hasRun`), 12 tools.
- **Не авто-верифицировано (checklist для автора):** webhook end-to-end + aggregate
  требуют docker-БД и локального `eve dev`. Шаги: (1) `docker compose up -d postgres`
  + `npm run db:migrate`; (2) `npm run dev`; (3) пройди онбординг от своего chat_id
  (или вставь user-строку); (4) `node --env-file=.env dev/mock-forwarder/mint-dev-token.mjs
  <chat_id> android amazfit`; (5) `PHONE_HUB_TOKEN=… bash dev/mock-forwarder/send.sh`
  → `HTTP 200` × 5, строки в `raw_samples`; (6) повтор `send.sh` → логи `dedup:
  retry-dup`, новых строк нет; (7) чужой токен → `401`, кривой payload → `400`, тело
  >1MB → `413`; (8) `curl -X POST …/dev/schedules/aggregate-raw` → `daily_aggregates`
  заполнились (sleep через полночь → дата пробуждения; текущий день НЕ агрегирован).
- **Затронутые файлы/артефакты (создано/изменено):**
  - Либы: `agent/lib/{phone-hub-token,normalize,dedup,aggregates,log,daily-read}.ts`;
    `agent/lib/tenant.ts` (+`getUserTimezone`); `agent/lib/env.ts`
    (+`phoneHubWebhookUrl`).
  - Канал: `agent/channels/phone-hub.ts`.
  - Schedule: `agent/schedules/aggregate-raw.ts`.
  - Tools: `agent/tools/db/{get-sleep,get-activity,get-workouts,add-manual-data}.ts`,
    `agent/tools/settings/rotate-phone-hub-token.ts`.
  - Инструкции: `agent/instructions.md` (фаза 1, новые tools, расстублен шаг 7).
  - dev: `dev/mock-forwarder/{README.md,send.sh,mint-dev-token.mjs}`.
  - Тесты: `tests/{aggregates,dedup,normalize,phone-hub-token}.test.ts`.
  - Конфиг: `.env.example` (+`PHONE_HUB_WEBHOOK_URL`).
- **Принятые решения и отклонения от спецификации (см. ниже «Спека»):**
  1. **Контракт payload — Canonical + variant-mapping** (подтверждено автором). Канон.
     формат — источник правды; слой маппинга по `platform` через `registerVariantMapper`
     (пока identity). Реальные маппинги — при подключении устройства (откр. вопрос §20.1).
  2. **`add-manual-data` → `raw_samples`** (`payload.source='manual'`), НЕ напрямую в
     `daily_aggregates` (§5.5). Единый путь через `aggregate-raw` + дедуп.
  3. **`recorded_at` = время события/измерения** для всех metric (sleep→wake_at,
     workout→start_at, bucket→bucket-time). Дедуп uniformly по `(user_id, metric,
     recorded_at)` + payload-hash. Разрешает напряжённость §12.4 (payload.bucket для
     bucket-метрик избыточен при recorded_at=bucket — хранится для читаемости).
  4. **Новый env `PHONE_HUB_WEBHOOK_URL`** — публичная база webhook'а (Caddy), из
     которой `rotate-phone-hub-token` собирает URL. Спеку §14 стоит пополнить.
  5. **Custom-маршрут eve монтируется ровно по пути из `POST(path)`** (проверено по
     `node_modules/eve/dist` + манифесту: `urlPath: e.path`). Поэтому в канале пишу
     полный `/eve/v1/phone-hub`. Закрывает риск PHASE-1 §8 (`defineChannel`+routes).
  6. **`aggregate-raw` — `run`-handler с прямым DB-доступом** (не markdown-промпт и не
     через `to()`/`appAuth`): алгоритм транзакционный, его нельзя доверять LLM.
  7. **`resting_bpm` при отсутствии явного resting-сэмпла = суточный min** (прокси).
  8. **Тесты — pure unit + manual checklist** (как фаза 0; интеграция через
     mock-forwarder + dev-dispatch). `ingestSample` (с БД) покрывается интеграционно.
- **Спека:** Фаза реализована по `PHASE-1.md` и `SPECIFICATION.md` §5.3/§6.1/§7.2/§8/
  §9/§12.1–12.4/§13/§16/§17/§18. Отклонения: §5.5 (manual-data→raw_samples, фиксация),
  §12.4 (payload.bucket избыточен), §14 (+env PHONE_HUB_WEBHOOK_URL). SPECIFICATION.md
  §5.3/§5.5/§14 текстово обновлены синхронно (см. ниже).
- **Состояние проекта:** фаза 1 завершена и авто-верифицирована. Фазы 2–6 не начаты.
- **Коммит:** _не коммичено._

### 2026-08-11 — фаза 0 — правки по ревью (7 замечаний: 3 высоких, 4 средних)

- **Что:** По итогам код-ревью фазы 0 исправлены 7 замечаний (см. ниже). Авто-верификация
  после правок: `tsc --noEmit` чисто; `vitest run` — 23 теста (добавлен тест невалидного
  формата `localDayRangeUtc`); `drizzle-kit migrate` применяет миграцию `0001` поверх `0000`
  на чистой БД (13 таблиц, `users` — 8 колонок с новой `timezone_set_at`).
- **Высокие:**
  1. **`.gitignore` ослаблял маску секретов.** Было `.env`/`.env.local`/`.env.*.local`
     (пропускало `.env.production`, `.env.dev` и пр. в коммит). Стало `.env*` + `!.env.example`.
  2. **Гонка в `ensureUserByChatId`** (параллельные первые webhook'и → unique violation).
     Переписано на atomic `insert(...).onConflictDoNothing().returning()` + fallback select.
  3. **`localDayRangeUtc` хрупкий контракт** — `day` через `getFullYear/Month/Date` (локальные
     компоненты Date) съезжал на сутки на машинах с отрицательным offset. Контракт изменён:
     принимает **строку `"YYYY-MM-DD"`** (из `localDay()`), не зависит от machine tz.
     Неиспользуемый `localDayDate` удалён; тесты переведены на строковый аргумент.
- **Средние:**
  4. **`set-goal` валидация** — был refine только для `maintenance`. Добавлен `superRefine`:
     для `weight_loss`/`muscle_gain` обязателен `target_weight_kg` и **ровно одно** из
     `tempo_kg_per_week`/`target_date`; `target_date` не в прошлом; при `calorie_source='manual'`
     требуется `manual_target_kcal`.
  5. **`complete-onboarding` не проверял готовность** — модель могла завершить онбординг без
     профиля/цели. Теперь проверяет наличие `profiles` и активной `goals`; иначе
     `{ok:false, missing:[...]}`.
  6. **`onboardingStepsDone.timezone` — скрытая копипаста** (`o.profile !== null`): шаг tz
     считался пройденным без реального выбора пояса → guard мог пропустить шаг 3. Добавлена
     колонка `users.timezone_set_at` (миграция `0001`): `set-tz` выставляет её; шаг 3 теперь
     честно определяется по `timezone_set_at IS NOT NULL`.
  7. **`set-reminders` не позволял отключить напоминание** — поля не принимали `null`. Теперь
     семантика: `undefined` → не трогать; `null` → сбросить в NULL; значение → поставить
     (для `morning/midday/evening_local` и `workout_times`).
- **Затронутые файлы/артефакты:** `.gitignore`; `agent/lib/{tenant,time,user-status}.ts`;
  `agent/lib/db/schema.ts` (+колонка); `drizzle/0001_add_users_timezone_set_at.sql` +
  `drizzle/meta/*`; `agent/tools/{goals/set-goal,account/complete-onboarding,
  settings/set-reminders,settings/set-tz}.ts`; `tests/time.test.ts`.
- **Спека:** правки в рамках фазы 0 (контракты PHASE-0/SPECIFICATION не нарушены). Новая
  колонка `users.timezone_set_at` — расширение модели данных §5.1; при обновлении
  SPECIFICATION.md §5.1 её следует зафиксировать.
- **Состояние проекта:** фаза 0 завершена + ревью-правки внесены.
- **Коммит:** _см. ниже (коммитится вместе)._

### 2026-08-11 — фаза 0 — завершена реализация скелета (Telegram, БД, schema, онбординг)

- **Что:** Реализована фаза 0 целиком по `PHASE-0.md`. Vercel-скелет удалён;
  поднят Telegram-канал с allowlist, schema всех 13 таблиц проекта + drizzle-миграции,
  онбординг (model-driven, 10 шагов), `requireUser`/`userAuthFor`, tone-пресеты,
  инструменты `update-profile`/`set-goal`/`set-tone`/`set-reminders`/`set-tz`/
  `complete-onboarding`/`get-my-status`, unit-тесты.
- **Авто-верификация (✅):** `tsc --noEmit` чисто; `eve build` проходит; `docker compose up
  postgres` + `drizzle-kit migrate` создают все 13 таблиц + `pgcrypto` (21 индекс/констрейнт,
  включая composite PK и partial unique); `vitest run` — 22 теста зелёных
  (tenant principal-форматы, userAuthFor формат, tz-конверсия + DST spring forward/fall back
  + sleep через полночь).
- **Не авто-верифицировано (checklist для автора):** Telegram end-to-end требует реального
  бота + публичного URL. Шаги: (1) `@BotFather` → токен; (2) `setWebhook` с
  `secret_token` на туннель (`cloudflared`/ngrok) → `/eve/v1/telegram`; (3) прописать
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET_TOKEN`/`TELEGRAM_BOT_USERNAME`/
  `ALLOWED_CHAT_IDS`/`MODEL_API_KEY` в `.env`; (4) `npm run dev`; (5) пройти онбординг
  10 шагов от своего chat_id, проверить `onboarded_at` в БД; (6) чужой chat_id молчит;
  (7) `set-tone` меняет стиль; (8) settings-инструменты пишут в БД.
- **Затронутые файлы/артефакты (создано/изменено):**
  - Конфиг: `package.json` (−`@vercel/connect`, +`drizzle-orm`/`postgres`/`drizzle-kit`/
    `vitest`, scripts `db:*`/`test*`), `tsconfig.json` (paths `#*`, include `tests/`),
    `.env.example` (+`TELEGRAM_BOT_USERNAME`), `.gitignore` (`.env.local`),
    `docker-compose.yml` (Postgres 16 + `pgcrypto` + `POSTGRES_PORT`),
    `drizzle.config.ts`, `vitest.config.ts`, удалён `.vercelignore`.
  - БД: `agent/lib/db/schema.ts` (13 таблиц), `agent/lib/db/client.ts`,
    `drizzle/0000_init.sql` (+ `CREATE EXTENSION pgcrypto`), `drizzle/meta/*`,
    `docker/postgres-init.sql`.
  - Либы: `agent/lib/{env,tenant,user-auth,tone-presets,time,user-status}.ts`.
  - Канал: `agent/channels/telegram.ts`, удалён `agent/channels/eve.ts`.
  - Инструкции: `agent/instructions.md`, `agent/instructions/{onboarding-guard,tone,
    user-context}.ts`.
  - Tools: `agent/tools/goals/{update-profile,set-goal}.ts`,
    `agent/tools/settings/{set-tone,set-reminders,set-tz}.ts`,
    `agent/tools/account/{complete-onboarding,get-my-status}.ts`.
  - Агент: `agent/agent.ts`.
  - Тесты: `tests/{tenant,user-auth,time}.test.ts`.
- **Принятые решения и отклонения от спецификации (см. ниже «Спека»):**
  1. **Модель — `opencode-go/deepseek-v4-flash`** (выбор автора, фиксирует дефолт из
     §20). AI Gateway не отдаёт metadata контекстного окна → задан `modelContextWindowTokens:
     128_000` (escape hatch). 🚧 **TODO:** подтвердить точное контекстное окно
     deepseek-v4-flash и при необходимости поправить `agent.ts`.
  2. **`onboarding-guard` / `tone` / `user-context` реализованы как динамические инструкции**
     (`agent/instructions/*.ts`, `defineDynamic`+`defineInstructions`), **НЕ** как
     `turn.started`-hook. Причина: hooks в eve observe-only и не умеют инжектить промпт
     или блокировать turn (проверено по `node_modules/eve/dist` + `guides/hooks.md`).
     Сути контракта не меняет. В `PHASE-0.md` §6.5 добавлен note.
  3. **`goals` surrogate PK.** Спека §5.2 не declares PK — добавлен
     `id bigint generated always as identity primary key` (+ `active` для текущей цели).
  4. **`daily_aggregates.value.workouts.calories_kgl` → `calories_kcal`** (опечатка §5.3).
     На уровне `schema.ts` `value` хранится как `jsonb` без жёсткой схемы — исправление
     задокументировано и должно применяться в коде агрегации (фаза 1, `lib/aggregates.ts`).
  5. **`TELEGRAM_BOT_USERNAME`** добавлен в `.env.example` (используется в PHASE-0 §6.1,
     но отсутствовал в §14). Спеку §14 стоит пополнить.
  6. **`requireUser` всегда ре-лукап `user_id` из БД по `chat_id`** (не доверяет
     `attributes.user_id` синтезированного principal'а) — безопасность.
  7. **`update-profile` при указании веса дописывает строку в `weight_log`**
     (`current_weight_kg` = «последнее», `weight_log` = «история»). `onConflictDoNothing`
     защищает от дубля по `(user_id, measured_at)`.
  8. **`db/client.ts`** при отсутствии `DATABASE_URL` использует placeholder URL
     (postgres-js lazy-pool), чтобы `eve build` мог оценивать tool-модули без env.
     В runtime реальный `DATABASE_URL` обязан быть задан — иначе первый запрос упадёт с
     connection error.
  9. **`docker-compose.yml`: порт Postgres настраиваемый** через `${POSTGRES_PORT:-5432}`.
     Причина: на части Windows-машин порт 5432 попадает в Hyper-V excluded port range и
     недоступен для bind; override (напр. `POSTGRES_PORT=15432`) решает это локально.
     Дефолт остаётся 5432 (§14).
- **Спека:** Фаза реализована по `PHASE-0.md` и `SPECIFICATION.md` §4/§5/§7/§8/§9/§10/
  §11.3/§12.1/§14/§17/§18.1. Отклонения: §5.2 (goals PK), §5.3 (опечатка calories_kgl),
  §6.5 PHASE-0 (onboarding-guard через инструкции), §14 (env TELEGRAM_BOT_USERNAME,
  POSTGRES_PORT; модель). SPECIFICATION.md и PHASE-N.md текстово не правились — решения
  зафиксированы здесь; при расхождении STATUS.md приоритетнее для текущего состояния кода.
- **Состояние проекта:** фаза 0 завершена и авто-верифицирована. Фазы 1–6 не начаты.
- **Коммит:** _не коммичено._

### 2026-08-11 — docs — ревью PHASE-4 и PHASE-5: исправление 14 замечаний (4 критических)

- **Что:** По результатам ревью PHASE-4/PHASE-5 (против SPECIFICATION.md, смежных фаз,
  AGENTS.md) исправлено 14 замечаний: 8 в PHASE-4 (P4-1…P4-8), 6 в PHASE-5 (P5-1…P5-6),
  плюс синхронные правки глобала и смежных фаз. Критические (механизмы, которые в прежнем
  виде не работали): **P4-1** (fuzzy-окно не покрывало слоты при разовых тиках), **P4-2**
  (`aggregate-raw` не производил свежих дней → anomaly-check без источника), **P5-2**
  (перенос тренировки не синхронизировал напоминания), **P5-4** (адаптация программы не
  имела триггера). Остальное — документационные правки и квантификация DoD.
- **Затронутые файлы/артефакты:**
  - `docs/SPECIFICATION.md`: §5.1 (добавлена колонка `users.blocked`), §5.6 (формат
    `workout_times`: `day_of_week` 0=вс…6=сб, `local_time` "HH:MM"), §6.1 (убран
    инкрементальный агрегат из webhook'а), §9 (симметричное fuzzy-окно + dedup; daily-джобы
    ходят каждый час; блок «почему не раз в сутки»), §11.4 (убрана несуществующая колонка
    `workout_programs.plan`; добавлен триггер адаптации `program-check`), §11.5
    (квантифицированы все 4 порога + guard'ы; зафиксированы источники данных: текущий день
    из `raw_samples`, цель из `lib/calories.ts`, вес из `weight_log`), §12.3 (алгоритм
    `aggregate-raw` переписан: агрегация всех завершённых дней + cutoff только для удаления
    по `received_at`; блок «свежесть для anomaly-check»).
  - `docs/phases/PHASE-0.md` (§4: упоминание `users.blocked`).
  - `docs/phases/PHASE-1.md` (§5.1: убран инкрементальный агрегат; §5.3: синхронизация с
    новой §12.3 + блок про свежесть для фазы 4).
  - `docs/phases/PHASE-3.md` (§6: уточнено, что `blocked` заведён фазой 0).
  - `docs/phases/PHASE-4.md` (переписаны §1, §3 cron'ы, §4 источники, §5.1 fuzzy+dedup,
    §5.2 фильтр онборженных, §5.3 нумерация day_of_week, §5.4 пороги+источники, §5.5
    `blocked`, §7 DoD с измеримыми критериями, §8 риски с компромиссом rate-limit).
  - `docs/phases/PHASE-5.md` (§1: добавлен триггер `program-check`; §2: фаза 4 обязательна;
    §3: добавлен `program-check.ts`; §5.2: HITL-подтверждение перезаписи `workout_times`;
    §5.3: 3 статуса `log-workout`; §5.4: механика переноса разовый/регулярный + sync
    напоминаний; новый §5.5: триггер `program-check`; §7 DoD; §8 риски с измеримым
    эвал-критерием; §9 ссылки).
  - `docs/STATUS.md`: таблица фаз (фаза 5 зависит от 0 и 4) + эта запись.
- **Причина/контекст:** До реализации исправлены архитектурные расхождения, выявленные
  ревью. Все правки, меняющие зафиксированную в SPECIFICATION.md архитектуру/модель данных,
  внесены синхронно в глобал + смежные фазы (по правилу AGENTS.md).
- **Спека:** `SPECIFICATION.md` §5.1, §5.6, §6.1, §9, §11.4, §11.5, §12.3; `PHASE-0.md` §4,
  `PHASE-1.md` §5.1/§5.3, `PHASE-3.md` §6, `PHASE-4.md` (полностью), `PHASE-5.md`
  (полностью).
- **Состояние проекта:** скелет не тронут. Фазы не начаты.
- **Коммит:** _не коммичено._

### 2026-08-11 — docs — инициализация проектной документации

- **Что:** Создан全套 проектной документации: инициализирован `AGENTS.md` под health-agent,
  создан `docs/STATUS.md` (этот файл), созданы фазовые спецификации
  `docs/phases/PHASE-0.md` … `PHASE-7.md`.
- **Затронутые файлы/артефакты:**
  - `AGENTS.md` (переписан: stack, структура доков, соглашения кода, правило про STATUS.md).
  - `docs/STATUS.md` (новый).
  - `docs/phases/PHASE-{0..7}.md` (новые; 8 файлов).
- **Причина/контекст:** Подготовка к реализации по дорожной карте из SPECIFICATION.md §19.
  Зафиксировать состав каждой фазы, DoD, риски и edge-cases до написания кода. Ввести
  правило фиксации всех правок в STATUS.md, чтобы документация и код не расходились.
- **Спека:** `SPECIFICATION.md` §19 (Roadmap / фазы). Состав фаз и их границы взяты
  дословно оттуда; детали — из соответствующих разделов (§3 стек, §4 структура, §5 данные,
  §6–§9 интеграции/каналы/schedules, §10 онбординг, §11 логика, §12 edge-cases, §13
  безопасность, §14–§16 инфра/observability/ошибки).
- **Состояние проекта:** скелет не тронут (дефолтный Vercel-канал, пустой агент). Фаза 0
  не начата.
- **Коммит:** _не коммичено._
