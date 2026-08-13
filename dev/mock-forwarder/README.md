# dev/mock-forwarder

Локальная имитация forwarder'а phone-hub для энд-ту-энд проверки ингеста и агрегации
(§17, §18.2). Не требует реальных часов — шлёт curl'ом канонические payload'ы в webhook.

## Быстрый старт

1. **Поднять dev-БД и собрать** (один раз):
   ```bash
   docker compose up -d postgres
   npm run db:migrate          # создаст все таблицы
   ```

2. **Запустить агента** (в отдельном терминале):
   ```bash
   npm run dev                 # eve dev, слушает http://localhost:2000
   ```

3. **Пройти онбординг** от своего `chat_id` через Telegram (чтобы существовал `users`),
   либо вставить user-строку вручную. Нужен `telegram_chat_id` из allowlist.

4. **Сгенерировать тестовый токен** для этого юзера:
   ```bash
   node --env-file=.env dev/mock-forwarder/mint-dev-token.mjs <telegram_chat_id> android amazfit
   # → напечатает PHONE_HUB_TOKEN=...
   ```
   Требует `PHONE_HUB_TOKEN_SALT` и `DATABASE_URL` в `.env`.

5. **Отправить тестовые payload'ы** (все 5 metric-типов):
   ```bash
   PHONE_HUB_TOKEN=<токен из шага 4> \
   WEBHOOK_URL=http://localhost:2000/eve/v1/phone-hub \
     bash dev/mock-forwarder/send.sh
   ```
   Ожидаются `HTTP 200` на каждый POST. Проверь, что строки появились в `raw_samples`.

## Что проверять

- **Вебхук-статусы (§16):** `200` (валидный), `401` (чужой/пустой токен), `400` (невалидный
  payload/json), `413` (тело > 1 MB — увеличь тело вручную для проверки).
- **Дедупликация (§12.4):** повторный запуск `send.sh` → те же `200`, в логе `dedup: retry-dup`,
  новых строк в `raw_samples` не прибавляется.
- **Агрегация (§12.3):** после mock-данных прогони schedule вручную:
  ```bash
  curl -X POST http://localhost:2000/eve/v1/dev/schedules/aggregate-raw
  ```
  Затем проверь `daily_aggregates` — должны появиться агрегаты за завершённые дни.
  Помни: sleep-through-midnight относится к дате пробуждения; текущий локальный день НЕ
  агрегируется (только sleep с `wake_at` в прошлом).

## Контракт payload

Канонический формат (§6.1, откр. вопрос §20.1): тело `{ metric, recorded_at?, payload }`.
- `sleep_session` / `workout`: `recorded_at` выводится из payload (`wake_at` / `start_at`).
- `steps` / `heart_rate` / `active_calories`: `recorded_at` обязателен (время бакета/замера).
- Timestamp'ы — ISO 8601 с offset/Z (без offset → 400).

Реальные forwarder'ы (`mcnaveen/health-connect-webhook` для Android, «Health Webhook» для iOS)
могут слать свои имена полей — для них добавляется маппер через `registerVariantMapper`
(`agent/lib/normalize.ts`) при подключении устройства.
