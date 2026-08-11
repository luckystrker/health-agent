# Фаза 1 — Phone-hub ingestion + хранение (raw + daily aggregates)

> Спецификация фазы. Источник правды — [`../SPECIFICATION.md`](../SPECIFICATION.md).
> Перед стартом — [`../../AGENTS.md`](../../AGENTS.md), текущее состояние в
> [`../STATUS.md`](../STATUS.md).

**Статус:** 🔲 не начата.

---

## 1. Цели и границы

### Что входит в фазу
- Custom channel `phone-hub.ts`: приём webhook'ов от forwarder'ов (Android/iOS),
  валидация Bearer-токена, нормализация payload, запись в `raw_samples`.
- Дедупликация по типу метрики (sleep upsert / bucket-метрики по `payload.bucket` /
  workout upsert) + payload-hash от ретраев forwarder'а.
- Онбординг устройства: выдача токена, URL webhook'а; ротация токена
  (`rotate-phone-hub-token`).
- Schedule `aggregate-raw` — схлопывание сырых сэмплов старше 30 дней в
  `daily_aggregates` (cutoff-snapshot, защита от гонок, per-`(user,day,metric)` txn).
- Schedule `daily-evening`-подобные — пока **не здесь** (фаза 4); здесь только ингест
  и агрегация.
- Логика агрегации (`lib/aggregates.ts`): sleep-through-midnight (дата = пробуждение),
  upsert при поздних сэмплах, формат `value` для каждого metric (§5.3).

### Что НЕ входит
- Напоминания/алерты на основе данных (sleep <5ч и т.п.) → **фаза 4**.
- Аналитика/отчёты/графики → **фаза 3**.
- Manual-ввод (`add-manual-data`) — здесь (как пишущий инструмент), но без сравнения с
  автоматическими. Уточнить: manual-data — нужен онбордингу (вес) и фазе 3; включить
  здесь как инфра-инструмент.

### Ключевое архитектурное решение фазы
Единый путь ingestion: **все** данные с часов приходят через phone-hub (Apple Health /
Health Connect → forwarder → наш webhook). Никаких прямых вендор-API, никаких
агрегаторов. Это унифицирует Amazfit и Huawei (§2, §6.1).

---

## 2. Зависимости

- **Фаза 0** — обязательна: `users`, `phone_hub_tokens`, `requireUser`, schema,
  БД-клиент, env (`PHONE_HUB_TOKEN_SALT`).

---

## 3. Создаваемые/изменяемые файлы

| Путь | Назначение | Спека |
|------|------------|-------|
| `agent/channels/phone-hub.ts` | `defineChannel`, `POST /eve/v1/phone-hub`, Bearer-токен, нормализация, запись в `raw_samples` | §6.1, §7.2 |
| `agent/lib/dedup.ts` | Дедупликация по типу метрики | §12.4 |
| `agent/lib/aggregates.ts` | raw → daily для каждого metric; sleep-through-midnight; upsert при поздних сэмплах | §5.3, §12.3 |
| `agent/schedules/aggregate-raw.ts` | Ежедневный джоб: cutoff-snapshot → upsert → delete | §9 (таблица), §12.3 |
| `agent/tools/db/get-sleep.ts` | Чтение сна за период (daily_aggregates + фолбэк на raw за последние дни) | §8 |
| `agent/tools/db/get-activity.ts` | Шаги/калории/HR за период | §8 |
| `agent/tools/db/get-workouts.ts` | Тренировки за период | §8 |
| `agent/tools/db/add-manual-data.ts` | Ручная фиксация сна/активности | §8, §12.2 |
| `agent/tools/settings/rotate-phone-hub-token.ts` | Ротация токена forwarder'а | §8, §12.5 |
| `dev/mock-forwarder/` | curl-скрипты: sleep, steps, HR, workout (для локального теста) | §17 |

> Таблицы `raw_samples` и `daily_aggregates` уже созданы миграциями фазы 0 — здесь
> только наполняются.

---

## 4. Таблицы БД

Уже созданы на фазе 0 (см. [`PHASE-0.md`](./PHASE-0.md), §4). На фазе 1 активно
используются:
- `raw_samples` — приём, дедуп, TTL 30 дней.
- `daily_aggregates` — результат `aggregate-raw`, формат `value` — §5.3.
- `phone_hub_tokens` — авторизация forwarder'ов, ротация.

Формат `value` дневных агрегатов (§5.3):
- `sleep`: `{ total_minutes, bedtime_local, wake_local, efficiency_pct, deep_min,
  light_min, rem_min, awake_min, source }`.
- `steps`: `{ total_steps, by_hour: [..24] }`.
- `heart_rate`: `{ resting_bpm, avg_bpm, min_bpm, max_bpm }`.
- `activity`: `{ active_calories_kcal, total_calories_kcal, active_minutes }`.
- `workouts`: `{ count, items: [{ type, duration_min, calories_kcal, start_local }] }`.

