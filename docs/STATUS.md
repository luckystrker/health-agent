# Health Agent — текущее состояние проекта

> **Этот файл — living-документ.** Сюда фиксируется: что сделано, что в работе, и **журнал
> всех правок** после доработок. Сюда же пишутся отклонения от
> [`SPECIFICATION.md`](./SPECIFICATION.md) и фазовых спецификаций (`docs/phases/PHASE-N.md`).
>
> **Правило (зафиксировано в [`AGENTS.md`](../AGENTS.md)):** каждая завершённая доработка
> (фаза, задача, багфикс, изменение модели/env/зависимостей, отклонение от спеки) — должна
> быть отражена здесь. Журнал правок — append-only, новые записи сверху.

Дата последнего обновления: **2026-08-16**.

---

## 1. Текущее состояние по фазам

Фазы соответствуют [`SPECIFICATION.md`](./SPECIFICATION.md), §19. Подробный состав каждой
фазы — в `docs/phases/PHASE-N.md`.

| Фаза | Название | Статус | Спецификация | Замечания |
|------|----------|--------|--------------|-----------|
| **0** | Скелет eve: Telegram, БД, schema, онбординг | ✅ завершена | [`PHASE-0.md`](./phases/PHASE-0.md) | Telegram-канал + allowlist, schema всех 13 таблиц + миграции (drizzle), онбординг (model-driven, 10 шагов), `requireUser`/`userAuthFor`, tone-пресеты, 5 settings-инструментов + complete-onboarding/get-my-status, unit-тесты (22 зелёных). **Модель:** `opencode-go/deepseek-v4-flash` (128k context, escape-hatch). Авто-верифицировано: typecheck, `eve build`, docker compose + `drizzle-kit migrate` (13 таблиц + pgcrypto), vitest. **Не авто-верифицировано** (нужны реальные креды/туннель): Telegram end-to-end онбординг — см. checklist в журнале. |
| **1** | Phone-hub ingestion + агрегаты | ✅ завершена | [`PHASE-1.md`](./phases/PHASE-1.md) | Custom channel `phone-hub` (`POST /eve/v1/phone-hub`, Bearer-токен, нормализация, дедуп, запись в `raw_samples`); schedule `aggregate-raw` (raw→daily, cutoff-snapshot, §12.3); libs `phone-hub-token`/`normalize`/`dedup`/`aggregates`/`log`/`daily-read`; tools `get-sleep`/`get-activity`/`get-workouts`/`add-manual-data`/`rotate-phone-hub-token`; dev/mock-forwarder. **Миграция 0002**: unique-индекс `raw_samples (user_id, metric, recorded_at)` (фикс гонки/двойного счёта). Unit-тесты (+52, всего 74 зелёных). Авто-верифицировано: typecheck, `eve build`, manifest (phone-hub route + schedule `0 3 * * *` + 12 tools), vitest. **Не авто-верифицировано** (нужны docker-БД + туннель): webhook end-to-end + apply миграций 0000–0002 — checklist ниже. |
| **2** | FatSecret (OAuth) + food_entries + калории | ✅ завершена | [`PHASE-2.md`](./phases/PHASE-2.md) | Своя FatSecret-интеграция (не MCP): OAuth 2.0 client-credentials (app-токен в памяти, refresh за 1ч) + OAuth 1.0a 3-legged PIN-flow (`connect/complete-fatsecret`, HITL `ask_question`); `log-food` (search→details→log→копия в `food_entries`; manual/barcode_off), `lookup-barcode` (FatSecret→Open Food Facts), `get-food`/`get-calorie-balance`/`get-target-calories`; `lib/calories.ts` (Mifflin-St Jeor, фактор из 14 дней, cold-start fallback, пол-минимумы); schedule `sync-fatsecret-diary` (get_month+get → upsert по external_id + удаление исчезнувших). Подпись OAuth 1.0a — ручной HMAC-SHA1 (без зависимости), сверена с RFC 5849 + эрратой 2550. Unit-тесты (+63, всего 137). Ревью-правки P1: таймаут 15с на все FatSecret-fetch'и (каждая retry-попытка), классификация ошибок app-токена (fs_auth_failed ≠ fs_not_configured; сеть → fs_unavailable). Авто-верифицировано: typecheck, `eve build`, manifest (19 tools + schedule `0 4 * * *`), vitest. **Не авто-верифицировано** (нужны реальные FatSecret-креды + туннель + docker-БД): end-to-end PIN-flow, запись в дневник, sync — см. checklist в журнале. ⚠️ Риск: region/language и find_id_for_barcode в доках v1 помечены Premier — на free-тарифе возможна деградация до US-базы/OFF-фолбэка (не ошибка, обработано). |
| **3** | Недельный отчёт + графики + tone-пресеты | ✅ завершена | [`PHASE-3.md`](./phases/PHASE-3.md) | Schedule `weekly-report` (cron `0 10 * * 1`): dispatcher по §9 (`userAuthFor` → `to(telegram).send`) + digest-промпт; `lib/weekly-digest` (единый источник трендов: сон/шаги/вес/калории/тренировки за 7 завершённых локальных дней); tool `render-chart` (сон/вес/шаги/калории → PNG локально → прямой `sendPhoto`); `lib/chart-config` (pure-конфиги) + `lib/telegram-send` (multipart, 429-backoff с retry_after, 403→blocked); 403-детект в канале (`message.completed` override → `users.blocked`); тренды в `user-context.ts` (TTL-кэш 10 мин). Зависимости: `chartjs-node-canvas@^5` + `chart.js@^4.5` (+нативный `canvas@3`). Unit-тесты (+49, всего 186). Авто-верифицировано: typecheck, `eve build` (20 tools + schedule в манифесте; PNG-рендер из собранного бандла), vitest. **Не авто-верифицировано** (нужны туннель + docker-БД + реальный бот + Linux VPS) — см. checklist в журнале. |
| **4** | Проактивные сообщения (dispatcher, алерты, workout) | ✅ завершена | [`PHASE-4.md`](./phases/PHASE-4.md) | Schedules `daily-morning/midday/evening` + `workout-reminder` (все `0 * * * *`, симметричное fuzzy-окно ±30 мин в локальном времени, круговое сравнение — слоты через полночь; dedup in-memory `(user, kind/type, local_date)`); `anomaly-check` (`*/30 * * * *`) — 4 порога (сон <5ч / отбой >02:00; калории >125% цели; шаги <50% 7-дневной медианы после 18:00 при ≥3 днях; вес ±2.5%/±1 кг, ≥3 измерений) с rate-limit 1 алерт/тип/юзер×день; текущий день — из `raw_samples`/`food_entries` (агрегата текущего дня нет, §12.3), цель — `lib/calories`; `lib/proactive-send` (429-backoff), `lib/today-vitals` (снимок дня + факты утра). Unit-тесты (+63, всего 249). Авто-верифицировано: typecheck, `eve build`, manifest (8 schedules + 20 tools), vitest. **Не авто-верифицировано** (нужны docker-БД + туннель + реальный бот) — см. checklist в журнале. |
| **5** | Тренировочная программа (wger + адаптация) | ✅ завершена | [`PHASE-5.md`](./phases/PHASE-5.md) | `lib/wger.ts` (свои tools с прямыми fetch — §20.4 закрыт: `/exerciseinfo/` с фильтрами + карточка со ВСЕМИ переводами; RU-приоритет (language id динамически, fallback 5), EN — сырье для LLM-перевода; таймаут 15с/попытка, retry 429/5xx/сеть, кэш таксономий/языков in-process); `lib/program-store.ts` (новая version одной транзакцией, plan = строки `program_sessions`, pure-хелперы слотов/масштабирования); tools `build-program` (catalog/search/save/apply_times; HITL-подтверждение workout_times Заменить/Оставить мои/Смешать), `reschedule` (move_once/move_weekly/lighten/rebuild; регулярный перенос синхронизирует workout_times), `log-workout` (completed/skipped/partial; upsert-семантика на дату); schedule `program-check` (`0 5 * * *`): незалогированные сессии/просроченные pending/≥2 skipped+partial → proactive-сессия с фактами → `reschedule`; разовый pending-пернос напоминается program-check'ом в его дату; workout-reminder обогащён упражнениями дня (best-effort). **Модель данных:** `workout_logs.status` += `'pending'` (PHASE-5 §5.4; SPECIFICATION §5.5 обновлена, новых миграций нет). Unit-тесты (+46, всего 302). Правки по ревью 2026-08-16 (P1: адопция pending при пересборке + поиск лога без фильтра версии; P2: повторный move_once по исходной дате, guard'ы «уже отмечено»/«не будущее», wger 429 → Retry-After). Авто-верифицировано: typecheck, `eve build`, manifest (23 tools + 9 schedules), vitest. **Не авто-верифицировано** (нужны docker-БД + туннель + реальный бот) — см. checklist в журнале. |
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

