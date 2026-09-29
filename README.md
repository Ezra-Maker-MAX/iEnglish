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
| **场景游戏化（5 个场景全量闯关化）** | ✅ 已完成 |
| **流式输出（首字 <1 秒）** | ✅ 已完成 |
| **角色立绘 + 关卡图标** | ✅ 已完成 |
| 语音（ASR/TTS） | 🟡 方案已定，见 `docs/语音方案.md` |
| ESP32 硬件 | ⬜ 待验证后启动 |
| 开场短视频 | ❌ 已放弃（见 `docs/美术资源生成.md`） |

## 5 个场景（全部已游戏化）

每个场景都有：**专属 AI 角色** + **4 个关卡** + **突发事件** + **徽章称号**。

| 场景 | 难度 | 适合 | 角色 | 通关徽章 |
|---|---|---|---|---|
| 商店购物比价 | ⭐ | 小学高段 | Nico | 🛍️ 砍价小能手 |
| 西餐厅点餐结账 | ⭐ | 小学高段 | Momo | 🍽️ 点餐达人 |
| 机场值机+过安检 | ⭐⭐ | 小学高段 ~ 初一 | Max | 🛂 空中飞人 |
| 学校社团面试 | ⭐⭐ | 五六年级 ~ 初二 | Sam | 🎒 社团新星 |
| 2分钟即兴演讲+提问 | ⭐⭐⭐ | 初二 ~ 初三 | Ivy | 🎤 小小演说家 |

**玩法**：AI 用英语推进剧情 → 每 2 轮过一个关卡（进度条 0/4 → 4/4）→
中途有突发事件（价格报错、笔找不到了、金属探测器响了）→
通关后结算页发徽章与称号。

### 关键设计：节奏与长度双重约束

游戏化最大的坑是**提示词与进度条脱节**：AI 在一个阶段反复追问，孩子已经说完了
它还在问同一件事，进度条纹丝不动。两条硬约束解决：

1. **逐轮动作清单**（不是「阶段区间」）——
   `TURN 1 → ask where. ONE question only.`
   写成 `Turn 1-2 → STAGE 1` 的话，AI 会连续两轮问同一个问题。
2. **显式跳关指令** ——
   `If you are still on an earlier stage when a later turn arrives, SKIP AHEAD immediately.`

另一个坑是**回复过长**：只约束「每句 6-8 词」，AI 会写 8 行绕过。
必须同时约束整段：`TOTAL LENGTH: your whole reply must be 2-4 lines maximum.`

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
│  ├─ practice/          孩子练习页（游戏化闯关界面）
│  ├─ dashboard/         家长看板
│  ├─ admin/             配置中心
│  ├─ api/
│  │  ├─ chat/           对话接口（流式 SSE）
│  │  ├─ scenarios/      场景接口
│  │  ├─ settings/       配置读写 + 连通性测试
│  │  ├─ auth/           登录 / 登出
│  │  └─ access/         访问口令管理
│  ├─ layout.js
│  └─ globals.css
├─ lib/
│  ├─ db.js              Turso 客户端
│  ├─ scenario.js        场景加载 + 提示词构建 + 公开视图裁剪
│  ├─ settings.js        配置读写 + 加密 + 掩码
│  ├─ auth.js            Cookie 鉴权
│  ├─ llm.js             LLM 调用（流式，配置从库读）
│  └─ sse.js             前端 SSE 消费
├─ scripts/
│  ├─ gamify-others.js   批量游戏化 4 个场景（幂等）
│  ├─ gamify-airport-v2.js  机场场景提示词 v2
│  ├─ gen-assets.cjs     生成立绘 + 关卡图标
│  └─ verify-game-ui.cjs 端到端验收（Playwright + Edge）
├─ public/               美术资源（立绘 / 关卡图标）
├─ docs/                 设计文档（架构 / 模型选型 / 美术 / 部署指南）
├─ proxy.js              边缘拦截（原 middleware.js）
└─ package.json
```

## 部署到 Vercel

> 📘 **完整版见 [`docs/部署指南.md`](docs/部署指南.md)** —— 含 Turso 建库、
> 环境变量决策（为什么 `SETTINGS_SECRET` 不能改）、构建阶段的坑、部署后自检清单。
> 下面是精简版。

### 方式一：命令行

```bash
npm i -g vercel
vercel
```

### 方式二：Git 集成（推荐）

在 Vercel 新建项目 → 导入 `Ezra-Maker-MAX/iEnglish` 仓库 → 框架自动识别为 Next.js。

> ★ **推送代码时本机必须 unset 代理**，否则 `git push` 会**静默失败**
> （exit 0 但远端不动）：
> ```bash
> unset http_proxy https_proxy ALL_PROXY HTTP_PROXY HTTPS_PROXY
> git push origin main
> ```

### 必须配置的环境变量

在 **Settings → Environment Variables** 添加以下 3 项，**Environment 勾选 Production / Preview / Development 全部**：

| 变量名 | 值 | 必填 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://ienglish-crescent.aws-ap-northeast-1.turso.io` | ✅ |
| `TURSO_AUTH_TOKEN` | 你的 Turso token | ✅ |
| `SETTINGS_SECRET` | 32 字节随机串（`openssl rand -hex 32`） | ⚠️ 强烈建议 |

