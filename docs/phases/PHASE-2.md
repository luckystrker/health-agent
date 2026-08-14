# Фаза 2 — FatSecret (с OAuth) + food_entries; калории (вариант C)

> Спецификация фазы. Источник правды — [`../SPECIFICATION.md`](../SPECIFICATION.md).
> Перед стартом — [`../../AGENTS.md`](../../AGENTS.md), текущее состояние в
> [`../STATUS.md`](../STATUS.md).

**Статус:** ✅ завершена (2026-08-14). См. [`../STATUS.md`](../STATUS.md), журнал правок.

---

## 1. Цели и границы

### Что входит в фазу
- **FatSecret-интеграция через собственные tools** (НЕ MCP-connection): поиск продуктов
  (OAuth 2.0 client credentials), запись в дневник (OAuth 1.0a per-user), фолбэк
  штрихкодов (Open Food Facts).
- **OAuth 1.0a 3-legged PIN-flow** через свой route + HITL (`input.requested`), обмен PIN
  на access-токен, сохранение в `fatsecret_tokens`.
- Копирование строк дневника в нашу `food_entries` (для аналитики, независимости от
  лимитов 5000/day, работы schedules без user-principal — §9).
- **Расчёт калорий (гибрид, вариант C)**: BMR (Mifflin-St Jeor) + активность из часов +
  cold-start fallback (<14 дней → `self_reported_activity_level`).
- Tools: `log-food`, `lookup-barcode`, `connect-fatsecret`, `complete-fatsecret`,
  `get-food`, `get-calorie-balance`, `get-target-calories`.
- Schedule `sync-fatsecret-diary` — ежедневный upsert дневника по `external_id`.
- App-level OAuth 2.0 client-credentials токен — в памяти процесса (refresh за ~час до
  истечения 24ч TTL).

### Что НЕ входит
- Недельный отчёт с разбором калоража → **фаза 3** (использует `food_entries` и
  `get-calorie-balance` отсюда).
- Алерты на перебор калорий → **фаза 4** (`anomaly-check`).
- Тренировки/программа → **фаза 5**.

### Ключевое архитектурное решение фазы
**Primary-путь — собственные tools с прямыми подписанными fetch'ами**, не MCP-сервер
`fliptheweb/fatsecret-mcp` (см. §6.2, §8 — блокнот). Причины: `defineInteractiveAuthorization`
из eve не ложится на OAuth 1.0a 3-legged (PIN/out-of-band, без refresh); контроль
`region=RU` через LLM-инструкции хрупок; stdio→HTTP-мост под systemd — лишний процесс.
MCP оставлен как опция для быстрого старта (только публичный поиск) — но не primary.

---

## 2. Зависимости

- **Фаза 0** — обязательна: `users`, `food_entries`, `fatsecret_tokens`, `goals`,
  `profiles`, `requireUser`, env (`FATSECRET_CLIENT_ID/SECRET`).
- **Фаза 1** — частично: для гибридного расчёта калорий нужны `daily_aggregates` за 14
  дней (шаги, active_calories, HR). При отсутствии фазы 1 — расчёт сразу падает в
  cold-start fallback (`self_reported_activity_level`).

---

## 3. Создаваемые/изменяемые файлы

| Путь | Назначение | Спека |
|------|------------|-------|
| `agent/lib/fatsecret-oauth.ts` | OAuth 1.0a signing (HMAC-SHA1) + PIN-flow helpers; OAuth 2.0 client-credentials token cache | §6.2, §13 |
| `agent/lib/calories.ts` | BMR (Mifflin-St Jeor) + активность из 14-дневной истории + cold-start fallback | §11.2 |
| `agent/tools/nutrition/log-food.ts` | Прямой подписанный fetch к FatSecret; `region=RU` принудительно; запись в дневник + копия в `food_entries` | §6.2, §8 |
| `agent/tools/nutrition/lookup-barcode.ts` | Open Food Facts фолбэк | §6.2, §8 |
| `agent/tools/nutrition/connect-fatsecret.ts` | Запуск OAuth 1.0a 3-legged PIN-flow (request_token → authorize URL) | §6.2, §8 |
| `agent/tools/nutrition/complete-fatsecret.ts` | Обмен PIN (oauth_verifier) на access-токен; сохранение в `fatsecret_tokens` | §6.2, §8 |
| `agent/tools/db/get-food.ts` | Чтение `food_entries` за период + суммарные БЖУ/ккал | §8 |
| `agent/tools/db/get-calorie-balance.ts` | Потреблено vs цель/расход за период | §8 |
| `agent/tools/goals/get-target-calories.ts` | Гибридный расчёт (вариант C) + cold-start fallback | §8, §11.2 |
| `agent/schedules/sync-fatsecret-diary.ts` | Ежедневный: `food_entries.get_month` → upsert по `external_id` | §9, §16 |

> Таблицы `food_entries` и `fatsecret_tokens` созданы миграциями фазы 0 — здесь
> наполняются.

