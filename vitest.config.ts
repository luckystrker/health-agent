import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Тесты импортируют agent/lib/tenant.ts, который тянет db-клиент; client.ts бросает,
    // если DATABASE_URL не задан. postgres-js не подключается при создании пула, поэтому
    // валидный-looking URL достаточен — реальных запросов в unit-тестах нет.
    env: {
      DATABASE_URL: "postgres://health:dev@127.0.0.1:5432/health",
      ALLOWED_CHAT_IDS: "111,222",
      // FatSecret-подпись OAuth 1.0a в fetch-mock тестах (реальных запросов нет).
      FATSECRET_CLIENT_ID: "test-key",
      FATSECRET_CLIENT_SECRET: "test-secret",
    },
  },
});
