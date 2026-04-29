export interface SourceIdentity {
  datacenter: string | null
  egressIp: string | null
  hostname: string | null
  location: string | null
  provider: string | null
  providerContactEmails: string[]
  publicHostname: string | null
  siteLabel: string | null
}

export function emptySourceIdentity(): SourceIdentity {
  return {
    datacenter: null,
    egressIp: null,
    hostname: null,
    location: null,
    provider: null,
    providerContactEmails: [],
    publicHostname: null,
    siteLabel: null,
  }
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed == null || trimmed === '' ? null : trimmed
}

function normalizeList(values: string[] | null | undefined): string[] {
  const normalized = values?.map((value) => value.trim()).filter((value) => value !== '')
  return [...new Set(normalized ?? [])]
}

export function buildSourceIdentity(input: Partial<SourceIdentity>): SourceIdentity {
  return {
    datacenter: normalize(input.datacenter),
    egressIp: normalize(input.egressIp),
    hostname: normalize(input.hostname),
    location: normalize(input.location),
    provider: normalize(input.provider),
    providerContactEmails: normalizeList(input.providerContactEmails),
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
    datacenter: primary.datacenter ?? normalizedFallback.datacenter,
    egressIp: primary.egressIp ?? normalizedFallback.egressIp,
    hostname: primary.hostname ?? normalizedFallback.hostname,
    location: primary.location ?? normalizedFallback.location,
    provider: primary.provider ?? normalizedFallback.provider,
    providerContactEmails:
      primary.providerContactEmails.length > 0
        ? primary.providerContactEmails
        : normalizedFallback.providerContactEmails,
    publicHostname: primary.publicHostname ?? normalizedFallback.publicHostname,
    siteLabel: primary.siteLabel ?? normalizedFallback.siteLabel,
  }
}

function formatSourceLocation(identity: SourceIdentity): string | null {
  const providerAndLocation = [identity.provider, identity.location]
    .filter((part): part is string => part != null)
    .join(' ')
  if (providerAndLocation === '') return identity.datacenter
  return identity.datacenter == null
    ? providerAndLocation
    : `${providerAndLocation} / ${identity.datacenter}`
}

export function formatSourceIdentityInline(identity: SourceIdentity | null | undefined): string {
  if (identity == null) return 'the probing host'

  const sourceLocation = formatSourceLocation(identity)
  const parts = [
    identity.hostname,
    identity.egressIp == null ? null : `egress ${identity.egressIp}`,
    sourceLocation ?? identity.siteLabel,
  ].filter((part): part is string => part != null)

  return parts.length === 0 ? 'the probing host' : parts.join(', ')
}

export function formatSourceIdentityLines(identity: SourceIdentity | null | undefined): string[] {
  if (identity == null) return []

  return [
    identity.hostname == null ? null : `Source hostname: ${identity.hostname}`,
    identity.publicHostname == null ? null : `Source public hostname: ${identity.publicHostname}`,
    identity.egressIp == null ? null : `Source egress IP: ${identity.egressIp}`,
    identity.provider == null ? null : `Source provider: ${identity.provider}`,
    identity.providerContactEmails.length === 0
      ? null
      : `Source provider contacts: ${identity.providerContactEmails.join(', ')}`,
    identity.location == null ? null : `Source location: ${identity.location}`,
    identity.datacenter == null ? null : `Source datacenter: ${identity.datacenter}`,
    identity.siteLabel == null ? null : `Internal site label: ${identity.siteLabel}`,
  ].filter((line): line is string => line != null)
}
