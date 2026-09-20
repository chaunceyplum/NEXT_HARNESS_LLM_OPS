/**
 * SQL literal escaping — execute_sql (the MCP tool) takes a raw SQL string
 * with no parameter binding, so every value has to be escaped by hand. Same
 * approach as NEXT_HARNESS/lib/execution-store.ts, kept here rather than
 * shared across repos since this is the only place in this repo that needs it.
 */

export function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlTimestamp(date: Date): string {
  return sqlStr(date.toISOString());
}