### 2026-08-16 — фаза 5 — правки по ревью (1 замечание P1, 3 замечания P2)

- **Что:** По итогам код-ревью фазы 5 исправлены 4 замечания. Авто-верификация
  после правок: `tsc --noEmit` чисто; `vitest run` — 302 теста (+4: 429 c
  Retry-After — пауза ровно из заголовка на fake timers (4.999с из 5 — вторая
  попытка ещё не началась), 429 без заголовка — пауза 2с (не 400мс);
  `pendingOriginFromNotes` — исходная дата из notes, включая суффикс-примечание
  и отрицательные случаи; `isFutureLocalDay` — строго позже сегодня);
  `eve build` проходит; манифест без изменений (23 tools + 9 schedules).
- **P1. Осиротевшие pending после пересборки программы.** Разовый перенос
  создавал pending под тогдашней `program_version`; после rebuild
  `log-workout` искал существующую строку с фильтром по АКТИВНОЙ версии →
  дата не в новой программе давала `day_not_in_program` (отметить нельзя
  вовсе), день программы — дубль-строку, а pending оставался навсегда;
  `program-check` (логи без фильтра версии) вечно считал его просроченным →
  незакрываемая ежедневная proactive-сессия. **Фикс (двойной):** (1)
  `saveProgramVersion` в той же транзакции перецепляет открытые
  `status='pending'` строки на новую версию — намерение «потренируюсь в дату
  X» переживает пересборку; (2) `log-workout` ищет существующую строку по
  `(user, scheduled_day)` БЕЗ фильтра версии (защита от любых рассинхронов
  версий). Историю (completed и пр.) это не трогает.
- **P2. Повторный move_once плодил вторую пару rescheduled+pending.** Lookup
  pending шёл только по `from_scheduled_day`; повторный перенос «от исходной
  даты» (pending уже сдвинут на другую дату) создавал дубль. **Фикс:**
  fallback-поиск pending по notes-паттерну `перенос с <from>%`; notes
  pending-строки ВСЕГДА хранит исходную дату сессии (сколько бы раз её ни
  двигали) — pure `pendingOriginFromNotes` (+`PENDING_ORIGIN_PREFIX` в
  program-store), дубли физически невозможны: повтор ищет и двигает ту же
  строку.
- **P2. Не было валидаций «день уже отмечен» и «дата в будущем/прошлом».**
  Теперь: `reschedule move_once` отказывает, если по `from_scheduled_day`
  есть лог completed/partial/skipped («переносить отмеченную нельзя»), и
  запрещает цель переноса в прошлом (`to < сегодня локально`; прошедшее
  отмечается через log-workout); `log-workout` отказывает за будущую дату
  (`isFutureLocalDay`, сегодня включительно можно).
- **P2. wger 429 ретраился 4 раза с фиксированными задержками как 5xx.**
  **Фикс:** при 429 пауза = `Retry-After` (секунды или HTTP-date, cap 30с),
  без заголовка — отдельная таблица [2с, 8с, 20с] вместо [400мс, 1.2с, 3.6с];
  5xx/сеть — как раньше. Лог `wger-retry-wait` с `delay_ms`.
- **Затронутые файлы:** `agent/lib/{program-store,wger}.ts`,
  `agent/tools/training/{reschedule,log-workout}.ts`;
  `tests/{wger,program-store}.test.ts`.
- **Спека:** поведение в рамках PHASE-5 §5.3–5.4 (валидация scheduled_day,
  контракт разового переноса уточнён: notes-формат «перенос с YYYY-MM-DD» —
  часть контракта pending-строки); SPECIFICATION/PHASE-5 текстово не
  правились — решения зафиксированы здесь.
- **Состояние проекта:** фаза 5 завершена + ревью-правки внесены. Фаза 6 не
  начата.
- **Коммит:** _не коммичено._

### 2026-08-15 — фаза 5 — завершена реализация тренировочной программы (wger + адаптация)

- **Что:** Реализована фаза 5 целиком по `PHASE-5.md`. wger-интеграция собственными
  tools с прямыми fetch (§6.3/§20.4 — вопрос закрыт: OpenAPI-коннекция не
  понадобилась); построение/сохранение программы (новая `version` одной
  транзакцией, план = строки `program_sessions`); наполнение
  `reminder_settings.workout_times` с HITL-подтверждением (Заменить / Оставить
  мои / Смешать); отметка выполнения (completed/skipped/partial); перенос
  (разовый/регулярный с обязательным sync `workout_times`), облегчение,
  пересборка; ежедневный триггер адаптации `program-check` (незалогированные
  сессии / просроченные разовые переносы / ≥2 skipped+partial за 7 локальных
  дней → proactive-сессия с готовым блоком фактов → агент решает и зовёт
  `reschedule`); напоминание о тренировках фазы 4 обогащено упражнениями дня.
