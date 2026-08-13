-- Выполняется PostgreSQL-контейнером при первом создании БД
-- (пустой volume) — монтируется в /docker-entrypoint-initdb.d/.
--
-- pgcrypto: для gen_random_uuid(). На PG16 gen_random_uuid() встроено в core,
-- но расширение создаётся явно для совместимости и будущих нужд (§14, §5).
-- Дублируется в drizzle-миграции — для деплоя на VPS через drizzle-kit migrate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
