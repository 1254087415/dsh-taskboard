import { newCommentId, newTaskId } from "../shared/protocol.js";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
//#region src/host/session-tracker.ts
/**
* Session auto-tracker (0.6.0+): watch live DSH sessions and mirror their
* progress onto the board.
*
* Design (user-confirmed 2026-08-30):
* - Only sessions whose title looks like a task (fix/investigate/build/…)
*   get an auto-created TODO card, once per session (待办 = 默认；待规划
*   backlog 仅用于用户明说不急/发散性后续需求，不再自动使用).
* - Every completed turn appends a comment to the bound card:
*   「第 N 轮：<that turn's first user-message text, truncated>」so the
*   board tracks the conversation beyond the first exchange.
* - User re-engaging a session (a new user/message on a bound session) moves
*   the card back to in_progress: the user is verifying or not yet satisfied
*   (backlog/todo/in_review → in_progress, once per transition).
* - When the session goes idle (no user/message for TRACKED_IDLE_TO_REVIEW_MS)
*   an in_progress card is auto-moved to in_review with a system comment, so
*   the user can mark it done on the board after they are satisfied.
* - `session-taskboard-*` execution sessions are excluded; noise titles
*   (seeds, probes, single words) are excluded; subagent sessions excluded.
*
* @module dsh-taskboard/host/session-tracker
*/
/** Task-like title heuristic: verbs that mark a session as executable work. */
const TASKLIKE = /(修复|改造|完成|调研|排查|实现|开发|添加|新增|写|整理|部署|升级|接入|优化|梳理|检查|迁移|设计|对接|生成|配置|推送|合并|解密|集成|评估|验证|测试|搭建|构建|收集)/;
/** Titles that are seed/injection noise, never tasks. */
const NOISE_PREFIX = [
	"You are a probe agent",
	"这个模式下你需要什么",
	"Current runtime context",
	"New Session",
	"启动会话",
	"启动服务",
	"web端",
	"后端",
	"滴滴",
	"继续"
];
/**
* Idle threshold: after this long without a user message on a bound session,
* an in_progress card is auto-moved to in_review (the conversation stopped —
* the user can then mark the card done on the board). 30 minutes.
*/
const TRACKED_IDLE_TO_REVIEW_MS = 30 * 6e4;
/** Idle-sweep cadence (checked once per minute). */
const IDLE_SWEEP_MS = 6e4;
/**
* The session tracker: bind task-like sessions to board cards and append a
* per-turn progress comment.
*/
var SessionTracker = class {
	deps;
	sessionToTask = /* @__PURE__ */ new Map();
	turnCues = /* @__PURE__ */ new Map();
	subscribedTitles = /* @__PURE__ */ new Set();
	unsubscribe;
	/** Persistent sidecar links (sessionId → taskId), loaded at boot. */
	links;
	/** Last user-activity epoch per bound session (idle → in_review sweep). */
	lastActivity = /* @__PURE__ */ new Map();
	idleTimer;
	constructor(deps) {
		this.deps = deps;
		this.links = this.loadLinks();
		for (const [sid, tid] of this.links) this.sessionToTask.set(sid, tid);
		this.unsubscribe = deps.events.onSessionEvent((sessionId, event, meta) => {
			try {
				this.handleEvent(sessionId, event, meta);
			} catch {}
		});
		if (typeof setInterval === "function") this.idleTimer = setInterval(() => {
			this.sweepIdle();
		}, IDLE_SWEEP_MS);
	}
	/** Detach the event listener, stop the idle sweep, and persist links. */
	dispose() {
		this.unsubscribe();
		if (this.idleTimer !== void 0) clearInterval(this.idleTimer);
		this.persistLinks();
	}
	loadLinks() {
		try {
			const obj = JSON.parse(readFileSync(this.deps.linksFile, "utf8"));
			return new Map(Object.entries(obj));
		} catch {
			return /* @__PURE__ */ new Map();
		}
	}
	persistLinks() {
		try {
			mkdirSync(dirname(this.deps.linksFile), { recursive: true });
			writeFileSync(this.deps.linksFile, JSON.stringify(Object.fromEntries(this.links), null, 2));
		} catch {}
	}
	rememberLink(sessionId, taskId) {
		this.sessionToTask.set(sessionId, taskId);
		this.links.set(sessionId, taskId);
		this.persistLinks();
	}
	isExecutionSession(sessionId) {
		return sessionId.startsWith("session-taskboard");
	}
	looksTasklike(title) {
		const t = title.trim();
		if (t.length < 4) return false;
		if (NOISE_PREFIX.some((n) => t.startsWith(n))) return false;
		return TASKLIKE.test(t);
	}
	async handleEvent(sessionId, event, meta) {
		if (this.isExecutionSession(sessionId)) return;
		if ((meta?.origin ?? meta?.header?.origin) === "subagent") return;
		const cwd = meta?.cwd ?? meta?.header?.cwd;
		if (event.type === "session/title") {
			const title = (event.data?.title ?? "").trim();
			if (title.length === 0) return;
			if (!this.looksTasklike(title)) return;
			if (this.subscribedTitles.has(title)) {
				if (!this.sessionToTask.has(sessionId)) await this.createCard(sessionId, title, cwd);
				return;
			}
			this.subscribedTitles.add(title);
			if (!this.sessionToTask.has(sessionId)) await this.createCard(sessionId, title, cwd);
			return;
		}
		if (event.type === "user/message") {
			const text = ((event.data?.content ?? []).find((c) => c.type === "text")?.text ?? "").trim();
			if (text.length === 0) return;
			this.lastActivity.set(sessionId, this.deps.now());
			const bound = this.sessionToTask.get(sessionId);
			if (bound !== void 0) await this.promoteToInProgress(sessionId, bound);
			const cue = this.turnCues.get(sessionId);
			if (cue === void 0) this.turnCues.set(sessionId, {
				turn: 1,
				userText: text
			});
			else if (cue.userText.length === 0) cue.userText = text;
			return;
		}
		if (event.type === "turn/end") {
			const turn = event.data?.turn ?? 1;
			const cue = this.turnCues.get(sessionId);
			this.turnCues.delete(sessionId);
			this.lastActivity.set(sessionId, this.deps.now());
			const bound = this.sessionToTask.get(sessionId);
			if (bound === void 0 || cue === void 0) return;
			const body = `第 ${turn} 轮：${cue.userText.slice(0, 200)}${cue.userText.length > 200 ? "…" : ""}`;
			await this.addComment(bound, body);
			return;
		}
	}
	async createCard(sessionId, title, cwd) {
		let workspaceId;
		const sessionCwd = cwd !== void 0 && cwd.length > 0 ? cwd : await this.lookupSessionCwd(sessionId);
		if (sessionCwd !== void 0 && sessionCwd.length > 0) workspaceId = (await this.deps.workspaces.resolveByPath(sessionCwd).catch(() => void 0))?.id;
		if (workspaceId === void 0) workspaceId = this.deps.workspaces.list()[0]?.id;
		if (workspaceId === void 0) return;
		try {
			const now = this.deps.now();
			const task = {
				id: newTaskId(),
				title: `会话跟踪：${title.slice(0, 160)}`,
				description: `自动跟踪会话 ${sessionId}（创建于 ${new Date(now).toISOString()}，cwd: ${sessionCwd ?? "?"}）。每轮对话自动追加评论；重新对话自动转进行中；会话停止活跃（30 分钟无对话）自动转待验收，验收后可标记完成。`,
				prompt: "按任务目标完成工作并交接（report → comment → move in_review）。",
				workspaceId,
				urgency: "normal",
				status: "todo",
				blocked: false,
				execution: { mode: "claim" },
				isolation: "none",
				version: 1,
				createdAt: now,
				updatedAt: now,
				createdBy: { kind: "user" },
				updatedBy: { kind: "user" },
				comments: [],
				executions: []
			};
			await this.deps.store.mutate("task-created", (ledger) => {
				ledger.tasks.push(task);
				return [task];
			});
			this.rememberLink(sessionId, task.id);
		} catch {}
	}
	/**
	* Move a bound card to in_progress because the user re-engaged the session
	* (new user message). Only leaves backlog/todo/in_review; never touches
	* in_progress (already there), done, canceled, archived, or a card another
	* agent currently holds (claimedBy set and not this session).
	*/
	async promoteToInProgress(sessionId, taskId) {
		await this.deps.store.mutate("task-updated", (ledger) => {
			const task = ledger.tasks.find((t) => t.id === taskId);
			if (task === void 0) return [];
			if (task.status !== "backlog" && task.status !== "todo" && task.status !== "in_review") return [];
			if (task.claimedBy !== void 0 && task.claimedBy !== sessionId) return [];
			task.status = "in_progress";
			task.version += 1;
			task.updatedAt = this.deps.now();
			task.updatedBy = { kind: "system" };
			task.comments.push({
				id: newCommentId(),
				body: `[系统] 会话 ${sessionId} 重新收到消息，任务自动转为进行中。`,
				version: 1,
				createdAt: this.deps.now()
			});
			return [task];
		});
	}
	/**
	* Idle sweep: an in_progress card whose bound session has seen no user
	* activity for TRACKED_IDLE_TO_REVIEW_MS moves to in_review with a system
	* comment, so the user can mark the card done once satisfied. Never touches
	* cards held by another session or non-in_progress cards.
	*/
	async sweepIdle() {
		const now = this.deps.now();
		for (const [sessionId, taskId] of this.sessionToTask) {
			const last = this.lastActivity.get(sessionId);
			if (last === void 0 || now - last < TRACKED_IDLE_TO_REVIEW_MS) continue;
			await this.deps.store.mutate("task-updated", (ledger) => {
				const task = ledger.tasks.find((t) => t.id === taskId);
				if (task === void 0) return [];
				if (task.status !== "in_progress") return [];
				if (task.claimedBy !== void 0 && task.claimedBy !== sessionId) return [];
				task.status = "in_review";
				task.version += 1;
				task.updatedAt = this.deps.now();
				task.updatedBy = { kind: "system" };
				task.comments.push({
					id: newCommentId(),
					body: `[系统] 会话 ${sessionId} 已停止活跃（${Math.round(TRACKED_IDLE_TO_REVIEW_MS / 6e4)} 分钟无对话），任务自动转为待验收；满意请验收标记完成，继续对话将自动回到进行中。`,
					version: 1,
					createdAt: this.deps.now()
				});
				return [task];
			});
		}
	}
	/** Look up a session's cwd from the DSH session ledger (fail-soft). */
	async lookupSessionCwd(sessionId) {
		try {
			const { readFile } = await import("node:fs/promises");
			const { dshHomePath } = await import("./sdk.js");
			const raw = await readFile(dshHomePath("storages", "session_projcache.json"), "utf8");
			return JSON.parse(raw).tables?.sessions?.[sessionId]?.identity?.cwd;
		} catch {
			return;
		}
	}
	async addComment(taskId, body) {
		try {
			await this.deps.store.mutate("comment-added", (ledger) => {
				const task = ledger.tasks.find((t) => t.id === taskId);
				if (task === void 0) return [];
				task.comments.push({
					id: newCommentId(),
					body,
					version: 1,
					createdAt: this.deps.now()
				});
				return [task];
			});
		} catch {}
	}
};
//#endregion
export { SessionTracker };

//# sourceMappingURL=session-tracker.js.map