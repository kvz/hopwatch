// Progressive-enhancement client script: finds every <time data-relative>
// element on the page and re-renders its text content from the `dateTime`
// attribute on a 60s cadence so "Nm ago" labels don't go stale while the user
// keeps the tab open. No React, no bundler - mirrors the sortable-tables
// sibling script.

const TICK_MS = 60 * 1000

export function formatRelative(fromMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - fromMs)
  const diffSeconds = Math.max(1, Math.round(diffMs / 1000))
  if (diffSeconds < 60) return `${diffSeconds}s ago`
  const diffMinutes = Math.round(diffSeconds / 60)
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}

export function tickAll(root: ParentNode = document): void {
  const nodes = Array.from(root.querySelectorAll<HTMLTimeElement>('time[data-relative]'))
  const now = Date.now()
  for (const node of nodes) {
    const iso = node.getAttribute('datetime')
    if (iso == null) continue
    const parsed = Date.parse(iso)
    if (Number.isNaN(parsed)) continue
    node.textContent = formatRelative(parsed, now)
  }
}

if (typeof document !== 'undefined') {
  const start = (): void => {
    tickAll()
    setInterval(() => tickAll(), TICK_MS)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
}
