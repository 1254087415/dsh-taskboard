/**
 * Session → card jump entry (0.6.1): inject a small button into every sidebar
 * session row whose session is bound to a board card, so the user can jump
 * from the Session log to the tracked card.
 *
 * The sidebar rows carry no sessionId attribute (the shell renders them with
 * hashed CSS-module classes only), so rows are matched by title: the runtime
 * `sessions` service exposes `displayTitle` per sessionId, and each row shows
 * that same title in its `.YDXeBa_title` span. We build sessionId → card from
 * the host `/sessions/links` route (host-owned session-tracker links file) and
 * match row titles against the live session list.
 *
 * The row is plain DOM (no React tree), mirroring sidebar-entry.ts: a
 * body-level MutationObserver self-heals re-renders, a slow timer covers late
 * mounts, and failures only degrade the jump entry — never the GUI.
 *
 * @module dsh-taskboard/client/session-card-link
 */
import type { TaskboardClient, } from './api.ts'
import type { BoardController } from './controller.ts'
import type { SessionsServiceFace } from './session-jump.ts'

/** Stable data attribute identifying an injected jump button. */
const BTN_SELECTOR = '[data-dsh-atb-sesslink]'

/** Inline card icon (16px, matches the sidebar entry look). */
const ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5h6M5 9.5h3"/></svg>'

/** Lazy runtime access (services may appear after apply). */
export interface SessionCardLinkDeps {
  client: TaskboardClient
  controller: BoardController
  /** The runtime sessions service, when currently provided. */
  getSessions(): SessionsServiceFace | undefined
}

/**
 * Mount the session→card jump injector.
 * @param deps - client + controller + lazy runtime session access.
 * @returns disposer removing injected buttons and observers.
 */
export function mountSessionCardLinks(deps: SessionCardLinkDeps): () => void {
  // sessionId → {taskId, title, status} from the host (refreshed lazily).
  let links = new Map<string, { taskId: string; title: string; status: string }>()

  const loadLinks = async (): Promise<void> => {
    try {
      const rows = await deps.client.sessionLinks()
      const next = new Map<string, { taskId: string; title: string; status: string }>()
      for (const row of rows) next.set(row.sessionId, { taskId: row.taskId, title: row.title, status: row.status })
      links = next
    } catch {
      // Keep the previous snapshot; retry on the next tick.
    }
  }

  /** Live sessionId → displayTitle (matching the sidebar rows). */
  const titlesBySession = (): Map<string, string> => {
    const out = new Map<string, string>()
    const sessions = deps.getSessions()
    if (sessions === undefined) return out
    const byId = sessions.list.getSnapshot().byId
    for (const [sessionId, value] of Object.entries(byId)) {
      const display = (value as { displayTitle?: string } | undefined)?.displayTitle
      const title = display?.trim()
      if (title !== undefined && title.length > 0) out.set(sessionId, title)
    }
    return out
  }

  /** True when the row already carries our jump button. */
  const hasButton = (row: Element): boolean => row.querySelector(BTN_SELECTOR) !== null

  /** Inject the jump button into one session row (no-op when already there). */
  const injectRow = (row: Element, sessionId: string, card: { taskId: string; title: string; status: string }): void => {
    if (hasButton(row)) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.dshAtbSesslink = ''
    btn.className = 'dsh-atb-sesslink'
    btn.setAttribute('aria-label', `跳转看板卡片 ${card.taskId}`)
    btn.title = `${card.title}（${card.status}）→ 看板 ${card.taskId}`
    btn.innerHTML = ICON
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      event.preventDefault()
      deps.controller.openBoard()
      deps.controller.select(card.taskId)
    })
    row.appendChild(btn)
  }

  /** DOM-only sweep: match rows and inject buttons using the cached links. */
  const sweepDom = (): void => {
    if (links.size === 0) return
    const titles = titlesBySession()
    if (titles.size === 0) return
    // Session rows use shell CSS-module hashed classes (e.g. YDXeBa_sessionRow);
    // match on the stable "sessionRow" suffix — "projectRow" headers do not
    // contain it, so plain substring matching is safe across frontend rebuilds.
    const rows = Array.from(document.querySelectorAll('[class*="sessionRow"]'))
    for (const row of rows) {
      const titleEl = Array.from(row.querySelectorAll('span'))
        .find(el => /_title$/.test(el.className) && (el.textContent?.trim() ?? '').length > 0)
      if (titleEl === undefined) continue
      const rowTitle = titleEl.textContent?.trim() ?? ''
      if (rowTitle.length === 0) continue
      // Match the row title against live sessions; pick the first bound one.
      let matched: { sessionId: string; card: { taskId: string; title: string; status: string } } | undefined
      for (const [sessionId, title] of titles) {
        if (title === rowTitle) {
          const card = links.get(sessionId)
          if (card !== undefined) { matched = { sessionId, card }; break }
        }
      }
      if (matched !== undefined) injectRow(row, matched.sessionId, matched.card)
    }
  }

  // Body-level watcher: self-heal after re-renders (same as sidebar-entry).
  // DOM-only — data refreshes on the slower interval below, never per-mutation.
  const observer = new MutationObserver(sweepDom)
  observer.observe(document.body, { childList: true, subtree: true })
  // Data refresh: first sweep immediately, then every 30s so new tracking
  // cards appear without a reload (a missing host route fails softly and is
  // retried on the next tick — no error spam).
  void loadLinks().then(sweepDom)
  const retry = setInterval(() => { void loadLinks().then(sweepDom) }, 30_000)

  return () => {
    clearInterval(retry)
    observer.disconnect()
    for (const btn of Array.from(document.querySelectorAll(BTN_SELECTOR))) btn.remove()
  }
}
