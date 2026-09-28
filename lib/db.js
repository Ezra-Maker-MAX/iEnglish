import { createClient } from '@libsql/client';

/**
 * Turso 客户端（单例）
 * 在 serverless 环境中复用，避免每次请求重建连接
 */
const globalForDb = globalThis;

export const db =
  globalForDb.__ienglishDb ??
  createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__ienglishDb = db;
}

/** 查询辅助：返回对象数组 */
export async function query(sql, args = []) {
  const { rows, columns } = await db.execute({ sql, args });
  return rows.map((row) => {
    const obj = {};
    columns.forEach((c, i) => {
      obj[c] = row[i];
    });
    return obj;
  });
}

/** 单行查询 */
export async function queryOne(sql, args = []) {
  const rows = await query(sql, args);
  return rows[0] ?? null;
}

/** 执行写操作 */
export async function run(sql, args = []) {
  return db.execute({ sql, args });
}
