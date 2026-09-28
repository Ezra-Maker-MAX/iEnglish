# scripts/

## check-settings.js

**用途**：直接查 Turso 的 `app_settings` 表，打印每个键的**实际存储形态**。

用来确认密钥到底存的是密文（`enc:v1:...`）还是明文（`raw:...`）——网页上只显示掩码，看不到真实存储内容，所以排查时用这个脚本。

```bash
node scripts/check-settings.js
```

输出示例：

```
--- app_settings 存储形态 ---
access.enabled       secret=0  0
access.password_hash secret=1  a3f1b2...:9c8d7e...
llm.api_key          secret=1  enc:v1:xY9k...:Qw2m...:Zx8p...
llm.base_url         secret=0  https://api.deepseek.com
llm.model            secret=0  deepseek-chat
llm.temperature      secret=0  0.7
```

---

## reset-settings.js

**用途**：把配置重置回初始状态（清空 API Key 与访问口令、关闭鉴权、温度回 0.7、地址回 DeepSeek），并清空审计日志。

验收测试跑完后用，避免测试用的假口令和假 Key 留在库里。

```bash
node scripts/reset-settings.js
```

> 只动 `app_settings` 和 `config_audit` 两张表，不碰孩子的学习数据。

---

## verify-crypto.mjs

**用途**：独立验证 `lib/settings.js` 里那套 AES-256-GCM 加解密逻辑是否正确。

不需要数据库和服务，纯算法单测。验证四项：往返一致、密文格式、随机 IV 生效、篡改能被拦截。

```bash
node scripts/verify-crypto.mjs
```

---

## verify-admin-ui.cjs

**用途**：配置中心的端到端 UI 验收（Playwright + Edge），共 13 项断言。

覆盖：未登录拦截 → 错口令 → 正确登录 → 密钥掩码不泄露 → 服务商预设 → 测试连接 → 保存 → 刷新持久化 → 访问保护状态 → 环境变量表 → 练习页 → 看板 → 看板鉴权重定向。

```bash
# 先启动 dev server
npm run dev

# 另开终端
NODE_PATH="C:/Users/lenovo/.workbuddy-ai/binaries/node/workspace/node_modules" \
  node scripts/verify-admin-ui.cjs
```

**前提**：
- 服务已启动，且**访问口令为 `parent2026`**（脚本内置这个口令，改口令需同步改脚本）
- 截图输出到 `shots/`

**为什么用 Edge 而不是 Chrome**：本机 Chrome 渲染进程会崩，必须用 `channel: 'msedge'`。
**为什么要配 `proxy: { server: 'direct://' }`**：本机有代理，本地服务必须绕开，否则连不上。

---

## gh-push-docs.js

**用途**：当 `git push` 因网络问题（TLS 中断 / 代理 502 / 直连超时）失败时，
用 GitHub API 直接把文件推送到远程，绕开 git 传输层。

### 为什么需要它

本机网络环境下 `git push` 会间歇性失败，报错形如：

```
schannel: server closed abruptly (missing close_notify)
Failed to connect to github.com:443 after 21096 ms
CONNECT tunnel failed, response 502
```

但 **GitHub REST API 始终可达**（实测 200）。所以用 API 建 blob → tree → commit → 更新 ref，
效果等同于 push，且不依赖 git 的网络栈。

### 用法

```bash
export GH_TOKEN="<你的 GitHub PAT>"
export NO_PROXY='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
node scripts/gh-push-docs.js
```

### 注意

- **token 从环境变量读取**，脚本内不含任何硬编码密钥
- PAT 需要 `repo` 权限（读写仓库内容）
- 推送后本地 git 会与远程分叉（commit sha 不同但内容一致），需要手动对齐：
  ```bash
  git fetch origin main
  git reset --hard origin/main
  ```
  > 前提是本地内容已与远程一致。执行前先用 `git status` 确认无未提交的改动。

### 修改推送目标

脚本顶部的 `files` 数组列出要推送的文件路径。要推送其他文件，改这个数组即可。
