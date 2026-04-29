// Derive a short "variant" pill string for a target from its structured
// probe config. Operators write a service-level label once ("Amazon S3
// us-west-2") and hopwatch composes the probe-path distinction from the
// other fields the operator already set. Keeps labels from drifting out
// of sync with the actual probe configuration and avoids the three-way
// inconsistency that had crept in ("Amazon S3 us-west-2 via Namespace"
// vs "Amazon S3 us-west-2 (TCP 443, mtr)" vs "Amazon S3 us-west-2 (s3.us
// -west-2.amazonaws.com)").
//
// Returns null when the target uses the vanilla defaults (ICMP, mtr,
// no netns). In that case the label is the full story and no pill is
// needed.

import type { ProbeEngine, ProbeMode, ProbeProtocol } from './config.ts'

export interface TargetVariantInput {
  engine: ProbeEngine
  netns: string | null
  port: number
  probeMode: ProbeMode
  protocol: ProbeProtocol
}

export function deriveTargetVariant(input: TargetVariantInput): string | null {
  const parts: string[] = []
  if (input.protocol === 'tcp') {
    parts.push(`TCP ${input.port}`)
  }
  if (input.probeMode === 'netns' && input.netns != null && input.netns !== '') {
    parts.push(`via netns ${input.netns}`)
  }
  // Engine is an implementation-level distinction. Only surface it when it
  // deviates from the default `mtr`, so the common case stays quiet.
  if (input.engine === 'native') {
    parts.push('native')
  } else if (input.engine === 'connect') {
    parts.push('connect')
  }
  if (parts.length === 0) return null
  // ` · ` (middle dot with spaces) reads better than slashes or pipes in
  // a narrow UI pill and doesn't fight the `-` separator we already use in
  // hostnames. Plain " / " would collide with the loss-counts line
  // ("N downstream / M isolated") in the same cell.
  return parts.join(' · ')
}