- **Авто-верификация (✅):** `tsc --noEmit` чисто; `vitest run` — 298 тестов
  зелёных (+42: wger — stripHtml/нормализация exerciseinfo с RU-приоритетом
  переводов, fetch-mock контракты (фильтры category/equipment/language=2/
  limit/offset в URL, кэш /language/ — один запрос на процесс,
  таймаут-сигнал на попытку, retry 5xx с backoff на fake timers, сеть →
  wger_unavailable, 404 → not_found без ретраев, не-JSON → parse, таксономии
  кэшируются); program-store — dayOfWeekOf, normalizeSlots (валидация/дедуп/
  сортировка), mergeSlots, moveSlotsDay (коллизии схлопываются; нет слотов →
  []), scaleSets/scaleRepsText ('8-12', en-dash, '30s', 'до отказа', clamp);
  program-check — окно 8 дней через месяц, незалогированные дни (rescheduled
  считается отметкой), guard «до создания версии», ≥2 skipped+partial,
  просроченный/сегодняшний pending, блок фактов и промпт (инструменты,
  правило перевода, тон); промпт workout-reminder с планом и без).
  `eve build` проходит; манифест подтверждает 23 tools (+`build-program`,
  `reschedule`, `log-workout`) и 9 schedules (`program-check` cron
  `0 5 * * *`, прежние 8 не тронуты).
- **Не авто-верифицировано (checklist для автора; нужны docker-БД + туннель +
  реальный бот + доступ к wger.de):** (1) `docker compose up -d postgres` +
  `npm run db:migrate` (новых миграций нет); (2) `npm run dev` + туннель;
  (3) в чате: «составь программу тренировок 3 раза в неделю дома» →
  `build-program` catalog → search → показать план на русском (перевод LLM;
  проверить, что упражнения не выдуманы — id из wger) → save → при наличии
  своих workout_times — вопрос с кнопками → apply_times; (4) проверить в БД:
  новая строка `workout_programs` (active=true), прежняя active=false,
  `program_sessions` по дням, `reminder_settings.workout_times` =
  [{day_of_week, local_time}]; (5) «сделаю в четверг» → `reschedule`
  move_once → два лога (rescheduled+pending), workout_times не изменились;
  «перенеси постоянно на чт» → move_weekly → program_sessions и workout_times
  переехали; «сделай полегче» → lighten (sets/reps масштабировались);
  (6) `log-workout` отметить сегодня (день программы) → лог; не-день
  программы → friendly-ошибка; (7) подготовить отставание (не отмечать
  прошлый день программы / добавить skipped+partial) → `curl -X POST
  …/dev/schedules/program-check` → сообщение с фактами и предложением
  адаптации в tone-пресете; повторный запуск в тот же день — пусто (dedup);
  (8) дождаться слота workout_times → напоминание содержит упражнения дня
  по-русски; (9) wger-деградация (отключить сеть) → friendly
  «база упражнений недоступна», построение не валится молча; (10) эвал
  перевода (не блокирующий DoD, §18.3): ≥30 упражнений разных групп — ≥90%
  корректных, ≤5% критических ошибок.
- **Затронутые файлы/артефакты (создано/изменено):**
  - Либы: `agent/lib/wger.ts` (REST-клиент: retry/таймауты, нормализация,
    RU-приоритет переводов, кэш таксономий/языков, `wgerErrorPayload`),
    `agent/lib/program-store.ts` (сохранение версий в транзакции,
    workout_times-хелперы, `saveProgramFromParams` общий для
    build-program/rebuild, `usersWithActiveProgram`, move/lighten),
    `agent/lib/program-check.ts` (сбор фактов + pure `analyzeProgram` +
    промпт-билдеры).
  - Tools: `agent/tools/training/{build-program,reschedule,log-workout}.ts`.
  - Schedule: `agent/schedules/program-check.ts`; изменён
    `agent/schedules/workout-reminder.ts` (блок «План на сегодня» best-effort).
  - Прочее: `agent/lib/alert-dedup.ts` (+`programCheckKey`),
    `agent/lib/db/schema.ts` (комментарий статусов workout_logs),
    `agent/instructions.md` (фаза 5: возможности, таблица tools, раздел
    «Тренировочная программа» с правилом перевода, обновлён bullet
    workout-reminder).
  - Тесты: `tests/{wger,program-store,program-check}.test.ts`;
    `tests/proactive-prompts.test.ts` (+кейс плана).
  - Конфиг/модель данных: НОВЫХ таблиц/миграций/env/зависимостей нет;
    семантика `workout_logs.status` расширена значением `'pending'`
    (см. «Принятые решения» п.2 и SPECIFICATION §5.5).
- **Принятые решения и отклонения от спецификации:**
  1. **wger: свои tools подтверждены достаточными (§20.4 закрыт).** Контракт
     сверен с живым API (2026-08-15): список `/exercise/` отдаёт БЕЗ имён —
     поиск идёт по `/exerciseinfo/` с фильтрами (category/equipment/language)
     и вложениями (translations), карточка `/exerciseinfo/{id}/` — со всеми
     переводами. RU ≈1% подтверждён: приоритет готового wger-RU (language id
     из `/language/`, fallback 5) → EN (агент переводит на лету; правило
     зашито в instructions.md и промпты program-check/workout-reminder).
  2. **`workout_logs.status` += `'pending'`** (санкционировано PHASE-5 §5.4
     «pending-семантикой», в глобал не входил): разовый перенос = лог
     исходного дня (`rescheduled`, performed_at=now) + лог новой даты
     (`pending`). `pending`-строка закрывается `log-workout`'ом по новой дате
     (update, не insert). SPECIFICATION §5.5 обновлена синхронно; DDL не
     менялся (колонка text).
  3. **Разовый vs регулярный перенос — контракт §5.4 реализован буквально:**
     move_once не трогает `program_sessions`/`workout_times` (регулярное
     расписание то же); повторный перенос двигает существующую pending-строку
     (не плодит пары). Регулярный move_weekly правит `program_sessions`
     (sort_order за существующими строками целевого дня) И `workout_times`
     (слоты from_dow → to_dow; слотов не было — не изобретаем). Разовое
     напоминание в новую дату шлёт `program-check` (pending на сегодня —
     всегда в промпте): точное время разовой даты не настраивается — cron
     ежедневный (05:00 UTC); для family-of-2 (Москва, 08:00 локально)
     приемлемо, при других tz пересмотреть.
  4. **`log-workout` — upsert-семантика на дату:** повторная отметка той же
     (user, program_version, scheduled_day) обновляет последнюю строку
     (перезапись статуса/notes), а не плодит дубли; pending-строка закрывается
     тем же путём. Валидация даты: день недели программы ИЛИ существующий
     pending на эту дату (разовый перенос) — иначе friendly-ошибка.
  5. **Подтверждение workout_times (§5.2):** build-program save всегда
     сохраняет программу (это безопасно), а времена — только при пустых
     текущих; при непустых возвращает `needs_confirmation` и модель спрашивает
     `ask_question` (replace/keep/merge) → `apply_times`. Единая точка
     применения времён — `build-program` action='apply_times' (и после
     `reschedule` rebuild — hint в ответе инструмента).
  6. **`program-check` срабатывает при:** незалогированные дни программы ≥1,
     просроченные pending ≥1, или ≥2 skipped+partial за 7 локальных дней;
     плюс отдельный триггер «разовая тренировка сегодня» (без отставания).
     «Незалогированный» день = день недели активной версии ПОСЛЕ её создания
     без единого лога (лог любого статуса, включая rescheduled, считается
     отметкой — перенос учтён своей pending-строкой). Dedup
     `(user, program-check, local_date)` in-memory (паттерн §9), ключ после
     успешной доставки.
  7. **workout-reminder обогащён планом дня** (сверх таблицы §3 PHASE-5,
     смыкает DoD «напоминания по программе работают»): упражнения
     `program_sessions` этого дня недели попадают в промпт (EN + sets/reps,
     модель переводит); сбор best-effort — сбой чтения не блокирует
     напоминание (ветка «не выдумывай» сохранена для юзеров без программы).
  8. **Эвал перевода (§18.3) не блокирующий** — checklist п.10 выше;
     scripts/evals не заводился (ручная выборка достаточна для v1).
