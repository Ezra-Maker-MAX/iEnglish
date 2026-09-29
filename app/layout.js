import './globals.css';

export const metadata = {
  title: 'iEnglish · 英语口语闯关',
  description: '给孩子用的 AI 英语口语陪练 —— 在冒险中开口说英语',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // 孩子多在手机/平板上用，禁用双指缩放避免误触把界面放大
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
