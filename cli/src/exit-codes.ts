/**
 * CLI 退出码契约（骨架，S6-T1 定义；lint 语义与 docs/contracts/validation.md §6.1 对齐）。
 *
 * - 0 EXIT_OK    成功（lint 语义：通过，可含 warning）
 * - 1 EXIT_FAIL  命令失败（校验错误、查询失败等业务性失败）
 * - 2 EXIT_ERROR 用法错误或运行错误（未知命令/旗标、占位命令、内部错误）
 */
export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_ERROR = 2
