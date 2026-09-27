# 本地增强说明（本 fork 相对上游的差异）

> 本仓库 fork 自 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard)，在**上游 v0.6.2 基准**上重放了本机（1254087415）的本地独有增强，2026-09-11 合并至 v0.6.7，2026-09-25 合并 **upstream/main（v0.7.0–v0.8.1）**，2026-09-27 合并 **upstream/main（v0.8.2–v0.8.3）**；同时保留本 fork 的会话跟踪与卡片反向跳转增强。上游 `main` 更新时通过 `git fetch upstream && git merge upstream/main` 合并，冲突在本仓库解决。
> 完整记录见本机 `~/Documents/project/docs/dsh-taskboard-本地增强记录.md` 第 5 节。
>
> **v0.8.3 合并影响面（2026-09-27 核对）**：上游本次改动**正好覆盖本 fork 的「卡 → 会话」链路**——PR #37 把跳转从 `sessions.open`（DSH 0.1.6 起已移除）改为 `uiWorkspace.openSession`，本机 DSH 为 0.1.7-rc.2，合并后该按钮从「unavailable」恢复可用；#38 台账写入拒绝用旧快照覆盖新文件，对 tracker/sync 并发写更安全；#39/#40 修正「进行中任务被误判 failed / 认领超时误报」；#33 适配 DSH 0.1.7-rc.2 的执行开场注入。本地 5 项增强经源码逐项核对后完整保留（尚未丢失任何一处接线），`npm run typecheck` 干净、测试 360/360 通过。
>
> **归属复核（2026-09-27 修正）**：这 5 项里 ①会话跟踪、③会话跳转、④侧边栏统计 **上游都已有对应实现**（语义/方向/范围不同，见各节「归属澄清」），本 fork 的实际增量是：跟踪的建卡与评论语义、会话导入（②）、会话列表行跳卡与跟踪卡跳会话兜底、统计条的 backlog 第 4 位、协议纪律 9/10（⑤）。此前把它们统称为「本地独有」属过度表述，已更正。
>
> **本机跑测试的坑（Node 26）**：Node 26 自带 `localStorage` 全局（未指定文件时为 `undefined`），会遮住 jsdom 的实现，使 `tests/client.spec.ts` 里 30 个用例报 `Cannot read properties of undefined (reading 'clear')`——与代码无关（上游 CI 用 Node 22 不受影响）。用 `NODE_OPTIONS="--localstorage-file=/tmp/ls.db" npm test` 即可全绿。

## 本地增量清单（commit 6d71378 起，含与上游的归属对照）

### 1. 会话自动跟踪（session-tracker.ts）
- 标题含任务动词（修复/排查/开发/调研…）的新会话 → **自动建卡 todo（待办）**（上游默认 backlog 语义已改）
- 用户对历史会话**重新发消息** → 卡自动转 **in_progress（进行中）**（说明还在验证/不满意）
- 会话**停止活跃 30 分钟**（`TRACKED_IDLE_TO_REVIEW_MS`）→ 卡自动转 **in_review（待验收）**，用户可验收标 done
- 每轮对话自动追加评论 `第 N 轮：<该轮首条用户消息>`
- 排除：`session-taskboard-*` 执行会话、子 agent（origin=subagent）、噪音标题（种子/闲聊/单字）
- 会话→卡映射持久化于 `~/.dsh/dsh-taskboard-session-links.json`

> **与上游 `session-sync.ts` 的真实差别（2026-09-27 核对源码后修正）**：上游 0.5.4 起自带 `ExternalSessionSyncService`，由看板设置 `settings.syncExternalSessions` 开关（工厂默认 false；**本机台账里是 true**）。它**也会建卡**——`handleTurnStart` 在会话没有关联卡时创建标题为「会话 <sessionId 前 8 位>」、状态 `in_progress`、`claimedBy=sessionId` 的卡；`user/message` 更新标题描述、`turn/end` 结算（成功→in_review、失败→todo 并评论）；还有 4s 扫描把在跑的会话拉回 in_progress。**旧版本文档曾写「不自动建卡」，属错误记载。**
> 本 fork tracker 的**真正增量**：只在标题像任务（TASKLIKE 动词）时才建卡、建的是 **todo** 而非 in_progress、卡名带「会话跟踪：」前缀、**每轮**追加评论「第 N 轮：…」、空闲 30 分钟自动转 in_review、排除噪音/子 agent/执行会话，且不依赖看板开关。实测本机 143 张卡里 41 张「会话跟踪：」全部由 tracker 创建，上游 sync 建卡数为 0（含回收站）——两者语义不同，不构成重复建卡。

### 2. 会话导入（GUI「📥 导入会话」）
- 路由：`GET /dsh-taskboard/sessions/candidates`（读 session_projcache + workspace 映射，过滤归档/子 agent/噪音）+ `POST /dsh-taskboard/sessions/import`（批量建卡）
- 弹窗：`src/client/board/SessionImportModal.tsx`，按项目分组、★ 任务感标记、全选/取消

### 3. 会话 ↔ 卡片双向跳转
> **归属澄清**：上游**已有** `src/client/session-jump.ts`——「执行记录行 / 卡片 → 会话」方向是上游功能（0.8.3 的 PR #37 刚把它从已移除的 `sessions.open` 改成 `uiWorkspace.openSession`）。本 fork 的增量是下面两条：**会话列表行 → 卡**，以及**没有执行记录的跟踪卡 → 会话**兜底。
- 会话 → 卡：路由 `GET /dsh-taskboard/sessions/links`（返回全部 sessionId→taskId，过滤 trashed/已删）+ `src/client/session-card-link.ts`：会话列表每行注入跳转按钮（仅当该会话有绑定卡），点击 → 打开看板并选中对应卡；无绑定卡的会话行不显示按钮
- 卡 → 会话（0.6.2 补反向）：`controller.ts` refresh 并行拉 `/sessions/links` 构建 `sessionByTask`（taskId→sessionId，随 ledger 进入 snapshot，sessionLinks 缺失/失败时静默降级保留旧值）；`TaskCard.tsx` / `TaskDetail.tsx` 的 `targetSessionId` 计算在 executions/claimedBy 之后追加 `sessionByTask.get(task.id)` 兜底——让**主会话自动跟踪卡**（无执行记录、无 session 认领者）也能一键跳回来源会话。测试：`tests/client.spec.ts`「tracked-card session button via reverse session links」

### 4. 侧边栏统计条：增加 backlog 第 4 位（上游已有统计条）
> **归属澄清**：统计条本身是**上游功能**——官方侧栏面板 `dsh-atb-pstats`（todo / in_progress / in_review 三段 + `|` 分隔 + tooltip `shared.stats.title`）、旧 DOM 入口 `dsh-atb-entry-stats`（同三段 + roll 动画数字）、折叠时 `dsh-atb-pbadge` 待办角标，其样式与 i18n 键都在上游 0.8.x 里。本 fork 的增量只有下面的第 4 个数字。
- 把 **backlog（待规划）** 加进两条路径：`entryStats` 返回 4 元组、官方面板补 `data-stat="backlog"` 槽位与分隔符；i18n `shared.stats.title` 文案加「待规划」；`styles.ts` 补该槽位配色。折叠侧栏角标行为仍按上游

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
