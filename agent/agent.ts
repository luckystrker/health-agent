// @ts-check
/**
 * Health-agent (фаза 0).
 *
 * Каналы (`agent/channels/`), инструменты (`agent/tools/`) и инструкции
 * (`agent/instructions.md` + `agent/instructions/*.ts`) автораспознаются eve
 * с файловой системы — здесь только runtime-конфиг.
 *
 * Модель — `opencode-go/deepseek-v4-flash` (выбор автора; см. STATUS.md).
 */
import { defineAgent } from "eve";

export default defineAgent({
  model: "opencode-go/deepseek-v4-flash",
  // AI Gateway не имеет metadata контекстного окна для этой модели — задаём явно
  // (escape hatch, см. eve docs agent-config.md). DeepSeek V4: ~128k токенов.
  // TODO(STATUS): подтвердить точное значение контекстного окна для deepseek-v4-flash.
  modelContextWindowTokens: 128_000,
});
