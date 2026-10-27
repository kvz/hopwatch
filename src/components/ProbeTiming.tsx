import type { SnapshotSummary } from '../lib/snapshot.ts'

export function ProbeTiming({
  snapshot,
  previous,
  compact = false,
}: {
  snapshot: SnapshotSummary
  previous?: SnapshotSummary
  compact?: boolean
}) {
  const className = `cell-subtle probe-timing${compact ? '' : ' probe-timing--summary'}`
  if (snapshot.startedAt == null || snapshot.finishedAt == null) {
    return <div className={className}>Actual probe times unavailable (legacy cycle timestamp).</div>
  }
  const gapMs =
    previous?.finishedAt == null
      ? null
      : Date.parse(snapshot.startedAt) - Date.parse(previous.finishedAt)
  const display = (value: string): string => {
    // The row already gives the start date. Retain the date on a finish that
    // crossed midnight, and retain full timestamps in datetime/title always.
    const stamp =
      compact && value.slice(0, 10) === snapshot.startedAt?.slice(0, 10)
        ? value.slice(11)
        : value.replace('T', ' ')
    return stamp.replace('Z', ' UTC')
  }
  return (
    <div className={className}>
      {compact ? null : (
        <>
          <strong>Actual probe window</strong>
          <br />
        </>
      )}
      Started{' '}
      <time dateTime={snapshot.startedAt} title={snapshot.startedAt}>
        {display(snapshot.startedAt)}
      </time>
      <br />
      Finished{' '}
      <time dateTime={snapshot.finishedAt} title={snapshot.finishedAt}>
        {display(snapshot.finishedAt)}
      </time>
      {gapMs == null ? null : (
        <>
          <br />
          <span title="Time from the previous probe's finish to this probe's start; no packets were observed in this gap.">
            Gap since previous finish: {Math.max(0, gapMs / 1000).toFixed(1)}s
          </span>
        </>
      )}
    </div>
  )
}