---

## 4. Таблицы БД

Уже созданы на фазе 0. Активно используются:
- `food_entries` — копии строк дневника (+ manual, + barcode_off).
- `fatsecret_tokens` — per-user OAuth 1.0a access-токен + secret.
- `profiles` — пол/возраст/рост/вес/`self_reported_activity_level` (для cold-start).
- `goals` — `tempo_kg_per_week`, `target_date`, `calorie_source`, `manual_target_kcal`.
- `daily_aggregates` — шаги/active_calories/HR за 14 дней (из фазы 1) для гибридного
  расчёта.

---

## 5. Env-переменные

Добавляются/заполняются (см. `.env.example` фазы 0):
```
FATSECRET_CLIENT_ID=
FATSECRET_CLIENT_SECRET=
```
App-level OAuth 2.0 client-credentials токен в БД **не хранится** — живёт в памяти
процесса, refresh за ~час до истечения 24ч TTL (§5.7).

---

## 6. Детали реализации

### 6.1 FatSecret OAuth — два разных потока (§6.2)

**OAuth 2.0 Client Credentials** — публичный поиск продуктов (`foods.search`,
`food.get`, `food.find_id_for_barcode`):
- App-scoped, один токен на приложение, без участия юзера.
- Кэш в памяти процесса, refresh за ~час до истечения (24ч TTL).
- Ключи в env `FATSECRET_CLIENT_ID` / `FATSECRET_CLIENT_SECRET`.

**OAuth 1.0a 3-legged** — чтение/запись дневника юзера (`food_entry.*`,
`food_entries.get_month`):
- Per-user, токен **бессрочный, refresh-flow отсутствует** (при отзыве — перезапуск
  всего flow).
- Сохраняется в `fatsecret_tokens` (`access_token`, `access_token_secret`).
- Signing — `oauth-1.0a` пакет или ручной HMAC-SHA1 (~15 строк).

### 6.2 PIN-flow (§6.2)
1. Юзер жмёт «Подключить FatSecret» (inline-кнопка в Telegram).
2. Бот получает **request token** (signed POST к `oauth/request_token`), редиректит на
   `oauth/authorize?oauth_token=...`. FatSecret показывает **PIN** (out-of-band).
3. Бот просит PIN через **`input.requested`** HITL (`ForceReply` в Telegram).
4. Получив PIN (= `oauth_verifier`), бот обменивает request token + verifier на access
   token (signed POST к `oauth/access_token`), сохраняет в `fatsecret_tokens`.
5. Запаркованный turn возобновляется, подтверждает подключение.
6. `resume`-значение park-хука: `{ request_token, request_token_secret }` (НЕ PKCE verifier).