---

## 5. Детали реализации

### 5.1 Phone-hub webhook (`agent/channels/phone-hub.ts`)
- Маршрут `POST /eve/v1/phone-hub` через `defineChannel({ routes: [POST(...)] })` —
  свериться с актуальной eve-докой про custom channels.
- Авторизация: заголовок `Authorization: Bearer <token>` → hash
  `SHA-256(PHONE_HUB_TOKEN_SALT + token)` → поиск в `phone_hub_tokens.token_hash`.
  Сравнение — **constant-time**.
- Тело: нормализованный `{ device_label, metric, recorded_at, payload }`. Zod-схема по
  `metric`-типу.
- Лимит тела: 1 MB → 413 при превышении (§13, §16).
- Логика: валидация → дедупликация → запись в `raw_samples`. Инкрементальный агрегат в
  webhook'е **не считается** — агрегация идёт scheduled-джобом `aggregate-raw` (см. §5.3).
  Свежесть данных для алертов/сводок по текущему дню — из `raw_samples` напрямую (см. §12.3
  «Свежесть для anomaly-check»). При нормальном потоке **сообщений юзеру не отправляется**.
- Синтез principal для tool-вызовов (если нужны внутри channel) — §9.

### 5.2 Дедупликация (`agent/lib/dedup.ts`, §12.4)
По типу метрики:
- `sleep_session`: по `(user_id, metric, recorded_at)` с **upsert** — последняя версия
  границы выигрывает (одна ночь может прийти несколько раз с уточнением).
- Потоковые bucket-метрики (`steps` почасово, `heart_rate` минутно): по
  `(user_id, metric, recorded_at, payload.bucket)` — каждый bucket уникален.
- `workout`: по `(user_id, metric, recorded_at)` + upsert.
- payload-hash — дополнительная защита от точных дублей ретраев forwarder'а.

### 5.3 `aggregate-raw` (`agent/schedules/aggregate-raw.ts`, §12.3)
Алгоритм (без потерь при гонках, со свежими днями — **полная формулировка в §12.3, источник
правды**; здесь кратко):
1. Фиксируется snapshot-момент `now0 = now()`.
2. **Агрегация:** для каждого онборженного юзера, для каждого `(user_id, day, metric)`, где
   `day` — локальный день юзера, **полностью завершённый** к `now0` (`day < local_date(now0, tz)`;
   текущий день НЕ агрегируется — он ещё идёт), и для которого есть сырые сэмплы → вычислить
   агрегат, **upsert** в `daily_aggregates`. Перебираются **все** завершённые дни с сэмплами
   (не только старше 30 дней) — это держит агрегаты свежими (вчерашний день) и перевычисляет
   при поздних сэмплах. Сон — особый случай (агрегируется при наличии `wake_at`, `day` = дата
   пробуждения). Опциональная оптимизация: повторно агрегировать только дни с новыми сэмплами
   после `computed_at`.
3. **Удаление сырых (отдельный шаг, после агрегации):** `cutoff = now0 - interval '30 days'`;
   удалить сэмплы с `received_at < cutoff` (по `received_at`, не `recorded_at` — поздние
   сэмплы успеют попасть в агрегацию).
4. **Гранулярность транзакции:** per `(user_id, day, metric)`; агрегация и удаление — в
   разных транзакциях.

**Поздние сэмплы:** сэмпл, пришедший после офлайна и относящийся к уже агрегированному дню —
шаг 2 перевычислит агрегат (upsert), шаг 3 удалит, когда `received_at` уйдёт за cutoff.

Cron: `0 3 * * *` (§9).

> **Важно для фазы 4:** `daily_aggregates` всегда содержит завершённые дни до вчерашнего
> включительно; текущий день НЕ агрегирован. Anomaly-check и evening-сводка читают текущий
> день из `raw_samples` (фильтр по tz), а не из агрегата (см. §12.3 «Свежесть для
> anomaly-check» и [`PHASE-4.md`](./PHASE-4.md) §5.4).

### 5.4 Sleep-through-midnight (`agent/lib/aggregates.ts`, §12.1)
- Сон через полночь (лёг 23:30 → встал 07:00) относится к **дате пробуждения**.
- Длительность — по абсолютным timestamp'ам, не по разнице локальных часов (DST-safe).
- `bedtime_local`/`wake_local` — строки "HH:MM" в tz юзера; `day` = дата пробуждения.

### 5.5 Manual-data (`agent/tools/db/add-manual-data.ts`, §12.2)
- Парсер свободного текста: «спал 6ч, лёг 00:30, встал 06:30» → `sleep_session`.
- manual-запись имеет приоритет при отсутствии автоматических (но не перезаписывает
  реальные сэмплы).