- **Спека:** Фаза реализована по `PHASE-5.md` и `SPECIFICATION.md` §5.5/§5.6/
  §6.3/§8/§9/§11.4/§16/§18.3/§20.4. Изменение модели: §5.5 `workout_logs.status`
  += 'pending' (синхронно внесено в SPECIFICATION.md); §20.4 помечен решённым.
  Уточнения (выше): п.1 контракт wger, п.2 pending, п.3 механика переносов,
  п.4 upsert log-workout, п.5 apply_times, п.6 условия program-check, п.7
  обогащение напоминания.
- **Состояние проекта:** фаза 5 завершена и авто-верифицирована. Фаза 6 не
  начата.
- **Коммит:** _не коммичено._

### 2026-08-15 — фаза 4 — правки по ревью (2 замечания P1, 4 замечания P2)

- **Что:** По итогам код-ревью фазы 4 исправлены 6 замечаний. Авто-верификация
  после правок: `tsc --noEmit` чисто; `vitest run` — 256 тестов (+7: секунды
  >59 в parseHHMMToMinutes/normalizeHHMM, deriveWeightInput — свежесть по
  локальному дню (утро/вечер/позавчера), guard базиса (3 строк total → null),
  интеграция derive→check, pruneStaleSentKeys с запасом на локальные даты);
  `eve build` проходит; манифест: 8 schedules + 20 tools (без изменений).
- **P1-1. Свежесть взвешивания — по локальному дню (§12.1), не по абсолютным
  24ч.** `isFresh = measuredAt >= now − 24h` расходился с обещанным
  «сегодня/вчера»: вчерашнее утреннее взвешивание при проверке в 09:30 (25+ч
  старины) отбрасывалось → алерт о скачке веса молча не срабатывал весь день.
  **Фикс:** логика вынесена в pure `deriveWeightInput(rows, tz, today)`
  (`lib/anomalies.ts`): свежесть = `localDay(measuredAt, tz) ∈ {today,
  previousDay(today)}`; unit-тестируется (добавлен экспорт `previousDay` в
  `lib/time.ts`, приватная копия в today-vitals убрана).
- **P1-2. Guard «минимум 3 измерений» — на БАЗИСЕ медианы (§11.5: «медиана
  последних 7 измерений (минимум 3)»).** Было: `rows.length >= 3` включал
  свежее измерение → при ровно 3 строках медиана считалась из 2 значений.
  **Фикс:** `deriveWeightInput` требует `slice(1).length >=
  WEIGHT_MIN_MEASUREMENTS` (итого ≥4 строк); докстринг константы уточнён.
- **P2-3. `buildMorningFacts` — лёгкий путь.** Вызывал `buildTodayVitals`
  (еда/шаги/активность/цель + расчёт калорий), используя только `.sleep`.
  **Фикс:** выделен `readLastNightSleep` (один readPeriod по ["sleep"]);
  утренний факт-сбор больше не считает калории.
- **P2-4. Секунды в слотах:** `"08:00:99"` парсился как 480 (невалидные
  секунды игнорировались). **Фикс:** общий `parseTimeParts` с проверкой
  hh≤23/mm≤59/ss≤59 в `parseHHMMToMinutes` и `normalizeHHMM`.
- **P2-5. Прун dedup-ключей — запас на локальные даты.** Cutoff считался от
  UTC-даты, а ключи датированы локальными датами юзеров (могут опережать UTC
  на сутки) → свежий ключ мог вычиститься около полуночи. **Фикс:**
  `pruneStaleSentKeys(now)` — cutoff = UTC − (keep 2 + запас 1) суток;
  авто-прун из `markKeySent` ходит через него.
- **P2-6. Дублирование форматирования часов:** локальный `hoursStr` в
  anomalies.ts и инлайн-выражение в daily-morning.ts заменены на
  `minutesToHoursStr` из `lib/weekly-digest.ts` (та же формула).
- **Затронутые файлы:** `agent/lib/{time,anomalies,today-vitals,fuzzy-window,
  alert-dedup}.ts`, `agent/schedules/daily-morning.ts`;
  `tests/{fuzzy-window,anomalies,alert-dedup}.test.ts`.
- **Спека:** поведение приведено к PHASE-4 §5.4 / SPECIFICATION §11.5/§12.1
  («сегодня/вчера», «медиана (минимум 3)»); уточнений спеки не требуется.
- **Состояние проекта:** фаза 4 завершена + ревью-правки внесены. Фазы 5–6
  не начаты.
- **Коммит:** _не коммичено._

### 2026-08-15 — фаза 4 — завершена реализация проактивных сообщений (напоминалки, workout, anomaly-check)

- **Что:** Реализована фаза 4 целиком по `PHASE-4.md`. Пять новых schedules:
  `daily-morning`/`daily-midday`/`daily-evening` (cron `0 * * * *` — fuzzy-сверка
  слота ±30 мин в ЛОКАЛЬНОМ времени юзера при каждом тике; почему почасовой, а не
  разовый — §9), `workout-reminder` (`0 * * * *` — сверка `workout_times`
  `[{day_of_week: 0=вс…6=сб, local_time}]` с локальным днём/временем),
  `anomaly-check` (`*/30 * * * *` — детектор аномалий §11.5). Все ходят от
  appAuth; per-user сообщения — dispatcher §9 (`userAuthFor` →
  `to(telegram,{chatId}).send`) с try/catch per-user (§16). Dedup/rate-limit —
  in-memory `(user, kind/type, local_date)`; ключ помечается ПОСЛЕ успешной
  доставки (сбой доставки не съедает напоминалку — следующий тик повторит).
- **Авто-верификация (✅):** `tsc --noEmit` чисто; `vitest run` — 249 тестов
  зелёных (+63: fuzzy-окно — парсинг HH:MM(:SS), локальные минуты/день недели,
  круговое сравнение через полночь, DoD-кейс «слот 18:15 на тике 18:00»,
  DST spring-forward/fall-back America/New_York, несуществующий слот 02:30;
  dedup-ключи/подавление/прун; anomalies — каждый порог ± и guard'ы (строгие
  неравенства, 18:00-гейт, ≥3 дней/измерений, день окончен, «нет данных»),
  detectAnomalies-шторм и пустой ввод; pickDueDaily/pickDueWorkout — окна,
  dedup, битые слоты, разные tz, два слота в день → одно напоминание;
  промпты всех 5 сессий). `eve build` проходит; манифест подтверждает 8
  schedules (`anomaly-check` `*/30 * * * *`, 4 почасовых, прежние 3 не тронуты)
  и 20 tools (новых tools нет — фаза чисто проактивная).
