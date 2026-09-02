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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { newCommentId, newTaskId, type TaskRecord } from '../shared/protocol.ts'
import type { TaskStore } from './store.ts'
import type { WorkspaceFace } from './tools.ts'

/** Narrow event-bus face (same shape as execution's EventsFace). */
export interface TrackerEventsFace {
  onSessionEvent(
    listener: (sessionId: string, event: { type: string; data?: unknown }, sessionMeta?: TrackerSessionMeta) => void,
  ): () => void
}

/** Narrow view of the session meta the 0.6.2 event bridge passes along. */
export interface TrackerSessionMeta {
  header?: { cwd?: string; origin?: 'subagent' }
  origin?: 'subagent'
  cwd?: string
}

/** Everything the tracker needs. */
export interface TrackerDeps {
  store: TaskStore
  events: TrackerEventsFace
  workspaces: WorkspaceFace
  now: () => number
  /** Sidecar file path for the sessionId → taskId map. */
  linksFile: string
}

/** Task-like title heuristic: verbs that mark a session as executable work. */
const TASKLIKE = /(修复|改造|完成|调研|排查|实现|开发|添加|新增|写|整理|部署|升级|接入|优化|梳理|检查|迁移|设计|对接|生成|配置|推送|合并|解密|集成|评估|验证|测试|搭建|构建|收集)/

/** Titles that are seed/injection noise, never tasks. */
const NOISE_PREFIX = [
  'You are a probe agent',
  '这个模式下你需要什么',
  'Current runtime context',
  'New Session',
  '启动会话',
  '启动服务',
  'web端',
  '后端',
  '滴滴',
  '继续',
]

/**
 * Idle threshold: after this long without a user message on a bound session,
 * an in_progress card is auto-moved to in_review (the conversation stopped —
 * the user can then mark the card done on the board). 30 minutes.
 */
const TRACKED_IDLE_TO_REVIEW_MS = 30 * 60_000

/** Idle-sweep cadence (checked once per minute). */
const IDLE_SWEEP_MS = 60_000

/** One turn's textual cue (first user text seen during the turn). */
interface TurnCue {
  turn: number
  userText: string
}

/**
 * The session tracker: bind task-like sessions to board cards and append a
 * per-turn progress comment.
 */
