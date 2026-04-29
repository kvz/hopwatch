export interface SourceIdentity {
  egressIp: string | null
  hostname: string | null
  publicHostname: string | null
  siteLabel: string | null
}

export function emptySourceIdentity(): SourceIdentity {
  return {
    egressIp: null,
    hostname: null,
    publicHostname: null,
    siteLabel: null,
  }
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed == null || trimmed === '' ? null : trimmed
}

export function buildSourceIdentity(input: Partial<SourceIdentity>): SourceIdentity {
  return {
    egressIp: normalize(input.egressIp),
    hostname: normalize(input.hostname),
    publicHostname: normalize(input.publicHostname),
    siteLabel: normalize(input.siteLabel),
  }
}

export function sourceIdentityWithFallback(
  primary: SourceIdentity,
  fallback: Partial<SourceIdentity>,
): SourceIdentity {
  const normalizedFallback = buildSourceIdentity(fallback)
  return {
    egressIp: primary.egressIp ?? normalizedFallback.egressIp,
    hostname: primary.hostname ?? normalizedFallback.hostname,
    publicHostname: primary.publicHostname ?? normalizedFallback.publicHostname,
    siteLabel: primary.siteLabel ?? normalizedFallback.siteLabel,
  }
}

export function formatSourceIdentityInline(identity: SourceIdentity | null | undefined): string {
  if (identity == null) return 'the probing host'

  const parts = [
    identity.hostname,
    identity.egressIp == null ? null : `egress ${identity.egressIp}`,
    identity.siteLabel,
  ].filter((part): part is string => part != null)

  return parts.length === 0 ? 'the probing host' : parts.join(', ')
}

export function formatSourceIdentityLines(identity: SourceIdentity | null | undefined): string[] {
  if (identity == null) return []

  return [
    identity.hostname == null ? null : `Source hostname: ${identity.hostname}`,
    identity.publicHostname == null ? null : `Source public hostname: ${identity.publicHostname}`,
    identity.egressIp == null ? null : `Source egress IP: ${identity.egressIp}`,
    identity.siteLabel == null ? null : `Source site/datacenter: ${identity.siteLabel}`,
  ].filter((line): line is string => line != null)
}