- **Не авто-верифицировано (checklist для автора; нужны docker-БД + туннель +
  реальный бот):** (1) `docker compose up -d postgres` + `npm run db:migrate`
  (новых миграций нет); (2) `npm run dev` + туннель; (3) настроить слоты
  (`set-reminders`: morning/midday/evening + `workout_times` на сегодня через
  ~5–50 мин от текущего времени); (4) дождаться ближайшего тика `:00` (или
  `curl -X POST …/dev/schedules/daily-morning` в окно слота) → в Telegram:
  напоминание в tone-пресете; повторный вызов в ту же локальную дату — пусто
  (dedup); (5) `dev/schedules/workout-reminder` в окно workout-слота →
  напоминание о тренировке; (6) anomaly-check: подготовить данные под порог
  (напр. `log-food` > target×1.25 за сегодня, или `add-manual-data` сон <5ч
  прошлой ночью) → `curl …/dev/schedules/anomaly-check` → алерт с фактами;
  повторный запуск в тот же день — пусто (rate-limit); (7) проверить, что
  «нет данных» не алертит и не спамит; (8) риск §8 PHASE-3 «tone в
  scheduled-сессии» — проверить тон именно напоминалок/алертов; (9) на VPS:
  почасовые тики под systemd не накладываются (4 schedules в минуту 0 —
  Nitro cron секвенционен в одном процессе, family-of-2 — ок).
- **Затронутые файлы/артефакты (создано/изменено):**
  - Либы: `agent/lib/fuzzy-window.ts` (парсинг HH:MM(:SS), локальные
    минуты/день недели, круговое fuzzy-окно ±30), `agent/lib/alert-dedup.ts`
    (in-memory dedup + прун по дате в ключе), `agent/lib/proactive-send.ts`
    (`sendProactiveWithRetry` — 429 → backoff 1с/2с, ≤3 попыток; 403 не
    ретраится — канал сам ставит `users.blocked`), `agent/lib/today-vitals.ts`
    (снимок текущего дня: `readPeriod` aggregate→raw, `food_entries`,
    `lib/calories`; + факты утра «ужин записан?/взвешивался?»),
    `agent/lib/anomalies.ts` (пороги-константы, pure-проверки,
    `collectAnomalyInputs`, `detectAnomalies`, `anomaliesPromptBlock`),
    `agent/lib/daily-reminders.ts` (запрос users⋈reminder_settings для
    онборженных не-blocked + pure `pickDueDaily`/`pickDueWorkout`).
  - Schedules: `agent/schedules/{daily-morning,daily-midday,daily-evening,
    workout-reminder,anomaly-check}.ts` (каждый — pure prompt-билдер +
    dispatcher + изоляция per-user + логи §15).
  - Инструкции: `agent/instructions.md` (раздел «Текущие возможности (фаза 4)»
    + новый раздел «Проактивные сообщения (фаза 4)»: данные уже в промпте,
    без вопросов, тон, вес — информационно).
  - Тесты: `tests/{fuzzy-window,alert-dedup,anomalies,daily-reminders,
    proactive-prompts}.test.ts`.
  - Конфиг/модель данных: БЕЗ изменений (новых таблиц/миграций/env/зависимостей
    нет; `reminder_settings`, `users.blocked` из фазы 0 наполняются).
- **Принятые решения и отклонения от спецификации:**
  1. **Новые lib-файлы сверх таблицы §3 PHASE-4** (`fuzzy-window`, `alert-dedup`,
     `proactive-send`, `today-vitals`, `daily-reminders`) — по прецеденту фаз 1–2
     (вынос чистой логики из schedules для тестируемости); состав артефактов
     фазы не меняет, `anomalies.ts` из спеки — на месте.
  2. **Dedup-ключ помечается после успешной доставки**, а не при выборе
     (уточнение §5.1 п.3): сбой доставки/БД → напоминалка повторится на
     следующем тике того же дня (лучше дубля-после-рестарта, чем пропуска —
     в духе признанного компромисса §8).
  3. **«Поздний отбой» квантифицирован** (спека давала только `> "02:00"`):
     поздним считается bedtime в интервале (02:00, 12:00) локального времени —
     вечерний отбой (20:00–23:59) и «до двух» (00:00–02:00) не алертим,
     дневные аномалии (12:00+) не алертим (выбросы/дневной сон, не «поздно
     лёг»). Строгое `>` — 02:00 ровно не алертит.
  4. **Morning-напоминание обогащено фактом** (в рамках «внести ужин/
     взвеситься», §9): если вчерашний ужин записан и взвешивание есть — модель
     шлёт короткое «доброе утро» (+сон) вместо бессмысленного напоминания;
     факты собирает `buildMorningFacts` (еда ≥17:00 вчера, `weight_log` с
     начала вчерашнего дня).
  5. **Аномалии склеиваются в одно сообщение** (все свежие типы одним
     алертом); rate-limit остаётся per-type — на следующий день или после
     рестарта тип, отправленный сегодня, не повторится в эту дату.
  6. **Сон за прошлую ночь** читается через `readPeriod([today], ["sleep"])`
     (prefers `daily_aggregates` → raw on-the-fly) — безопасно: ingestion
     гарантирует валидные `bed_at`/`wake_at` (normalize.ts), незавершённых
     сессий в `raw_samples` не бывает.
  7. **Edge (принят, соответствует спеке):** слот в пределах ±30 мин от
     полуночи в tz со сдвигом :30 может сработать дважды (окно пересекает
     полночь, dedup-ключи — разные локальные даты). Для :00-offset tz (все
     текущие юзеры) дубль невозможен: окно 61 мин содержит ровно один тик :00,
     либо два тика одной даты подавляются dedup.
  8. **Инструкции модели:** все proactive-сессии фазы 4 получают готовый блок
     данных в промпте (digest-подход фазы 3 — числа не транскрибируются через
     LLM); `get-*` tools в них не требуются.
- **Спека:** Фаза реализована по `PHASE-4.md` и `SPECIFICATION.md` §5.6/§8/§9/
  §11.5/§12.1/§12.3/§15/§16/§18.1. Отклонений от архитектуры нет; уточнения:
  новые lib-файлы (п.1), dedup после доставки (п.2), интервал позднего отбоя
  (п.3), morning-обогащение (п.4), склейка алертов (п.5), midnight-edge (п.7).
  SPECIFICATION.md текстово не правился — решения зафиксированы здесь.
- **Состояние проекта:** фаза 4 завершена и авто-верифицирована. Фазы 5–6
  не начаты.
- **Коммит:** _не коммичено._

### 2026-08-15 — фаза 3 — завершена реализация недельного отчёта + графиков + tone в деле

- **Что:** Реализована фаза 3 целиком по `PHASE-3.md`. Schedule `weekly-report`
  (cron `0 10 * * 1` UTC) с dispatcher-паттерном §9 (loop по онборженным
  не-blocked юзерам → `userAuthFor` → `to(telegram,{chatId}).send(prompt,
  {auth})`, try/catch per-user); tool `render-chart` (сон/вес/шаги/калории →
  PNG локально через `chartjs-node-canvas` → отправка юзеру прямым
  multipart `sendPhoto`); динамическая инструкция `user-context.ts` дополнена
  трендами недели; 403-детект → `users.blocked` (канал + sendPhoto);
  429-обработка с экспоненциальным backoff и respect `retry_after`.
