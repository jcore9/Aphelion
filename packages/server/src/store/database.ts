export type SqlValue = string | number | bigint | Uint8Array | null;

export type Row = Readonly<Record<string, SqlValue>>;

export interface Database {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): void;
  all(sql: string, params?: readonly SqlValue[]): Row[];
  transaction<T>(fn: () => T): T;
  close(): void;
}
