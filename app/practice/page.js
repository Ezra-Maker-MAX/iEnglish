import { listScenarios } from '@/lib/scenario';
import PracticeClient from './PracticeClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PracticePage() {
  let scenarios = [];
  try {
    scenarios = await listScenarios();
  } catch (e) {
    return (
      <div className="wrap">
        <h1>数据库连接失败</h1>
        <pre className="err">{e.message}</pre>
        <p className="tip">
          请检查环境变量 TURSO_DATABASE_URL 与 TURSO_AUTH_TOKEN 是否已配置。
        </p>
      </div>
    );
  }

  // Server Component 的返回值需要可序列化 —— 显式挑字段，避免把 BigInt / undefined 带过去
  const safe = scenarios.map((s) => ({
    slug: String(s.slug),
    title: String(s.title),
    difficulty: Number(s.difficulty) || 1,
    gamified: Boolean(s.gamified),
  }));

  return <PracticeClient scenarios={safe} />;
}