- **Авто-верификация (✅):** `tsc --noEmit` чисто; `vitest run` — 186 тестов
  зелёных (+49: завершённые локальные дни с tz-границами, суммаризаторы
  digest — средние только по дням с данными, тренд сна vs предыдущая неделя,
  порог N=4, trend-строки и digest-блок промпта, промпт отчёта; fetch-mock
  контракты sendPhoto — multipart-поля/Blob, 429 c retry_after и backoff
  1с/2с/4с + cap 15с, 403 без ретраев, сеть→network, не-JSON 200; маппинг
  ChartSpec по kind + weight-guard <2 точек + легенда только при 2 датасетах;
  интеграционный PNG-рендер реальных спек через canvas); `eve build` проходит;
  манифест подтверждает 20 tools (+`report-render-chart`) и 3 schedules
  (`weekly-report` cron `0 10 * * 1`); PNG-рендер проверен ИЗ СОБРАННОГО
  бандла `.output` (нативный `canvas` резолвится из node_modules в рантайме).
- **Не авто-верифицировано (checklist для автора; нужны docker-БД + туннель +
  реальный бот + Linux VPS):** (1) `docker compose up -d postgres` +
  `npm run db:migrate` (новых миграций нет); (2) `npm run dev` + туннель +
  `TELEGRAM_BOT_TOKEN`; (3) наполнить данные (mock-forwarder фазы 1, еда
  фазы 2, пара взвешиваний через update-profile); (4)
  `curl -X POST http://localhost:2000/eve/v1/dev/schedules/weekly-report`
  → в Telegram: текст отчёта в tone-пресете юзера (риск §8 «tone в
  scheduled-сессии» — проверить именно здесь) + 1–2 PNG (сон; вес при ≥2
  взвешиваниях); (5) в чате «покажи график калорий» → `render-chart`
  интерактивно; (6) заблокировать бота → повторный запуск weekly-report:
  `users.blocked=true` в БД, лог `user-blocked-403`, юзер пропускается в
  следующих запусках; (7) на VPS: `npm ci && npm run build && npm start` под
  systemd — рендер canvas под Linux без X-сервера (риск §8), рестарт-стойкость.
- **Затронутые файлы/артефакты (создано/изменено):**
  - Либы: `agent/lib/weekly-digest.ts` (digest недели: pure-суммаризаторы +
    DB-обёртка + trend-строки + prompt-блок), `agent/lib/chart-config.ts`
    (pure ChartSpec-конфиги), `agent/lib/telegram-send.ts` (`sendPhotoBytes`
    + классификация ошибок + `telegramHttpStatusFromError`),
    `agent/lib/tenant.ts` (+`markBlockedByChatId`).
  - Tool: `agent/tools/report/render-chart.ts` (ленивый dynamic import
    canvas, данные читает сам, friendly-фолбэки §16).
  - Schedule: `agent/schedules/weekly-report.ts` (dispatcher + pure
    `buildWeeklyReportPrompt`).
  - Канал: `agent/channels/telegram.ts` (override `message.completed`:
    дефолтная доставка + 403→blocked).
  - Инструкции: `agent/instructions.md` (фаза 3, `render-chart` в таблице,
    раздел «Недельный отчёт»), `agent/instructions/user-context.ts` (тренды
    недели с in-memory TTL-кэшем 10 мин; сбой трендов не ломает turn).
  - Тесты: `tests/{weekly-digest,telegram-send,chart-config,
    weekly-report-prompt,chart-render}.test.ts`.
  - Конфиг: `package.json` (+`chartjs-node-canvas@^5.0.0`, +`chart.js@^4.5.1`;
    транзитивно нативный `canvas@^3`). Новых env-переменных и миграций НЕТ.
- **Принятые решения и отклонения от спецификации:**
  1. **`sendPhoto` — прямой multipart-fetch к Bot API** (`lib/telegram-send.ts`),
     не через eve-канал. Причины (сверено с `node_modules/eve/dist`):
     `ToolContext` не экспонирует telegram-хендл; исходящие вложения в
     message-stream не поддерживаются; JSON-хелпер eve (`callTelegramApi`)
     не принимает бинарные тела. Node 24 имеет нативные `FormData`/`Blob` —
     зависимостей не добавлено. PHASE-3 §5.3 «PNG → sendPhoto» — реализовано
     буквально, механизм уточнён.
  2. **Digest-driven промпт.** Schedule собирает дайджест недели кодом
     (`lib/weekly-digest.ts` — единый источник для промпта, user-context и
     render-chart) и встраивает в промпт proactive-сессии; модель —
     анализ/выводы/тон (§11.1 «Выводы и советы — анализ LLM»), числа НЕ
     транскрибируются через LLM (антигаллюцинационный барьер). `get-*` tools
     остаются доступны в сессии для уточнения (`requireUser` внутри
     синтезированного auth работает — риск §8 dispatcher закрыт архитектурно:
     `turn.started` динамических инструкций получает `attributes.chat_id`).
  3. **403-детект текстовой доставки — override `message.completed` в
     канале.** eve бросает `Error("Telegram sendMessage failed with HTTP
     403.")` — статус достаётся парсером `telegramHttpStatusFromError`
     (единственная точка, полагающаяся на формат текста ошибки). Override
     повторяет дефолтную доставку (skip tool-calls/пустых; post текста),
     при 403 помечает `users.blocked` + info-лог + гасит ошибку (доставлять
     некому); прочие ошибки — пробрасываются как в дефолте. Фаза 4
     переиспользует флаг во всех schedules.
  4. **429: минимум по спеке — только для sendPhoto** (retry ≤4,
     `parameters.retry_after` приоритетнее backoff 1с/2с/4с, cap 15с).
     Доставка текста через eve (`telegram.post`) ретраев не имеет — при
     family-of-2 (2–3 сообщения раз в неделю) rate-limit недостижим; при
     масштабировании усилить в dispatcher фазы 4.
  5. **График веса — окно 30 дней** (не 7): недельного окна почти всегда <
     2 взвешиваний (guard `no_data`), тренд веса на месячном окне осмыслен.
     Прочие виды — 7 завершённых дней по умолчанию. Дни без записей еды на
     calories-графике — пропуск (null), не 0 («не записывал» ≠ «0 ккал»).
  6. **`ChartSpec` — собственный чистый тип** (без импорта chart.js в
     lib): маппинг данных → датасеты unit-тестируется без canvas; cast к
     `ChartConfiguration` — одна точка в tool, совместимость валидируется
     интеграционным тестом рендера. Canvas грузится ленивым dynamic import
     (нет side effects при `eve build`).
  7. **Завершённые дни** — новый helper `completedDaysList` (вчера и старше
     по `users.timezone`); существующие `get-*` tools (окно «включая сегодня»)
     не менялись.
  8. **TTL-кэш digest в `user-context.ts`** (10 мин, in-memory, паттерн §9):
     `turn.started` не делает полный digest-запрос на каждый turn; сбой
     трендов тихо пропускается (интерактивный чат важнее).
