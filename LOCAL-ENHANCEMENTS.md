# 本地增强说明（本 fork 相对上游的差异）

> 本仓库 fork 自 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard)，在**上游 v0.6.2 基准**上重放了本机（1254087415）的本地独有增强，2026-09-11 合并至 v0.6.7，2026-09-25 合并 **upstream/main（v0.7.0–v0.8.1）**，2026-09-27 合并 **upstream/main（v0.8.2–v0.8.3）**；同时保留本 fork 的会话跟踪与卡片反向跳转增强。上游 `main` 更新时通过 `git fetch upstream && git merge upstream/main` 合并，冲突在本仓库解决。
> 完整记录见本机 `~/Documents/project/docs/dsh-taskboard-本地增强记录.md` 第 5 节。
>
> **v0.8.3 合并影响面（2026-09-27 核对）**：上游本次改动**正好覆盖本 fork 的「卡 → 会话」链路**——PR #37 把跳转从 `sessions.open`（DSH 0.1.6 起已移除）改为 `uiWorkspace.openSession`，本机 DSH 为 0.1.7-rc.2，合并后该按钮从「unavailable」恢复可用；#38 台账写入拒绝用旧快照覆盖新文件，对 tracker/sync 并发写更安全；#39/#40 修正「进行中任务被误判 failed / 认领超时误报」；#33 适配 DSH 0.1.7-rc.2 的执行开场注入。本地 5 项增强（session-tracker / 会话导入 / 双向跳转 / 侧边栏 4 数字 / 协议纪律 9-10）经文件与接线逐项核对后完整保留，`npm run typecheck` 干净、测试 360/360 通过。
>
> **本机跑测试的坑（Node 26）**：Node 26 自带 `localStorage` 全局（未指定文件时为 `undefined`），会遮住 jsdom 的实现，使 `tests/client.spec.ts` 里 30 个用例报 `Cannot read properties of undefined (reading 'clear')`——与代码无关（上游 CI 用 Node 22 不受影响）。用 `NODE_OPTIONS="--localstorage-file=/tmp/ls.db" npm test` 即可全绿。

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

### 3. 会话 ↔ 卡片双向跳转
- 会话 → 卡：路由 `GET /dsh-taskboard/sessions/links`（返回全部 sessionId→taskId，过滤 trashed/已删）+ `src/client/session-card-link.ts`：会话列表每行注入跳转按钮（仅当该会话有绑定卡），点击 → 打开看板并选中对应卡；无绑定卡的会话行不显示按钮
- 卡 → 会话（0.6.2 补反向）：`controller.ts` refresh 并行拉 `/sessions/links` 构建 `sessionByTask`（taskId→sessionId，随 ledger 进入 snapshot，sessionLinks 缺失/失败时静默降级保留旧值）；`TaskCard.tsx` / `TaskDetail.tsx` 的 `targetSessionId` 计算在 executions/claimedBy 之后追加 `sessionByTask.get(task.id)` 兜底——让**主会话自动跟踪卡**（无执行记录、无 session 认领者）也能一键跳回来源会话。测试：`tests/client.spec.ts`「tracked-card session button via reverse session links」

### 4. 侧边栏入口 4 数字统计
- 旧版 DOM 入口和新版官方侧栏入口均显示 `[backlog|todo|in_progress|in_review]`，待规划为灰色；折叠侧栏仍按上游行为显示待办角标。i18n 键 `shared.stats.title` 同步

### 5. Agent 协议纪律 9/10
- `src/host/protocol-text.ts` 追加纪律 9（开场自检自动建卡，默认 todo）/ 10（留存会话导入）——上游无此内容

## 安装（本机 profile）

如需让本机 web profile 使用此 fork，可将 `~/.dsh/profiles/web/package.json` 中的依赖设为：

```json
"dsh-taskboard": "link:/Users/zab/Documents/project/dsh-taskboard"
```

更新源码后执行 `npm run build`，再重启 `dsh web` 使 host 侧生效；客户端刷新浏览器即可。

## 上游升级流程

```bash
cd ~/Documents/project/dsh-taskboard
git fetch upstream && git merge upstream/main   # 合并上游并保留本地会话增强
npm run build                                    # 重建 host 与 client 产物
# link 安装会直接使用当前仓库的 lib/；host 改动需重启 dsh web
```