- Пишет в `raw_samples` (source='manual' в payload) либо сразу в `daily_aggregates` —
  зафиксировать решение в STATUS.md при имплементации.

### 5.6 Ротация токена (`rotate-phone-hub-token`, §12.5)
- Tool инвалидизирует старый токен (удаляет `phone_hub_tokens` запись, `rotated_from` =
  старый hash), генерирует новый, выдаёт URL+токен.
- POST'ы со старым токеном → 401 (forwarder истощит ретраи).
- При нескольких устройствах одного бренда — каждое со своим `platform`+`device_label`.

---

## 6. Edge-cases (см. §12)

- **Поздние сэмплы после офлайна телефона** — попадают в `raw_samples`, подхватываются
  следующим `aggregate-raw` (cutoff по `recorded_at`). §12.2, §12.3.
- **Race-condition aggregate vs incoming** — cutoff-snapshot + per-`(user,day,metric)`
  транзакция. §12.3.
- **DST-переход во время сна** — длительность по абсолютным ts. §12.1.
- **Дубли от forwarder'а** — норма (info-лог, не warn). Дедупликация отлавливает. §15.
- **Невалидный payload** — 400 + warn-лог; forwarder перестанет ретраить этот payload. §16.
- **Неизвестный токен** — 401; forwarder истощит ретраи. §16.
- **Ошибка БД при insert** — 500 + error-лог; forwarder ретраит (дедуп отловит дубль). §16.

---

## 7. Критерии готовности

- [ ] `POST /eve/v1/phone-hub` принимает payload для всех metric-типов (sleep/steps/
      heart_rate/active_calories/workout); валидный токен → 200 + запись в
      `raw_samples`; невалидный токен → 401; невалидный payload → 400; тело >1MB → 413.
- [ ] Дедупликация корректна для каждого типа метрики (unit + integration): sleep upsert
      (последняя версия границ выигрывает), bucket-метрики по `payload.bucket`, workout
      upsert, payload-hash от ретраев.
- [ ] `aggregate-raw` на тестовой БД: cutoff-snapshot, upsert, удаление только по cutoff,
      изоляция сбоя per-`(user,day,metric)`. Поздние сэмплы перевычисляют агрегат.
- [ ] Sleep-through-midnight корректно относится к дате пробуждения; DST не ломает
      длительность.
- [ ] `rotate-phone-hub-token` генерирует новый токен, инвалидирует старый (старый → 401).
- [ ] `get-sleep`/`get-activity`/`get-workouts` читают из `daily_aggregates` с фолбэком
      на raw за последние дни.
- [ ] `add-manual-data` парсит типичные фразы и пишет корректно.
- [ ] `dev/mock-forwarder/` — набор curl-скриптов покрывает все metric-типы; локальный
      прогон пишет данные в dev-БД.
- [ ] Журнальная запись в STATUS.md о завершении фазы 1.

---

## 8. Риски и проверяемые гипотезы

- **Маппинг полей forwarder'ов → `raw_samples.payload`** (откр. вопрос §20.1):
  зафиксировать нормализованный формат payload для каждого metric исходя из того, что
  реально шлют Android `mcnaveen/health-connect-webhook` и iOS «Health Webhook». Нужен
  нормализующий слой в route-хендлере по `platform` (iOS-формат может отличаться).
- **Huawei Health → Health Connect** (откр. вопрос §20.2): исторически Huawei Health не
  нативно пишет в Health Connect; может потребоваться мост `Health Sync` (платный).
  Проверить при подключении жены.
- **Стабильность iOS-форвардера** (откр. вопрос §20.3): платный ($14.99) vs MIT self-build.
- **Покрытие метрик на iOS** (откр. вопрос §20.6): подтвердить, что iOS-форвардер отдаёт
  sleep-стадии (deep/rem/light), иначе аналитика сна на iOS будет беднее.
- **`defineChannel` + custom routes** — свериться с актуальной eve-докой, что сигнатура
  в спеке (§6.1) соответствует ^0.31.

---

## 9. Ссылки на спецификацию

- §2 Архитектура (поток данных, phone-hub).
- §5.3 Данные с часов — двухуровневое хранение, форматы `value`.
- §6.1 Носимые устройства — phone-hub (forwarder'ы, webhook, onboarding устройства).
- §7.2 Phone-hub webhook (channel).
- §8 Инструменты (get-sleep, get-activity, get-workouts, add-manual-data,
  rotate-phone-hub-token).
- §9 Schedule `aggregate-raw`.
- §12.1–12.4 Edge-cases (время/сон, пропуски, агрегация, дедуп).
- §13 Безопасность (Bearer-токен, constant-time compare, лимит тела).
- §14 Миграции (уже созданы; наполнение).
- §16 Обработка ошибок (phone-hub, aggregate-raw).
- §17 Локальная разработка (mock-forwarder).
- §18.1–18.2 Тесты.