- **Спека:** Фаза реализована по `PHASE-3.md` и `SPECIFICATION.md` §4/§8/§9/
  §11.1/§11.3/§13/§16/§18.3. Отклонений от архитектуры нет; уточнения:
  механизм sendPhoto (п.1), digest-промпт (п.2), парсинг текста ошибки eve
  для 403 (п.3), окно weight-графика (п.5). SPECIFICATION.md текстово не
  правился — решения зафиксированы здесь.
- **Состояние проекта:** фаза 3 завершена и авто-верифицирована. Фазы 4–6
  не начаты.
- **Коммит:** _не коммичено._

### 2026-08-14 — фаза 2 — правки по ревью (2 замечания P1)

- **Что:** По итогам код-ревью фазы 2 исправлены 2 замечания P1. Авто-верификация
  после правок: `tsc --noEmit` чисто; `vitest run` — 137 тестов (+7: классификация
  ошибок getAppToken через fetch-mock, presence таймаут-сигнала в контрактах,
  маппинг fsErrorPayload); `eve build` проходит.
- **1. Таймауты на ВСЕ fetch к FatSecret.** `fetchWithRetry`,
  `fetchRequestToken`, `fetchAccessToken`, `getAppToken` вызывали fetch без
  сигнала — Node fetch не имеет дефолтного таймаута, зависший FatSecret вешал
  tool-вызов/ночной sync навсегда. **Фикс:** `FS_FETCH_TIMEOUT_MS = 15_000`
  (экспорт из `lib/fatsecret-oauth.ts`), `AbortSignal.timeout(...)` на каждую
  попытку (retry получает свежий сигнал; сигнал покрывает и чтение тела —
  `res.text()/json()`). TimeoutError попадает в catch → ретрай → после
  исчерпания `FsApiError('network')` → friendly fs_unavailable. OFF-фолбэк
  уже имел 8с — не тронут.
- **2. Классификация ошибок `getAppToken` (и oauth-flow fetch'ей).** Любой
  не-OK статус сваливался в `FsOauthError('fs_not_configured')` — битые креды
  (401/400 invalid_client) сообщались юзеру как «отсутствуют
  FATSECRET_CLIENT_ID/SECRET»; сетевой сбой долетал сырым TypeError →
  fs_unexpected. **Фикс:** 400/401 → новый код `fs_auth_failed` («FatSecret
  отклонил ключи приложения»); прочие не-OK и сеть/таймаут → `fs_unavailable`;
  `fs_not_configured` остался только у `requireConsumer` (env реально пуст).
  Аналогично разведено в `fetchRequestToken` (401/403 → fs_auth_failed) и
  `fetchAccessToken` (сеть → fs_unavailable). `fsErrorPayload` переписан на
  `instanceof FsOauthError` (убран duck-typing) + friendly-сообщения для всех
  кодов. Сопутствующее: `complete-fatsecret` больше НЕ сбрасывает pending-флоу
  при ретраебельных сбоях (`fs_invalid_pin`, `fs_unavailable`) — юзер может
  повторить PIN в рамках TTL 15 мин (раньше сетевой сбой убивал флоу).
- **Затронутые файлы:** `agent/lib/fatsecret-oauth.ts` (+`FS_FETCH_TIMEOUT_MS`,
  классификация), `agent/lib/fatsecret-api.ts` (signal в `fetchWithRetry`,
  `fsErrorPayload`), `agent/tools/nutrition/complete-fatsecret.ts` (ретраебельные
  сбои); `tests/{fatsecret-oauth,fatsecret-api}.test.ts`.
- **Спека:** поведение §16 не нарушено, уточнено (виды ошибок разведены по
  кодам; таймауты — недостающая часть «сеть/FatSecret даун»). PHASE-2 §7
  (retry/backoff) — дополнено таймаутом на попытку.
- **Состояние проекта:** фаза 2 завершена + ревью-правки P1 внесены.
- **Коммит:** _не коммичено._

### 2026-08-14 — фаза 2 — завершена реализация FatSecret (OAuth) + food_entries + калории

- **Что:** Реализована фаза 2 целиком по `PHASE-2.md`. FatSecret-интеграция собственными
  tools с прямыми подписанными fetch'ами (не MCP, §6.2): поиск (OAuth 2.0
  client-credentials, app-токен в памяти процесса, refresh за ~1ч до истечения 24ч TTL,
  single-flight), запись/чтение дневника (OAuth 1.0a 3-legged PIN-flow через HITL),
  фолбэк штрихкодов (Open Food Facts); копии строк дневника в `food_entries`;
  гибридный расчёт калорий (вариант C) с cold-start fallback; schedule
  `sync-fatsecret-diary` (ежедневный upsert по `external_id` + удаление исчезнувших
  записей).
- **Авто-верификация (✅):** `tsc --noEmit` чисто; `vitest run` — 130 тестов зелёных
  (+56: OAuth 1.0a подпись на векторе RFC 5849 §3.4.1.1 + verified-эррата 2550,
  percent-encoding, epoch-days, нормализация FatSecret-ответов (object|array-кверки,
  meal other→snack, даты), fetch-mock контракты запросов (region=RU в теле, Bearer,
  OAuth-заголовок, date→epoch-days), OFF-парсер, entryToRowValues (consumed_at по
  каноническому meal-времени), calories (BMR, пороги фактора, бампы, cold-start, цели,
  полы, calorie_source), TTL pending-flow и окно refresh app-токена); `eve build`
  проходит; манифест подтверждает 19 tools (7 новых: nutrition-connect/complete-fatsecret,
  nutrition-log-food, nutrition-lookup-barcode, db-get-food, db-get-calorie-balance,
  goals-get-target-calories) + schedule `sync-fatsecret-diary` (cron `0 4 * * *`).
- **Не авто-верифицировано (checklist для автора; нужны реальные FatSecret-креды +
  туннель + docker-БД):** (1) зарегистрировать FatSecret-app (platform.fatsecret.com),
  взять `FATSECRET_CLIENT_ID/SECRET`; проверить, требует ли консоль whitelist IP VPS
  для oauth-эндпоинта; (2) `docker compose up -d postgres` + `npm run db:migrate`;
  (3) `npm run dev` + туннель; (4) в чате: «подключи FatSecret» → `connect-fatsecret`
  → открыть authorize URL → PIN → ответить боту → `complete-fatsecret` → строка в
  `fatsecret_tokens`; (5) `log-food`: поиск («овсянка») → проверить, что результаты
  русские (эффект region=RU — см. риск ниже) → details → log → строка в
  `food_entries` (source='fatsecret') и в приложении FatSecret; (6) `lookup-barcode`
  по реальному штрихкоду; (7) внести еду напрямую в приложение FatSecret →
  `curl -X POST …/dev/schedules/sync-fatsecret-diary` → upsert/удаление в
  `food_entries` (§17 dev-dispatch); (8) `get-target-calories` → оба числа
  (по боту/по часам), `get-calorie-balance` за 7 дней; (9) опционально: 401 (отозвать
  токен в FatSecret) → бот предлагает переподключение, токен помечен revoked_at.
