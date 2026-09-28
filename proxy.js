import { NextResponse } from 'next/server';

/**
 * 边缘代理（Next 16 起，原 middleware.js 更名为 proxy.js）
 *
 * 注意：这里跑在 Edge runtime，无法访问 Turso（@libsql/client 是 Node 依赖）。
 * 因此只做「无 Cookie 就挡掉」的粗筛，真正的校验在页面/API 层完成。
 * 目标是拦住顺手扫路径的爬虫，减少无效数据库查询。
 */
export function proxy(req) {
  const { pathname } = req.nextUrl;

  // /admin 本身要能打开 —— 否则无法输入口令
  if (pathname.startsWith('/admin')) return NextResponse.next();

  // /dashboard 是家长端数据，要求有登录 Cookie 才放行到页面层
  if (pathname.startsWith('/dashboard')) {
    const hasCookie = req.cookies.get('ie_auth')?.value;
    if (!hasCookie) {
      const url = req.nextUrl.clone();
      url.pathname = '/admin';
      url.searchParams.set('from', pathname);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/dashboard/:path*'],
};
