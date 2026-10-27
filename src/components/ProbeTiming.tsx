import type { SnapshotSummary } from '../lib/snapshot.ts'

export function ProbeTiming({
  snapshot,
  previous,
}: {
  snapshot: SnapshotSummary
  previous?: SnapshotSummary
}) {
  if (snapshot.startedAt == null || snapshot.finishedAt == null) {
    return (
      <div className="cell-subtle">Actual probe times unavailable (legacy cycle timestamp).</div>
    )
  }
  const gapMs =
    previous?.finishedAt == null
      ? null
      : Date.parse(snapshot.startedAt) - Date.parse(previous.finishedAt)
  return (
    <div className="cell-subtle">
      Started <time dateTime={snapshot.startedAt}>{snapshot.startedAt}</time>
      <br />
      Finished <time dateTime={snapshot.finishedAt}>{snapshot.finishedAt}</time>
      {gapMs == null ? null : (
        <>
          <br />
          Gap before probe: {Math.max(0, gapMs / 1000).toFixed(1)}s
        </>
      )}
    </div>
  )
}