- **Затронутые файлы/артефакты (создано/изменено):**
  - Либы: `agent/lib/fatsecret-oauth.ts` (подпись HMAC-SHA1 RFC 5849, PIN-flow,
    pending-флоу TTL 15 мин, app-токен кэш), `agent/lib/fatsecret-api.ts` (REST-клиент,
    retry/ошибки §16, нормализаторы, epoch-days), `agent/lib/calories.ts` (BMR +
    фактор + цели + DB-обёртка), `agent/lib/food-read.ts` (чтение food_entries за
    период), `agent/lib/time.ts` (+`localTimeToUtc`).
  - Tools: `agent/tools/nutrition/{connect-fatsecret,complete-fatsecret,log-food,
    lookup-barcode}.ts`, `agent/tools/db/{get-food,get-calorie-balance}.ts`,
    `agent/tools/goals/get-target-calories.ts`.
  - Schedule: `agent/schedules/sync-fatsecret-diary.ts`.
  - Инструкции: `agent/instructions.md` (фаза 2: питание, калории, PIN-flow, шаг 8
    онбординга теперь реальный), `agent/instructions/onboarding-guard.ts`.
  - Тесты: `tests/{fatsecret-oauth,calories,fatsecret-api}.test.ts`; `vitest.config.ts`
    (+env FATSECRET_* для fetch-mock).
  - Модель данных: БЕЗ изменений (таблицы `food_entries`/`fatsecret_tokens` из фазы 0
    наполняются); новых миграций и env-переменных нет.
- **Принятые решения и отклонения от спецификации:**
  1. **Подпись OAuth 1.0a — ручной HMAC-SHA1, без пакета `oauth-1.0a`** (риск PHASE-2
     §9 закрыт). ~40 строк в `lib/fatsecret-oauth.ts`, полностью unit-тестируема:
     base string воспроизводит пример RFC 5849 §3.4.1.1 посимвольно, подпись совпадает
     с корректной по verified-эррате 2550 (`r6/TJjbCOr97/+UU0NsvSne7s5g=`; сам RFC
     напечатал GET-подпись). Новых зависимостей нет.
  2. **PIN-flow HITL подтверждён** (риск §9 закрыт): built-in `ask_question` с
     `allowFreeform` — это и есть `input.requested` парковка из спеки (eve
     `docs/tools/human-in-the-loop.md`); turn паркуется durably, ответ юзера
     возобновляет его, модель зовёт `complete-fatsecret`. **Request-token держится в
     памяти процесса (TTL 15 мин), а НЕ в resume-значении park-хука** — секрет не
     должен проходить через контекст модели (§13). Рестарт процесса в окне PIN →
     юзер перезапускает подключение (тот же исход, что таймаут). Неверный PIN НЕ
     сбрасывает флоу (ретрай в рамках TTL).
  3. **Эндпоинты OAuth 1.0a — `authentication.fatsecret.com`** (актуальная дока
     FatSecret; старые `platform/rest`-URL'ы деприкейтед и отдавали 500). REST —
     `platform.fatsecret.com/rest/server.api`. Спека §6.2 хосты не фиксировала.
  4. **`food_entries.get_month` возвращает только дневные ИТОГИ** (не записи) —
     поэтому sync использует get_month (как в спеке) для поиска дней с записями, а
     построчно читает `food_entries.get` по каждому целевому дню. Целевые дни =
     {вчера, сегодня} ∪ дни месяца с записями ∪ дни, где у нас уже есть
     fatsecret-строки. Дополнительно к §18.2: записи, удалённые юзером в приложении,
     удаляются из нашей копии (reconciliation в пределах текущего месяца);
     manual/barcode_off-строки не трогаются никогда.
  5. **⚠️ Риск тира FatSecret: `region`/`language` (v1 foods.search/food.get) и
     `food.find_id_for_barcode` помечены в доках Premier-exclusive.** На free-тарифе
     параметры могут игнорироваться (деградация до US-базы, не ошибка) или метод
     штрихкода возвращать ошибку (→ сработает OFF-фолбэк, обработано). Параметры
     всё равно шлются всегда (принудительно из кода, `LOCALE_PARAMS` в
     `lib/fatsecret-api.ts`). Проверить на реальном app'е (checklist п.5–6).
  6. **Формула фактора активности квантифицирована** (спека §11.2 формулу не
     задавала): пороги по средним шагам/день (<5000→1.2, <7500→1.375, <10000→1.55,
     ≥10000→1.725) + бампы за active_minutes (≥30→+0.05, ≥60→+0.1) + слабый HR-
     модификатор (медиана resting_bpm ≥85 → +0.025); clamp [1.2, 1.9]; максимум
     дефицита/профицита 1100 ккал/день (~1 кг/нед); пол-минимум цели 1200/1500 ккал
     (применение флагается `floor_applied`). TDEE_часы = BMR + средние
     active_calories (§11.2 буквально).
  7. **Маркер перехода cold-start → реальные данные — in-memory** (`switched` в
     `computeCaloriePlanForUser`, возвращается `get-target-calories`; инструкция
     велят модели объявить переход). Паттерн §9 fuzzy-dedup: фиксирует только
     наблюдённый переход, рестарт сбрасывает тихо. Авторитетная проверка — в
     dispatcher фазы 4.
  8. **consumed_at при sync/логе:** FatSecret не отдаёт время приёма — канонические
     локальные времена по meal (09:00/13:00/19:00/16:00, `mealDefaultLocalTime`);
     атрибуция дня — по колонке `day`. meal на чтении: «other»→snack; на записи —
     «Breakfast» (формат из доки).
  9. **401 на user-level вызовах** (log-food action=log, sync) помечает токен
     `revoked_at=now()` + лог → модель/юзер направляются на переподключение (§16).
     OAuth-коды FatSecret 2–9 в JSON-теле приравнены к unauthorized.
  10. **Новые файлы сверх таблицы §3 PHASE-2:** `lib/fatsecret-api.ts` (REST-клиент
      вынесен из fatsecret-oauth.ts ради читаемости), `lib/food-read.ts` (общее чтение
      питания для get-food/get-calorie-balance/фазы 3). Состав артефактов фазы не
      меняет.
  11. **log-food manual-режим** (без FatSecret: source='manual'/'barcode_off') —
      заполняет семантику `food_entries.source` из §5.4 и покрывает случай
      неподключённого FatSecret.
- **Спека:** Фаза реализована по `PHASE-2.md` и `SPECIFICATION.md` §5.4/§5.7/§6.2/§8/
  §9/§11.2/§13/§16/§18.1–18.2. Отклонения/уточнения (выше): PIN-flow state в памяти
  (п.2), get_month+get комбо (п.4), Premier-риск region (п.5), квантификация формулы
  (п.6), in-memory switched-маркер (п.7), meal-времена (п.8), доп. файлы (п.10).
  SPECIFICATION.md текстово не правился — решения зафиксированы здесь; для §6.2
  стоит отразить эндпоинты authentication.fatsecret.com и Premier-риск при следующей
  ревизии спеки.
- **Состояние проекта:** фаза 2 завершена и авто-верифицирована. Фазы 3–6 не начаты.
- **Коммит:** _не коммичено._

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
