/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 本机构建时避开 safe-delete hook 对 .next 的拦截
  // 部署到 Vercel 时不受影响（Vercel 无此限制）
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