export class SessionTracker {
  private readonly sessionToTask = new Map<string, string>()
  private readonly turnCues = new Map<string, TurnCue>()
  private readonly subscribedTitles = new Set<string>()
  private readonly unsubscribe: () => void
  /** Persistent sidecar links (sessionId → taskId), loaded at boot. */
  private readonly links: Map<string, string>
  /** Last user-activity epoch per bound session (idle → in_review sweep). */
  private readonly lastActivity = new Map<string, number>()
  private readonly idleTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: TrackerDeps) {
    this.links = this.loadLinks()
    for (const [sid, tid] of this.links) this.sessionToTask.set(sid, tid)
    this.unsubscribe = deps.events.onSessionEvent((sessionId, event, meta) => {
      try { void this.handleEvent(sessionId, event, meta) } catch { /* tracker never throws */ }
    })
    if (typeof setInterval === 'function') {
      this.idleTimer = setInterval(() => { void this.sweepIdle() }, IDLE_SWEEP_MS)
    }
  }

  /** Detach the event listener, stop the idle sweep, and persist links. */
  dispose(): void {
    this.unsubscribe()
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.persistLinks()
  }

  // ------------------------------------------------------------- persistence
  private loadLinks(): Map<string, string> {
    try {
      const obj = JSON.parse(readFileSync(this.deps.linksFile, 'utf8')) as Record<string, string>
      return new Map(Object.entries(obj))
    } catch {
      return new Map()
    }
  }

  private persistLinks(): void {
    try {
      mkdirSync(dirname(this.deps.linksFile), { recursive: true })
      writeFileSync(this.deps.linksFile, JSON.stringify(Object.fromEntries(this.links), null, 2))
    } catch { /* cosmetic */ }
  }

  private rememberLink(sessionId: string, taskId: string): void {
    this.sessionToTask.set(sessionId, taskId)
    this.links.set(sessionId, taskId)
    this.persistLinks()
  }

  // --------------------------------------------------------------- heuristics
  private isExecutionSession(sessionId: string): boolean {
    return sessionId.startsWith('session-taskboard')
  }

  private looksTasklike(title: string): boolean {
    const t = title.trim()
    if (t.length < 4) return false
    if (NOISE_PREFIX.some(n => t.startsWith(n))) return false
    return TASKLIKE.test(t)
  }

  // ------------------------------------------------------------------- events
  private async handleEvent(sessionId: string, event: { type: string; data?: unknown }, meta?: TrackerSessionMeta): Promise<void> {
    if (this.isExecutionSession(sessionId)) return
    // Subagent children are derived work, not conversations to track.
    // Accept both the 0.6.2 bridge shape ({header:{origin}}) and the legacy
    // flat shape ({origin}).
    const origin = meta?.origin ?? meta?.header?.origin
    if (origin === 'subagent') return
    const cwd = meta?.cwd ?? meta?.header?.cwd

    if (event.type === 'session/title') {
      const title = ((event.data as { title?: string } | undefined)?.title ?? '').trim()
      if (title.length === 0) return
      if (!this.looksTasklike(title)) return
      if (this.subscribedTitles.has(title)) {
        // Same title seen again: make sure the session got bound.
        if (!this.sessionToTask.has(sessionId)) await this.createCard(sessionId, title, cwd)
        return
      }
      this.subscribedTitles.add(title)
      if (!this.sessionToTask.has(sessionId)) {
        await this.createCard(sessionId, title, cwd)
      }
      return
    }

    if (event.type === 'user/message') {
      const data = event.data as { content?: Array<{ type?: string; text?: string }> } | undefined
      const text = ((data?.content ?? []).find(c => c.type === 'text')?.text ?? '').trim()
      if (text.length === 0) return
      // Any user message = active engagement: refresh the idle clock and
      // (re)move the bound card to in_progress — the user is verifying or
      // still not satisfied, so the card must leave backlog/todo/in_review.
      this.lastActivity.set(sessionId, this.deps.now())
      const bound = this.sessionToTask.get(sessionId)
      if (bound !== undefined) await this.promoteToInProgress(sessionId, bound)
      const cue = this.turnCues.get(sessionId)
      if (cue === undefined) {
        this.turnCues.set(sessionId, { turn: 1, userText: text })
      } else if (cue.userText.length === 0) {
        cue.userText = text
      }
      return
    }

    if (event.type === 'turn/end') {
      const data = event.data as { turn?: number } | undefined
      const turn = data?.turn ?? 1
      const cue = this.turnCues.get(sessionId)
      this.turnCues.delete(sessionId)
      // A finished turn also counts as recent activity (user just engaged).
      this.lastActivity.set(sessionId, this.deps.now())
      const bound = this.sessionToTask.get(sessionId)
      if (bound === undefined || cue === undefined) return
      const body = `第 ${turn} 轮：${cue.userText.slice(0, 200)}${cue.userText.length > 200 ? '…' : ''}`
      await this.addComment(bound, body)
      return
    }
  }

  // -------------------------------------------------------------------- board
  private async createCard(sessionId: string, title: string, cwd?: string): Promise<void> {
    // Workspace: resolve from the session's cwd when available (workspaces
    // face resolves any registered path); fall back to the first registered
    // workspace for sessions without a cwd.
    let workspaceId: string | undefined
    const sessionCwd = cwd !== undefined && cwd.length > 0 ? cwd : await this.lookupSessionCwd(sessionId)
    if (sessionCwd !== undefined && sessionCwd.length > 0) {
      const ws = await this.deps.workspaces.resolveByPath(sessionCwd).catch(() => undefined)
      workspaceId = ws?.id
    }
    if (workspaceId === undefined) workspaceId = this.deps.workspaces.list()[0]?.id
    if (workspaceId === undefined) return
    try {
      const now = this.deps.now()
      const task: TaskRecord = {
        id: newTaskId(),
        title: `会话跟踪：${title.slice(0, 160)}`,
        description: `自动跟踪会话 ${sessionId}（创建于 ${new Date(now).toISOString()}，cwd: ${sessionCwd ?? '?'}）。每轮对话自动追加评论；重新对话自动转进行中；会话停止活跃（30 分钟无对话）自动转待验收，验收后可标记完成。`,
        prompt: '按任务目标完成工作并交接（report → comment → move in_review）。',
        workspaceId,
        urgency: 'normal',
        status: 'todo',
        blocked: false,
        execution: { mode: 'claim' },
        isolation: 'none',
        version: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'user' },
        updatedBy: { kind: 'user' },
        comments: [],
        executions: [],
      }
      await this.deps.store.mutate('task-created', ledger => {
        ledger.tasks.push(task)
        return [task]
      })
      this.rememberLink(sessionId, task.id)
    } catch { /* workspace race — session stays untracked */ }
  }

  /**
   * Move a bound card to in_progress because the user re-engaged the session
   * (new user message). Only leaves backlog/todo/in_review; never touches
   * in_progress (already there), done, canceled, archived, or a card another
   * agent currently holds (claimedBy set and not this session).
   */
  private async promoteToInProgress(sessionId: string, taskId: string): Promise<void> {
    await this.deps.store.mutate('task-updated', ledger => {
      const task = ledger.tasks.find(t => t.id === taskId)
      if (task === undefined) return []
      if (task.status !== 'backlog' && task.status !== 'todo' && task.status !== 'in_review') return []
      // Do not steal a card an execution session is working on.
      if (task.claimedBy !== undefined && task.claimedBy !== sessionId) return []
      task.status = 'in_progress'
      task.version += 1
      task.updatedAt = this.deps.now()
      task.updatedBy = { kind: 'system' }
      task.comments.push({
        id: newCommentId(),
        body: `[系统] 会话 ${sessionId} 重新收到消息，任务自动转为进行中。`,
        version: 1,
        createdAt: this.deps.now(),
      })
      return [task]
    })
  }

  /**
   * Idle sweep: an in_progress card whose bound session has seen no user
   * activity for TRACKED_IDLE_TO_REVIEW_MS moves to in_review with a system
   * comment, so the user can mark the card done once satisfied. Never touches
   * cards held by another session or non-in_progress cards.
   */
  private async sweepIdle(): Promise<void> {
    const now = this.deps.now()
    for (const [sessionId, taskId] of this.sessionToTask) {
      const last = this.lastActivity.get(sessionId)
      if (last === undefined || now - last < TRACKED_IDLE_TO_REVIEW_MS) continue
      await this.deps.store.mutate('task-updated', ledger => {
        const task = ledger.tasks.find(t => t.id === taskId)
        if (task === undefined) return []
        if (task.status !== 'in_progress') return []
        if (task.claimedBy !== undefined && task.claimedBy !== sessionId) return []
        task.status = 'in_review'
        task.version += 1
        task.updatedAt = this.deps.now()
        task.updatedBy = { kind: 'system' }
        task.comments.push({
          id: newCommentId(),
          body: `[系统] 会话 ${sessionId} 已停止活跃（${Math.round(TRACKED_IDLE_TO_REVIEW_MS / 60_000)} 分钟无对话），任务自动转为待验收；满意请验收标记完成，继续对话将自动回到进行中。`,
          version: 1,
          createdAt: this.deps.now(),
        })
        return [task]
      })
    }
  }

  /** Look up a session's cwd from the DSH session ledger (fail-soft). */
  private async lookupSessionCwd(sessionId: string): Promise<string | undefined> {
    try {
      const { readFile } = await import('node:fs/promises')
      const { dshHomePath } = await import('./sdk.ts')
      const raw = await readFile(dshHomePath('storages', 'session_projcache.json'), 'utf8')
      const doc = JSON.parse(raw) as { tables?: { sessions?: Record<string, { identity?: { cwd?: string } }> } }
      return doc.tables?.sessions?.[sessionId]?.identity?.cwd
    } catch {
      return undefined
    }
  }

  private async addComment(taskId: string, body: string): Promise<void> {
    try {
      await this.deps.store.mutate('comment-added', ledger => {
        const task = ledger.tasks.find(t => t.id === taskId)
        if (task === undefined) return []
        task.comments.push({
          id: newCommentId(),
          body,
          version: 1,
          createdAt: this.deps.now(),
        })
        return [task]
      })
    } catch { /* task deleted meanwhile — drop */ }
  }
}