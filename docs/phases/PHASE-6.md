# Фаза 6 — Полировка: edge-cases, удаление данных, healthcheck, мониторинг

> Спецификация фазы. Источник правды — [`../SPECIFICATION.md`](../SPECIFICATION.md).
> Перед стартом — [`../../AGENTS.md`](../../AGENTS.md), текущее состояние в
> [`../STATUS.md`](../STATUS.md).

**Статус:** 🔲 не начата.

---

## 1. Цели и границы

### Что входит в фазу
- **GDPR-style удаление данных** (`delete-my-data`): каскадное удаление всех таблиц по
  `user_id` + отзыв FatSecret-токена. Подтверждение через inline-кнопку.
- **Healthcheck** (`GET /healthz`): проверка БД-соединения.
- **Структурное логирование** (§15) и **обработка ошибок по компонентам** (§16) —
  финальная проверка покрытия.
- **Бэкап БД**: ежедневный `pg_dump` → `pgdata-backups/YYYY-MM-DD.sql.gz` с ротацией.
  Offsite-копия (rsync в object storage / на другой хост) — закладывается здесь.
- **Деплой-чеклист**: systemd unit, Caddy (auto-TLS), `setWebhook`, миграции при деплое.
- Закрытие оставшихся edge-cases, замеченных в фазах 1–5.
- Эвалы (§18.3): итоговое покрытие (отчёт, tone, перевод, region=RU).

### Что НЕ входит
- Внешний алертинг (PagerDuty/etc.) — упоминается в §16 как «фаза 6», но в спеке нет
  конкретики; на v1 алерты оператору — через логи. Если требуется внешний алертинг —
  выделить в отдельную подзадачу и зафиксировать в STATUS.md.
- Динамический schedule-store (масштабирование >~10 юзеров) — не на v1 (§20.5).

### Ключевое архитектурное решение фазы
Ни одна ошибка не должна показывать юзеру stack trace или технические детали. Все ошибки
оборачиваются в user-friendly сообщения в tone-пресете; технические детали — в логи.
Алерты оператору — через логи на старте (§16).

---

## 2. Зависимости

- **Фазы 0–5** — фаза 6 полирует и закрывает то, что построено; не вводит новых фич
  (кроме `delete-my-data` и `/healthz`, которые можно было заложить раньше, но
  концептуально относятся сюда).

---

## 3. Создаваемые/изменяемые файлы

| Путь | Назначение | Спека |
|------|------------|-------|
| `agent/tools/account/delete-my-data.ts` | Каскадное удаление по `user_id` + отзыв FatSecret-токена | §8, §13 |
| `GET /healthz` (route) | Healthcheck: проверка БД-соединения | §14 |
| `agent/lib/logging.ts` (если не заведено ранее) | Структурные JSON-логи в journald: поля `timestamp, level, component, user_id, event, message` | §15 |
| `systemd/health-agent.service` | Unit: `Restart=always`, journald | §14 |
| `Caddyfile` | auto-TLS; `POST /eve/v1/telegram`, `POST /eve/v1/phone-hub`, `GET /healthz` | §14 |
| `scripts/backup-postgres.sh` | Ежедневный `pg_dump` → gzip → ротация (30 + первые числа мес.) | §14 |
| `scripts/register-webhooks.sh` | `setWebhook` для Telegram после деплоя | §14, §17 |
| `docs/deploy.md` (опц.) | Деплой-чеклист на VPS | §14 |

---

## 4. Таблицы БД

Новых таблиц нет. `delete-my-data` очищает (контракт из §13):
`users`/`profiles`/`goals`/`raw_samples`/`daily_aggregates`/`food_entries`/`program`
(`workout_programs`+`program_sessions`)/`workout_logs`/`tokens`
(`fatsecret_tokens`+`phone_hub_tokens`)+`weight_log`+`reminder_settings`.

> Уточнить у SPECIFICATION.md §13 точный список — там перечислено
> «users/profiles/goals/raw_samples/daily_aggregates/food_entries/program/logs/tokens»;
> добавить неупомянутые явно (`weight_log`, `reminder_settings`) — зафиксировать в
> STATUS.md.

---

## 5. Детали реализации

### 5.1 `delete-my-data` (§13)
- Подтверждение через inline-кнопку (HITL).
- Каскадное удаление всех таблиц по `user_id` + отзыв FatSecret-токена.
- Контракт: Telegram-сообщения уже ушедшие не возвращаются.
- Транзакция: либо всё, либо ничего (atomic). Записать в лог с `component=account`,
  `event=delete_my_data`.

### 5.2 Healthcheck (`GET /healthz`, §14)
- Проверка БД-соединения (простой `SELECT 1`).
- Возврат 200/503.
- Не требует auth.

### 5.3 Структурное логирование (§15)
- JSON в journald, не plain text.
- Поля: `timestamp`, `level`, `component` (`ingestion|auth|tool|schedule|oauth|account`),
  `user_id` (где применимо), `event`, `message`, контекстные поля.
