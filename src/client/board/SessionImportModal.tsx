/**
 * Session-import modal (0.6.0): list retained DSH sessions filtered to
 * import candidates (archived / subagent / noise excluded), let the user
 * tick rows, and batch-create board cards from the picks.
 *
 * @module dsh-taskboard/client/board/SessionImportModal
 */
import { useEffect, useMemo, useState } from 'react'
import type { BoardController } from '../controller.ts'
import type { SessionCandidate, SessionImportResult } from '../../shared/api.ts'
import { useAlert } from './AlertModal.tsx'

/**
 * The session-import modal.
 * @param controller - the controller.
 */
export function SessionImportModal({ controller }: { controller: BoardController }) {
  const [candidates, setCandidates] = useState<SessionCandidate[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SessionImportResult | undefined>(undefined)
  const { alert: showAlert, el: alertEl } = useAlert()

  /** Load candidates once on open. */
  useEffect(() => {
    let alive = true
    void controller.sessionCandidates().then(
      list => { if (alive && list !== undefined) { setCandidates(list); setPicked(new Set(list.filter(c => c.taskLike).map(c => c.sessionId))) } },
      (err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)) },
    )
    return () => { alive = false }
  }, [controller])

  /** Group by workspace, preserving task-like rows first within each group. */
  const groups = useMemo(() => {
    if (candidates === undefined) return []
    const byWs = new Map<string, SessionCandidate[]>()
    for (const c of candidates) {
      const arr = byWs.get(c.workspaceId) ?? []
      arr.push(c)
      byWs.set(c.workspaceId, arr)
    }
    const wsName = new Map<string, string>()
    for (const c of candidates) wsName.set(c.workspaceId, c.workspaceTitle || c.workspaceId)
    const out: Array<{ workspaceId: string; name: string; rows: SessionCandidate[] }> = []
    for (const [wid, rows] of byWs) {
      rows.sort((a, b) => (b.taskLike ? 1 : 0) - (a.taskLike ? 1 : 0) || a.title.localeCompare(b.title, 'zh'))
      out.push({ workspaceId: wid, name: wsName.get(wid) ?? wid, rows })
    }
    out.sort((a, b) => b.rows.length - a.rows.length)
    return out
  }, [candidates])

  const toggle = (sessionId: string): void => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const toggleAll = (rows: SessionCandidate[]): void => {
    setPicked(prev => {
      const next = new Set(prev)
      const allPicked = rows.every(r => next.has(r.sessionId))
      for (const r of rows) {
        if (allPicked) next.delete(r.sessionId)
        else next.add(r.sessionId)
      }
      return next
    })
  }

  const importPicks = async (): Promise<void> => {
    if (candidates === undefined || picked.size === 0) return
    setBusy(true)
    setResult(undefined)
    try {
      const picks = candidates.filter(c => picked.has(c.sessionId)).map(c => ({ sessionId: c.sessionId, title: c.title, workspaceId: c.workspaceId }))
      const res = await controller.importSessions(picks)
      if (res === undefined) return
      setResult(res)
      await controller.refresh()
      if (res.errors.length > 0) {
        showAlert(`部分导入失败（${res.errors.length} 个）：${res.errors[0]?.error ?? ''}`)
      } else {
        showAlert(`已导入 ${res.created.length} 个会话为看板任务`)
      }
    } catch (err) {
      showAlert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dsh-atb-modal" role="dialog" aria-modal="true" aria-label="导入留存会话">
      <div className="dsh-atb-modal-card" style={{ width: 640, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="dsh-atb-modal-header">
          <h3>📥 导入留存会话</h3>
          <button type="button" className="dsh-atb-btn" onClick={() => controller.closeSessionImport()}>✕</button>
        </div>
        <div className="dsh-atb-modal-body" style={{ overflowY: 'auto', flex: 1 }}>
          {error !== undefined && <p className="dsh-atb-err" style={{ color: '#c0392b' }}>加载失败：{error}</p>}
          {candidates === undefined && error === undefined && <p>加载候选会话…</p>}
          {candidates !== undefined && candidates.length === 0 && <p>没有可导入的留存会话（已排除归档、子 agent 与噪音会话）。</p>}
          {groups.map(g => (
            <fieldset key={g.workspaceId} style={{ border: '1px solid #ddd', borderRadius: 6, margin: '8px 0', padding: 8 }}>
              <legend style={{ fontWeight: 600 }}>
                <label style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={g.rows.length > 0 && g.rows.every(r => picked.has(r.sessionId))}
                    onChange={() => toggleAll(g.rows)}
                  />
                  {' '}{g.name}（{g.rows.length}）
                </label>
              </legend>
              {g.rows.map(c => (
                <label key={c.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={picked.has(c.sessionId)} onChange={() => toggle(c.sessionId)} />
                  <span title={c.sessionId}>{c.taskLike ? '★ ' : ''}{c.title}</span>
                </label>
              ))}
            </fieldset>
          ))}
          {result !== undefined && (
            <p style={{ marginTop: 8 }}>
              已创建 {result.created.length} 张卡；失败 {result.errors.length} 个。
              {result.created.length > 0 && ' 可在看板中查看并认领。'}
            </p>
          )}
        </div>
        <div className="dsh-atb-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8 }}>
          <button type="button" className="dsh-atb-btn" onClick={() => controller.closeSessionImport()}>取消</button>
          <button
            type="button"
            className="dsh-atb-btn"
            data-primary="true"
            disabled={busy || picked.size === 0}
            onClick={() => void importPicks()}
          >
            {busy ? '导入中…' : `导入 ${picked.size} 个`}
          </button>
        </div>
      </div>
      {alertEl}
    </div>
  )
}
