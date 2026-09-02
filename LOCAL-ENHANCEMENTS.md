# 本地增强说明（本 fork 相对上游的差异）

> 本仓库 fork 自 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard)，在**上游 v0.6.2 基准**上重放了本机（1254087415）的本地独有增强。上游 `main` 更新时通过 `git fetch upstream && git merge upstream/main` 合并，冲突在本仓库解决。
> 完整记录见本机 `~/Documents/project/docs/dsh-taskboard-本地增强记录.md` 第 5 节。

## 独有增强清单（commit 6d71378 起）

### 1. 会话自动跟踪（session-tracker.ts）
- 标题含任务动词（修复/排查/开发/调研…）的新会话 → **自动建卡 todo（待办）**（上游默认 backlog 语义已改）
- 用户对历史会话**重新发消息** → 卡自动转 **in_progress（进行中）**（说明还在验证/不满意）
- 会话**停止活跃 30 分钟**（`TRACKED_IDLE_TO_REVIEW_MS`）→ 卡自动转 **in_review（待验收）**，用户可验收标 done
- 每轮对话自动追加评论 `第 N 轮：<该轮首条用户消息>`
- 排除：`session-taskboard-*` 执行会话、子 agent（origin=subagent）、噪音标题（种子/闲聊/单字）
- 会话→卡映射持久化于 `~/.dsh/dsh-taskboard-session-links.json`

> 注意：上游 v0.5.5 自带的 `session-sync.ts`（ExternalSessionSyncService，默认关闭）语义与 tracker 重叠但**不自动建卡、无每轮评论**——本 fork 保留 tracker，不开上游开关。

### 2. 会话导入（GUI「📥 导入会话」）
- 路由：`GET /dsh-taskboard/sessions/candidates`（读 session_projcache + workspace 映射，过滤归档/子 agent/噪音）+ `POST /dsh-taskboard/sessions/import`（批量建卡）
- 弹窗：`src/client/board/SessionImportModal.tsx`，按项目分组、★ 任务感标记、全选/取消

### 3. 会话 → 卡片跳转（sidebar）
- 路由：`GET /dsh-taskboard/sessions/links`（返回全部 sessionId→taskId，过滤 trashed/已删）
- `src/client/session-card-link.ts`：会话列表每行注入跳转按钮（仅当该会话有绑定卡），点击 → 打开看板并选中对应卡
- 无绑定卡的会话行不显示按钮

### 4. 侧边栏入口 4 数字统计
- `src/client/sidebar-entry.ts` 统计条从 `[todo|in_progress|in_review]` 扩为 `[backlog|todo|in_progress|in_review]`（待规划灰色），i18n 键 `shared.stats.title` 同步

### 5. Agent 协议纪律 9/10
- `src/host/protocol-text.ts` 追加纪律 9（开场自检自动建卡，默认 todo）/ 10（留存会话导入）——上游无此内容

## 安装（本机 profile）

`~/.dsh/profiles/web/package.json`：

```json
"dsh-taskboard": "github:1254087415/dsh-taskboard"
```

（对齐 `dsh-vision-router` 的 github: 装法；本仓库预提交 `lib/` 构建产物，github: 源安装零构建。）

## 上游升级流程

```bash
cd ~/Documents/project/dsh-taskboard
git fetch upstream && git merge upstream/main   # 解决冲突（重点看 session-tracker/协议文本）
npm run build                                    # tsdown + minify（client 须 < 256KB）
git add -A && git commit -m "merge upstream + rebuild" && git push origin main
cd ~/.dsh/profiles/web && pnpm install           # 走代理 http://127.0.0.1:7897
# 重启 dsh web 使 host 侧生效（client 刷新浏览器即可）
```
