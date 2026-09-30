/**
 * 执行 SQL 文件到 Turso（HTTP pipeline API，无需 turso CLI）
 *
 * 用法：
 *   node scripts/run-sql.mjs docs/voice.sql
 *
 * 为什么走 HTTP 而不是 @libsql/client：
 *   本地没有 turso CLI，而 HTTP API 一条 fetch 就能跑完 DDL + DML，
 *   且能看到每条语句各自的错误，排查比走客户端库直接。
 *
 * ⚠️ Turso HTTP pipeline 的 stmt.args 必须是 {type,value} 形状，
 *    裸值会被静默忽略。（本项目早期踩过这个坑）
 * ⚠️ SELECT 返回的 cols 是空数组，必须用位置索引 row[i].value 取值。
 */
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env.local');
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i > 0) env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
}

const BASE = (env.TURSO_DATABASE_URL || '').replace(/^libsql:\/\//, 'https://');
const TOKEN = env.TURSO_AUTH_TOKEN;
if (!BASE || !TOKEN) {
  console.error('缺少 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN（检查 .env.local）');
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/run-sql.mjs <file.sql>');
  process.exit(1);
}

/** 把 SQL 文件切成单条语句：去掉注释行，按分号切 */
function splitStatements(sql) {
  const lines = sql
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'));
  return lines
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function exec(statements) {
  const body = {
    requests: [
      ...statements.map((sql) => ({ type: 'execute', stmt: { sql } })),
      { type: 'close' },
    ],
  };

  const res = await fetch(`${BASE}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json();
}

const sql = fs.readFileSync(file, 'utf8');
const stmts = splitStatements(sql);
console.log(`执行 ${stmts.length} 条语句 → ${file}\n`);

const out = await exec(stmts);

let failed = 0;
out.results?.forEach((r, i) => {
  const stmt = stmts[i];
  if (stmt === undefined) return; // 末尾的 { type:'close' } 也会占一个 result，跳过
  const oneLine = stmt.replace(/\s+/g, ' ').slice(0, 78);
  if (r.type === 'error') {
    failed++;
    // 列已存在是可接受的（重复执行迁移时）
    const msg = r.error?.message || '';
    if (/duplicate column name|already exists/i.test(msg)) {
      console.log(`  ${String(i + 1).padStart(2)}. SKIP  ${oneLine}`);
      console.log(`        （${msg}）`);
    } else {
      console.log(`  ${String(i + 1).padStart(2)}. FAIL  ${oneLine}`);
      console.log(`        ${msg}`);
    }
  } else {
    const affected = r.response?.result?.affected_row_count;
    const rows = r.response?.result?.rows;
    console.log(
      `  ${String(i + 1).padStart(2)}. OK    ${oneLine}` +
        (affected != null ? `  [${affected} 行受影响]` : '') +
        (rows ? `  [返回 ${rows.length} 行]` : '')
    );
  }
});

// 打印所有 SELECT 的结果（便于一次迁移后自检）
out.results?.forEach((r, i) => {
  if (stmts[i] === undefined) return;
  if (!/^\s*select/i.test(stmts[i])) return;
  const rows = r.response?.result?.rows;
  if (!rows?.length) return;
  console.log('\n--- 查询结果 #' + (i + 1) + ' ---');
  for (const row of rows) {
    console.log('  ' + row.map((c) => c.value ?? 'NULL').join('  |  '));
  }
});

console.log(`\n完成：${stmts.length - failed} 成功 / ${failed} 失败`);
