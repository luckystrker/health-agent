#!/usr/bin/env bash
# dev/mock-forwarder/send.sh
#
# Шлёт тестовые payload'ы от имени forwarder'а в локальный phone-hub webhook.
# Покрывает все 5 metric-типов (sleep_session, steps, heart_rate, active_calories, workout).
#
# Использование (предварительно получи токен через mint-dev-token.mjs):
#   PHONE_HUB_TOKEN=... WEBHOOK_URL=http://localhost:2000/eve/v1/phone-hub \
#     bash dev/mock-forwarder/send.sh
#
# Timestamp'ы — UTC с Z (канонический контракт). Подставь свои под реальный сценарий.
set -euo pipefail

TOKEN="${PHONE_HUB_TOKEN:?задай PHONE_HUB_TOKEN (см. mint-dev-token.mjs)}"
URL="${WEBHOOK_URL:-http://localhost:2000/eve/v1/phone-hub}"

post() {
  local metric="$1" body="$2"
  echo "→ POST $metric"
  curl -sS -o /dev/null -w "  HTTP %{http_code}\n" \
    -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body"
}

# sleep_session: лёг 23:30 MSK (20:30Z), встал 07:00 MSK (04:00Z след.дня).
post sleep_session "$(cat <<'JSON'
{ "metric": "sleep_session",
  "payload": {
    "bed_at": "2026-03-14T20:30:00Z",
    "wake_at": "2026-03-15T04:00:00Z",
    "deep_min": 90, "light_min": 200, "rem_min": 80, "awake_min": 20,
    "source": "amazfit" } }
JSON
)"

# steps: часовой бакет.
post steps "$(cat <<'JSON'
{ "metric": "steps", "recorded_at": "2026-03-15T18:00:00Z",
  "payload": { "steps": 1200, "bucket": "2026-03-15 21:00" } }
JSON
)"

# heart_rate: минутный замер.
post heart_rate "$(cat <<'JSON'
{ "metric": "heart_rate", "recorded_at": "2026-03-15T06:30:00Z",
  "payload": { "bpm": 58, "kind": "resting" } }
JSON
)"

# active_calories: часовой бакет.
post active_calories "$(cat <<'JSON'
{ "metric": "active_calories", "recorded_at": "2026-03-15T18:00:00Z",
  "payload": { "active_kcal": 250, "total_kcal": 320, "active_min": 22 } }
JSON
)"

# workout: пробежка.
post workout "$(cat <<'JSON'
{ "metric": "workout",
  "payload": { "type": "running", "start_at": "2026-03-15T17:00:00Z",
               "duration_min": 45, "calories_kcal": 400 } }
JSON
)"

echo
echo "Готово. Проверь raw_samples в БД, затем прогони aggregate-raw:"
echo "  curl -X POST http://localhost:2000/eve/v1/dev/schedules/aggregate-raw"
