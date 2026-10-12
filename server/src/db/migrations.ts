/**
 * 出厂迁移列表（机制先行；内容随 S2-T2…T7 逐步落地）。
 * DDL 唯一来源是 docs/contracts/storage-model.md 的 -- @schema 块（D6 只读纪律）；
 * 本任务只带空基线，不建业务表。
 */
export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'baseline: empty — 10-table contract DDL lands with S2-T2…T7',
    statements: [],
  },
];
