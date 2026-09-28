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
| Turso 数据库（10 表 + 5 场景） | ✅ 已建成 |
| 文字对话闭环 | ✅ 已完成 |
| 家长端看板 | ✅ 已完成 |
| 配置中心（网页改配置，免部署） | ✅ 已完成 |
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

只需填 **3 个**（LLM 的 Key 不用写在这里，去网页 `/admin` 填）：

```
TURSO_DATABASE_URL=libsql://ienglish-crescent.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=<你的 token>
SETTINGS_SECRET=<openssl rand -hex 32 的输出>
```

> `SETTINGS_SECRET` 用于加密数据库中的 API Key、签发登录 Cookie。
> 不填也能跑，但 Key 会以明文入库，配置页会持续告警。

### 2. 启动

```bash
npm install
npm run dev
```

打开 http://localhost:3000

- `/practice` — 孩子练习页
- `/dashboard` — 家长看板
- `/admin` — 配置中心（填 API Key、设访问口令）

### 3. 填 LLM 配置

打开 `/admin`，选服务商（或手填地址与模型名），粘贴 API Key，点「测试连接」确认可用，再保存。

**保存后立即生效，不需要重启服务或重新部署。**

## 数据库

数据库含 10 张表：

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
| `app_settings` | **运行期配置（LLM 参数、访问口令）** |
| `config_audit` | 配置变更审计 |

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

### 改 LLM 配置

不用碰 SQL，也不用碰环境变量 —— 直接去网页 `/admin` 改。

## 项目结构

```
ienglish/
├─ app/
│  ├─ practice/          孩子练习页
│  ├─ dashboard/         家长看板
│  ├─ admin/             配置中心
│  ├─ api/
│  │  ├─ chat/           对话接口
│  │  ├─ scenarios/      场景接口
│  │  ├─ settings/       配置读写 + 连通性测试
│  │  ├─ auth/           登录 / 登出
│  │  └─ access/         访问口令管理
│  ├─ layout.js
│  └─ globals.css
├─ lib/
│  ├─ db.js              Turso 客户端
│  ├─ scenario.js        场景加载 + 提示词构建
│  ├─ settings.js        配置读写 + 加密 + 掩码
│  ├─ auth.js            Cookie 鉴权
│  └─ llm.js             LLM 调用（配置从库读）
├─ proxy.js              边缘拦截（原 middleware.js）
└─ package.json
```

## 部署到 Vercel

### 方式一：命令行

```bash
npm i -g vercel
vercel
```

### 方式二：Git 集成（推荐）

在 Vercel 新建项目 → 导入 `Ezra-Maker-MAX/iEnglish` 仓库 → 框架自动识别为 Next.js。

### 必须配置的环境变量

在 **Settings → Environment Variables** 添加以下 3 项，**Environment 勾选 Production / Preview / Development 全部**：

| 变量名 | 值 | 必填 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://ienglish-crescent.aws-ap-northeast-1.turso.io` | ✅ |
| `TURSO_AUTH_TOKEN` | 你的 Turso token | ✅ |
| `SETTINGS_SECRET` | 32 字节随机串（`openssl rand -hex 32`） | ⚠️ 强烈建议 |

**LLM 的 API Key 不要配在这里** —— 部署后打开 `/admin` 页面填。

### 建议同时配置的项目

1. **Region 选 `Tokyo (hnd1)`** —— 你的 Turso 库在 `aws-ap-northeast-1`（东京）。同区部署可把数据库往返延迟从 ~150ms 降到 ~5ms，对话响应明显更快。在 **Settings → Functions → Function Region** 设置。

2. **`SETTINGS_SECRET` 一旦设定不要更改** —— 它同时是加密密钥和 Cookie 签名密钥。改了会导致：
   - 已保存的 API Key 无法解密（需重新填）
   - 所有人登录态失效（需重新登录）

3. **首次部署后立即设访问口令** —— 打开 `/admin` → 访问保护 → 设口令并启用。否则你的 API 额度对公网开放。

### 部署后检查清单

```bash
# 1. 首页能打开
curl -I https://<你的域名>/

# 2. 配置页能读到配置（未设口令时应返回 200）
curl https://<你的域名>/api/settings

# 3. 测试 LLM 连通性
#    打开 /admin 点「测试连接」，应返回耗时与模型名
```

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
- LLM API Key 在数据库中**加密存储**（配置 `SETTINGS_SECRET` 时启用 AES-256-GCM），且永远不回传到浏览器

## 安全

- `/api/chat` 与 `/dashboard` 受访问口令保护（在 `/admin` 启用）
- 口令以 scrypt 加盐哈希存储，数据库泄露也无法还原
- 登录态用 HMAC 签名 Cookie 承载，14 天有效