**LLM 的 API Key 不要配在这里** —— 部署后打开 `/admin` 页面填。

### Node.js 版本要求

**20.x 或 22.x**（Next 16 要求 ≥ 20.9）。在 **Settings → General → Node.js Version** 设置。

### 建议同时配置的项目

1. **Region 选 `Tokyo (hnd1)`** —— 你的 Turso 库在 `aws-ap-northeast-1`（东京）。同区部署可把数据库往返延迟从 ~150ms 降到 ~5ms，对话响应明显更快。在 **Settings → Functions → Function Region** 设置。

2. **`SETTINGS_SECRET` 一旦设定不要更改** —— 它同时是加密密钥和 Cookie 签名密钥。改了会导致：
   - 已保存的 API Key 无法解密（需重新填）
   - 所有人登录态失效（需重新登录）

3. **首次部署后立即设访问口令** —— 打开 `/admin` → 访问保护 → 设口令并启用。否则你的 API 额度对公网开放。

### ⚠️ 本机 `next build` 跑不完整（Vercel 不受影响）

本机 `next build` 会**编译成功、类型检查通过、页面全部生成**，然后在**收尾清理阶段**
被 safe-delete hook 拦下报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。**这不是代码问题**。
本机验证请用 `next dev` + curl 测路由状态码；Vercel 无此 hook，构建正常完成。

### 部署后检查清单

```bash
# 1. 首页能打开
curl -I https://<你的域名>/

# 2. 配置页能读到配置（未设口令时应返回 200）
curl https://<你的域名>/api/settings

# 3. 测试 LLM 连通性
#    打开 /admin 点「测试连接」，应返回耗时与模型名
```

界面层还要确认两件事（`docs/部署指南.md` 第 6 节有完整清单）：

- **角色立绘显示正常**（不是首字母回退）
- **首字 1 秒内出现**（若仍是 3 秒整段弹出，检查响应头是否漏了
  `X-Accel-Buffering: no`，或路由被改成了 edge runtime）

## 下一步：接入语音

文字版验证通过后（孩子愿意用 + AI 教学表现符合预期），再接 ASR/TTS。

**方案选型已完成，见 [`docs/语音方案.md`](docs/语音方案.md)**。三条核心结论：

1. **当前 LLM 平台无语音能力**（实测只有文本/图像/视频模型，`/audio/*` 路由无渠道被开通）
   → 必须外接第三方。
2. **TTS 免费方案成熟，建议先做**：edge-tts（微软在线合成，免费无需 Key，音质接近商业级），
   降级方案是浏览器内置 `SpeechSynthesis`（零成本零基础设施，但音色随设备变化）。
3. **ASR 才是难点**，且必须实测童声识别率再投入：
   - 浏览器 `webkitSpeechRecognition` 虽免费，但**依赖 Google 服务，国内不可用**
   - 国内稳妥路线是**讯飞语音听写**（每日 500 次免费，对中文童声有优化）

**关键提醒**：儿童语音识别是最大未知数。主流 ASR 多以成人语料训练，
对童声识别率会下降；且孩子说英语发音本就不标准，会形成**双重误差**。
**务必先拿自己孩子实测**（录 10 句比对识别结果，约 1 小时），再决定是否投入架构改造。

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
