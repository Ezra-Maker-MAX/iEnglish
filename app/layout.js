import './globals.css';

export const metadata = {
  title: 'iEnglish · 英语口语陪练',
  description: '给孩子用的 AI 英语口语陪练',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
