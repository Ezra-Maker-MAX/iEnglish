# iEnglish

给孩子用的 AI 英语口语陪练。运行在 **Vercel + Turso**。

## 这是什么

一个英语情景对话练习工具。孩子选一个场景（如「机场值机」「餐厅点餐」），
AI 扮演场景中的对方角色，全程用英语跟孩子对话。

教学规则基于开源项目 `qizhitang/xiaozhi-skills` 的英语口语陪练技能：

- **全程英语**，不插中文
- **不逐句纠错** —— 让孩子说完，对话结束后给整体反馈
- **卡壳给二选一提示**（"window or aisle?"），不给整句
- 复盘标注「初级表达 → 升级表达」
- **不收集孩子真实个人信息**（姓名、学校、地址；证件号用占位符）

## 当前进度

**第一期 · 文字版已就绪**。先验证教学效果，再决定是否投入语音与硬件。

| 阶段 | 状态 |
|---|---|
| Turso 数据库（8 表 + 5 场景） | ✅ 已建成 |
| 文字对话闭环 | ✅ 已完成 |
| 家长端看板 | ✅ 已完成 |
| 语音（ASR/TTS） | ⬜ 待接入 |
| ESP32 硬件 | ⬜ 待验证后启动 |

## 5 个场景

| 场景 | 难度 | 适合 |
|---|---|---|
| 商店购物比价 | ⭐ | 小学高段 |
| 西餐厅点餐结账 | ⭐ | 小学高段 |
| 机场值机+过安检 | ⭐⭐ | 小学高段 ~ 初一 |
| 学校社团面试 | ⭐⭐ | 五六年级 ~ 初二 |
| 2分钟即兴演讲+提问 | ⭐⭐⭐ | 初二 ~ 初三 |

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env.local
```

填入：

```
TURSO_DATABASE_URL=libsql://ienglish-crescent.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=<你的 token>
LLM_API_KEY=<你的 LLM key>
```

LLM 兼容 OpenAI 格式，DeepSeek / 通义 / OpenAI 均可。

### 2. 启动

```bash
npm install
npm run dev
```

打开 http://localhost:3000

- `/practice` — 孩子练习页
- `/dashboard` — 家长看板

## 数据库

数据库已建好，含 8 张表：

| 表 | 用途 |
|---|---|
| `children` | 孩子档案 |
| `devices` | 设备（为第二期硬件预留） |
| `scenarios` | **场景配置（改提示词立即生效，不用烧固件）** |
| `sessions` | 会话记录 |
| `turns` | 逐轮对话 |
| `vocab_progress` | 生词本 |
| `pron_scores` | 发音评分（为后续评测预留） |
| `daily_stats` | 每日统计 |

### 改教学提示词

这是本项目的核心设计 —— **提示词存数据库，不烧进固件**：

```bash
turso db shell ienglish
```

```sql
UPDATE scenarios
SET system_prompt = '你的新提示词…'
WHERE slug = 'airport-checkin';
```

保存即生效，刷新页面即可看到变化。

## 项目结构

```
ienglish/
├─ app/
│  ├─ practice/          孩子练习页
│  ├─ dashboard/         家长看板
│  ├─ api/
│  │  ├─ chat/           对话接口
│  │  └─ scenarios/      场景接口
│  ├─ layout.js
│  └─ globals.css
├─ lib/
│  ├─ db.js              Turso 客户端
│  ├─ scenario.js        场景加载 + 提示词构建
│  └─ llm.js             LLM 调用（流式/非流式）
└─ package.json
```

## 部署到 Vercel

```bash
npm i -g vercel
vercel
```

在 Vercel 项目 **Settings → Environment Variables** 中配置
`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`、`LLM_API_KEY`。

## 下一步：接入语音

文字版验证通过后（孩子愿意用 + AI 教学表现符合预期），再接 ASR/TTS。

**关键提醒**：儿童语音识别是最大未知数。主流 ASR 多以成人语料训练，
对童声识别率会下降。**务必先拿自己孩子实测**，再决定是否投入硬件。

## 技术栈

- **Next.js 16** (App Router) — 部署 Vercel
- **Turso** (libSQL) — 边缘数据库，SQLite 兼容
- **LLM** — OpenAI 兼容接口

## 隐私

- 数据库只存**文本**（转写与回复），不存原始录音
- 孩子的真实姓名、学校、地址**不采集**
- 第二期接语音时，原始音频也不落库
