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

  return <PracticeClient scenarios={scenarios} />;
}
