import AdminClient from './AdminClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'iEnglish · 配置中心',
};

export default function AdminPage() {
  return <AdminClient />;
}
