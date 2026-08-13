#!/usr/bin/env node
/**
 * dev/mock-forwarder/mint-dev-token.mjs
 *
 * Создаёт/ротирует тестовый токен phone-hub напрямую в БД — чтобы гонять mock-forwarder
 * локально без полноценного онбординга. Запускать с загруженным .env:
 *
 *   node --env-file=.env dev/mock-forwarder/mint-dev-token.mjs <telegram_chat_id> <platform> <device_label>
 *
 * Пример:
 *   node --env-file=.env dev/mock-forwarder/mint-dev-token.mjs 123456789 android amazfit
 *
 * Печатает plaintext-токен — его подставляй в PHONE_HUB_TOKEN для send.sh.
 * Требует PHONE_HUB_TOKEN_SALT и DATABASE_URL в окружении.
 */
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

const salt = process.env.PHONE_HUB_TOKEN_SALT;
const databaseUrl = process.env.DATABASE_URL;
const [chatId, platform, deviceLabel] = process.argv.slice(2);

if (!salt || !databaseUrl) {
  console.error("Нужно задать PHONE_HUB_TOKEN_SALT и DATABASE_URL (через .env).");
  process.exit(1);
}
if (!chatId || !platform || !deviceLabel) {
  console.error("Использование: mint-dev-token.mjs <telegram_chat_id> <platform> <device_label>");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

const tokenHash = (t) => createHash("sha256").update(salt + t).digest("hex");

try {
  const [user] = await sql`SELECT id FROM users WHERE telegram_chat_id = ${BigInt(chatId)}`;
  if (!user) {
    console.error(`Юзер с telegram_chat_id=${chatId} не найден. Сначала пройди онбординг.`);
    process.exit(1);
  }

  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);

  // upsert по (user_id, platform, device_label): удалить старый, вставить новый.
  await sql`
    WITH old AS (
      SELECT token_hash FROM phone_hub_tokens
      WHERE user_id = ${user.id} AND platform = ${platform} AND device_label = ${deviceLabel}
    )
    DELETE FROM phone_hub_tokens
    WHERE user_id = ${user.id} AND platform = ${platform} AND device_label = ${deviceLabel}
  `;
  await sql`
    INSERT INTO phone_hub_tokens (token_hash, user_id, device_label, platform, rotated_from)
    VALUES (${hash}, ${user.id}, ${deviceLabel}, ${platform}, NULL)
  `;

  const base = (process.env.PHONE_HUB_WEBHOOK_URL || "http://localhost:2000").replace(/\/+$/, "");
  console.log("\n=== Тестовый токен phone-hub (DEV) ===");
  console.log("PHONE_HUB_TOKEN=" + token);
  console.log("WEBHOOK_URL=" + base + "/eve/v1/phone-hub\n");
} finally {
  await sql.end();
}
