import type { ReactNode } from 'react'
import { formatRelativeCollectedAt, parseCollectedAt } from '../lib/snapshot.ts'

interface RelativeTimeProps {
  collectedAt: string
  now: number
  className?: string
  title?: string
}

// Renders a relative "Nm ago" timestamp inside a <time> element that the
// progressive-enhancement client script (src/client/relative-time.ts) re-ticks
// every 60s. The datetime attribute carries the absolute ISO string so the
// client has enough to re-compute the label without hitting the server.
export function RelativeTime({ collectedAt, now, className, title }: RelativeTimeProps): ReactNode {
  const timestamp = parseCollectedAt(collectedAt)
  const iso = timestamp == null ? undefined : new Date(timestamp).toISOString()
  return (
    <time className={className} dateTime={iso} data-relative title={title}>
      {formatRelativeCollectedAt(collectedAt, now)}
    </time>
  )
}
