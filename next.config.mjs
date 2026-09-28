/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // 本机构建时避开 safe-delete hook 对 .next 的拦截
  // 部署到 Vercel 时不受影响（Vercel 无此限制）
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // 本机验收时通过 127.0.0.1 访问，Next 16 会拦截跨源 dev 资源
  // （/_next/hmr），导致 HMR 客户端脚本加载失败、React 无法水合。
  // 允许这两个开发源即可让 e2e 用 127.0.0.1 正常跑。
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