### 6.3 `log-food` — прямой подписанный fetch (§6.2, §8)
- **Поиск продуктов** — OAuth 2.0 client credentials (app-scoped). Принудительно
  `region=RU, language=ru, format=json` в **каждом** запросе (на уровне tool'а, не LLM).
- **Запись в дневник** — OAuth 1.0a подписанный запрос с per-user access-токеном.
- После каждой успешной записи — копирование строки в `food_entries` (для аналитики,
  независимости от лимитов, работы schedules).
- region=RU гарантирован на уровне кода (§6.2, §8).

### 6.4 Фолбэк штрихкодов (§6.2)
- `lookup-barcode`: Open Food Facts REST
  `https://world.openfoodfacts.org/api/v2/product/<barcode>` (русская подмножество ~35k).
- Вызывается если в FatSecret по штрихкоду пусто.

### 6.5 Расчёт калорий — гибрид, вариант C (§11.2)
- **BMR:** Mifflin-St Jeor (пол/возраст/рост/вес из `profiles`).
- **Активность (независимая оценка):** фактор активности выводится из средней активности
  за последние 14 дней (шаги + active_minutes + HR-паттерн). TDEE_бот = BMR × фактор.
- **Cold-start fallback (критично):** при **<14 днях** истории фактор берётся из
  `profiles.self_reported_activity_level` (sedentary 1.2 / light 1.375 / moderate 1.55 /
  active 1.725). При ≥14 днях — переключение на вычисленный фактор, юзеру приходит
  уведомление «теперь считаю калории по твоим реальным данным».
- **TDEE_по_часам:** BMR + active_calories из часов за 14 дней (для справки).
- **Целевой калораж** = TDEE_бот ± дефицит/профицит под цель
  (`goals.tempo_kg_per_week` → ~7700 ккал/кг жира).
- Юзеру показываются оба числа («по боту» / «по часам»).
- **Расхождение:** при систематическом уходе калоража в «плохую» сторону — бот
  предупреждает (тон по пресету), корректирует рекомендации, цель молча не меняет.

### 6.6 `sync-fatsecret-diary` (§6.2, §9, §16)
- Cron `0 4 * * *`.
- Schedule ходит от `appAuth`, но подписанный OAuth 1.0a-запрос к
  `food_entries.get_month` использует per-user access-токен из `fatsecret_tokens`
  (app-level fetch, не через user-connection eve) — principal не нужен.
- Для каждого онборженного юзера с подключённым FatSecret: чтение дневника → upsert в
  `food_entries` по `external_id` (= FatSecret `food_entry_id`).
- Без этого калораж в отчётах врёт (юзер может вносить еду напрямую в FatSecret-приложении).

---

## 7. Edge-cases (см. §16)

- **`log-food`: FatSecret 429** (лимит 5000/day) → дружелюбное «сервис питания
  перегружен, попробуй через минуту» + warn-лог.
- **`log-food`: FatSecret 401** (токен отозван) → иницировать перезапуск OAuth 1.0a flow;
  уведомить «нужно переподключить FatSecret».
- **`log-food`: сеть/FatSecret даун** → retry с экспоненциальным backoff (2–3 попытки);
  при провале — user-friendly сообщение.
- **PIN-flow: юзер не ввёл PIN / отказ** → запаркованный turn тайм-аутится (~10 мин),
  бот: «подключение отменено».
- **`sync-fatsecret-diary`: дубль/обновление** → upsert по `external_id`; новая,
  обновлённая, дублирующая строки обрабатываются корректно (см. §18.2).
- **Cold-start → переход на реальные данные** — в момент накопления ≥14 дней бот
  уведомляет юзера о смене метода расчёта.
- **Отзыв юзером FatSecret-токена** — при 401 перезапускаем flow; `fatsecret_tokens` не
  имеет refresh.

---

## 8. Критерии готовности

- [ ] OAuth 2.0 client-credentials токен получается, кэшируется, рефрешится за час до
      истечения; `region=RU, language=ru, format=json` присутствует в каждом поисковом
      запросе (unit-тест на подпись/параметры).
- [ ] OAuth 1.0a 3-legged PIN-flow проходит end-to-end: `connect-fatsecret` → юзер на
      authorize URL → ввод PIN → `complete-fatsecret` обменивает на access-токен →
      сохраняется в `fatsecret_tokens`. Парковка/возобновление turn'а работает.
- [ ] `log-food`: поиск продукта → выбор → запись в дневник → копия в `food_entries`.
      Подпись OAuth 1.0a корректна (принимается сервером).
- [ ] `lookup-barcode`: Open Food Facts возвращает продукт при наличии; фолбэк
      срабатывает при пустом FatSecret-ответе по штрихкоду.
- [ ] `calories.ts`: BMR Mifflin-St Jeor корректен (unit); фактор активности из 14 дней;
      cold-start fallback (`<14 дней → self_reported_activity_level`); целевой калораж
      под цель. Переход на реальные данные инициирует уведомление.
- [ ] `get-target-calories` возвращает оба числа («по боту» / «по часам»).
- [ ] `sync-fatsecret-diary`: upsert по `external_id` (новые + обновлённые + дубли)
      корректен на тестовой БД.
- [ ] Обработка ошибок по §16 (429/401/сеть/PIN-таймаут) — user-friendly, без стеков.
- [ ] Журнальная запись в STATUS.md о завершении фазы 2.

---

## 9. Риски и проверяемые гипотезы

- **`oauth-1.0a` vs ручная подпись** — пакет ~15 строк; зафиксировать выбор при
  имплементации (env: `oauth-1.0a`).
- **PIN-flow через `input.requested`** — свериться с актуальной eve-докой, что HITL
  парковки/`resume` работают как описано в спеке (§6.2). Если в ^0.31 изменились —
  флагни в STATUS.md.
- **App-level token в памяти** — процесс может упасть/рестартнуть; убедиться, что
  refresh логика не ломается при реинициализации.
- **`defineInteractiveAuthorization` действительно не подходит** — спека отказалась от
  него для PIN-flow (§6.2); при имплементации подтвердить, что свой route + HITL
  покрывает потребность.
- **FatSecret лимиты 5000/day** — для family-of-2 маловероятно упереться, но логировать
  429 и дружеложно сообщать.

---

## 10. Ссылки на спецификацию

- §5.4 Питание (`food_entries`).
- §5.7 `fatsecret_tokens`.
- §6.2 Питание — FatSecret (русская база; два OAuth; PIN-flow; region=RU; sync дневника;
  отказ от MCP как primary).
- §8 Инструменты (log-food, lookup-barcode, connect/complete-fatsecret, get-food,
  get-calorie-balance, get-target-calories).
- §9 Schedule `sync-fatsecret-diary`.
- §11.2 Расчёт калорий (гибрид, вариант C).
- §13 Безопасность (FatSecret OAuth 1.0a per-user; app-token в памяти; модель не видит
  токены).
- §16 Обработка ошибок (log-food, OAuth flow).
- §18.1–18.2 Тесты (calories, sync-fatsecret-diary upsert).
