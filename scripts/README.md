# scripts/

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