- Логируемые события (минимум):
  - **Ingestion:** phone-hub POST (metric, user_id, dedup-hit/miss), ошибка валидации.
  - **Auth:** OAuth FatSecret — старт flow, успех, отказ, истечение/отзыв.
  - **Tool:** имя, user_id, длительность, успех/ошибка (**без аргументов** — приватность).
  - **Schedule:** старт, завершение, кол-во обработанных юзеров, длительность.
- Уровни: `info` — нормальный поток (включая дубли forwarder'а — это норма, не warn);
  `warn` — ретраи/деградация (FatSecret 429, Telegram 429); `error` — провал операции.

### 5.4 Обработка ошибок — финальная проверка покрытия (§16)
Сверить матрицу «компонент × сбой × поведение» из §16 с реализацией; закрыть пробелы:
- phone-hub (невалидный payload, неизвестный токен, ошибка БД).
- `log-food` (429, 401, сеть).
- schedules (БД timeout, ошибка в user-loop).
- Telegram sendMessage (429, 403 → `blocked=true`).
- `aggregate-raw` (частичный сбой — per-`(user,day,metric)` txn).
- OAuth flow (PIN-таймаут).
- `render-chart` (фолбэк на текст).

### 5.5 Бэкап (§14)
- Ежедневный `pg_dump` (cron на хосте или отдельном контейнере) →
  `pgdata-backups/YYYY-MM-DD.sql.gz`.
- Ротация: хранить последние 30 + первые числа каждого месяца.
- Offsite-копия: rsync в object storage / на другой хост — заложить здесь.

### 5.6 Деплой (§14)
- systemd unit (`health-agent.service`): `Restart=always`, журналирование в journald.
- Caddy: auto-TLS (Let's Encrypt); раздаёт `POST /eve/v1/telegram`, `POST /eve/v1/phone-hub`,
  `GET /healthz`.
- Postgres 16 в Docker Compose: `127.0.0.1:5432`, named volume `pgdata`, пароль в env,
  `pgcrypto`.
- Миграции: `drizzle-kit migrate` при деплое (или startup-хук).
- `setWebhook` для Telegram после деплоя.

---

## 6. Edge-cases (см. §13, §16, §12)

- **`delete-my-data` частичный сбой** — atomic-транзакция: при ошибке откат, ничего не
  удалено; user-friendly сообщение «не удалось, попробуй позже» + error-лог.
- **Удаление при активных FatSecret-токенах** — отзыв токена через FatSecret API при
  удалении (best-effort: если API недоступен — токен всё равно удаляется из БД).
- **`/healthz` при недоступной БД** — 503 + error-лог.
- **Бэкап при растущем volume** — `pgdata-backups` может расти; ротация обязательна.
- **DST в момент бэкапа** — cron в локальном времени хоста; фиксировать время в cron-правиле
  с учётом DST.

---

## 7. Критерии готовности

- [ ] `delete-my-data` через подтверждение (inline-кнопка) каскадно удаляет все таблицы
      по `user_id` + отзывает FatSecret-токен; atomic; логируется.
- [ ] `GET /healthz` возвращает 200 при живой БД, 503 при недоступной.
- [ ] Структурные JSON-логи покрывают все события из §15 с правильными уровнями;
      tool-логи не содержат аргументов (приватность).
- [ ] Матрица обработки ошибок (§16) полностью покрыта в коде; ни одна ошибка не
      показывает юзеру стек.
- [ ] `scripts/backup-postgres.sh` делает ежедневный `pg_dump` с ротацией; offsite-копия
      настроена (или явно заложена как TODO в STATUS.md).
- [ ] systemd unit, Caddyfile, `register-webhooks.sh` — в репо; деплой-чеклист описан.
- [ ] Эвалы (§18.3) собраны: отчёт, tone, перевод, region=RU.
- [ ] Журнальная запись в STATUS.md о завершении фазы 6 и готовности к релизу.

---

## 8. Риски и проверяемые гипотезы

- **Атомарность `delete-my-data`** — одна транзакция на все таблицы может быть тяжёлой
  при больших объёмах; для family-of-2 это ок. При масштабировании — разбить по таблицам
  с компенсирующими действиями (зафиксировать в STATUS.md если потребуется).
- **Приватность в логах** — гарантировать, что tool-аргументы (описания еды, текст
  пользователя) не попадают в логи; только `tool name + user_id + duration + success/error`.
- **Offsite-бэкап** — если object storage не настроен на старте, заложить как TODO и
  зафиксировать в STATUS.md.
- **Эвалы** — инструментировать процесс проверки LLM-поведения (отчёт/tone/перевод/
  region=RU); выбрать формат (см. eve-доки про evals).

---

## 9. Ссылки на спецификацию

- §12 Edge-cases и политика данных (время/сон, пропуски, агрегация, дедуп, ротация
  токена, изоляция, шаги) — итоговая сверка.
- §13 Безопасность (GDPR-style удаление; секреты в env; модель не видит токены; Postgres
  127.0.0.1).
- §14 Инфраструктура и деплой (systemd, Caddy, Postgres в Docker, миграции, бэкап,
  healthcheck).
- §15 Observability и логирование.
- §16 Обработка ошибок по компонентам (матрица).
- §18.1–18.3 Тестирование и эвалы.
- §20.5 Динамический schedule-store (не на v1; заложить при масштабировании).
