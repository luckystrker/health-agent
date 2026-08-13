// @ts-check
/**
 * Структурный JSON-логгер (§15). Пишет построчный JSON в stdout → journald под systemd.
 *
 * Каждая запись: `{ timestamp, level, component, event, message?, user_id?, ...fields }`.
 * `level`: info (нормальный поток, включая дубли forwarder'а), warn (ретраи/деградация),
 * error (провал операции). Секреты (токены, пароли) НИКОГДА не логируются.
 *
 * На v1 — достаточно логов; отдельный metrics-бэкенд избыточен для family-of-2 (§15).
 */
export type LogLevel = "info" | "warn" | "error";
export type Component = "ingestion" | "auth" | "tool" | "schedule" | "oauth" | "app";

export interface LogFields {
  message?: string;
  user_id?: string;
  [key: string]: unknown;
}

/**
 * Структурный лог. `component`+`event` обязательны (по §15); остальное — полями.
 */
export function log(
  component: Component,
  event: string,
  level: LogLevel,
  fields: LogFields = {},
): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    ...fields,
  };
  // console.* единым JSON-выстрелом — journald подхватит строку целиком.
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
