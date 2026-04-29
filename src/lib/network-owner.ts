import { resolveTxt } from 'node:dns/promises'

const RDAP_TIMEOUT_MS = 2_500
const CYMRU_TIMEOUT_MS = 1_500

export interface NetworkOwnerInfo {
  asName: string | null
  asn: string | null
  contactEmails: string[]
  country: string | null
  fetchedAt: string
  ip: string
  prefix: string | null
  rdapName: string | null
  registry: string | null
  source: string
}

interface CymruOrigin {
  asn: string | null
  country: string | null
  prefix: string | null
  registry: string | null
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: UnknownRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function uniqueSortedEmails(emails: Iterable<string>): string[] {
  const unique = [...new Set([...emails].map((email) => email.trim()).filter(Boolean))]
  return unique.sort((left, right) => {
    const leftRank = emailRank(left)
    const rightRank = emailRank(right)
    return leftRank - rightRank || left.localeCompare(right)
  })
}

function emailRank(email: string): number {
  const lower = email.toLowerCase()
  if (lower.includes('noc')) return 0
  if (lower.includes('netops') || lower.includes('peering')) return 1
  if (lower.includes('support')) return 2
  if (lower.includes('abuse')) return 3
  return 4
}

function firstTxtRecord(records: string[][]): string | null {
  const first = records[0]
  if (first == null) return null
  const joined = first.join('').trim()
  return joined === '' ? null : joined
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

export function extractIpv4Address(value: string): string | null {
  const match = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/.exec(value)
  return match?.[0] ?? null
}

export function cleanAsName(raw: string | null): string | null {
  if (raw == null) return null
  let name = raw.trim()
  if (name === '') return null

  const dashParts = name.split(/\s+-\s+/, 2)
  if (dashParts.length === 2 && dashParts[1].trim() !== '') {
    name = dashParts[1].trim()
  }

  const firstSpace = name.indexOf(' ')
  if (firstSpace > 0) {
    const firstToken = name.slice(0, firstSpace)
    const rest = name.slice(firstSpace + 1).trim()
    if (/^[A-Z0-9-]+$/.test(firstToken) && /[a-z]/.test(rest)) {
      name = rest
    }
  }

  name = name.replace(/,\s*[A-Z]{2}$/u, '').trim()
  return name === '' ? null : name
}

export function formatNetworkOwnerLabel(owner: NetworkOwnerInfo): string {
  const displayName = cleanAsName(owner.asName) ?? owner.rdapName ?? owner.prefix ?? owner.ip
  return owner.asn == null ? displayName : `${displayName} (${owner.asn})`
}

function parseCymruOrigin(record: string | null): CymruOrigin {
  if (record == null) {
    return { asn: null, country: null, prefix: null, registry: null }
  }

  const parts = record.split('|').map((part) => part.trim())
  const asn = parts[0] == null || parts[0] === 'NA' ? null : `AS${parts[0]}`
  return {
    asn,
    country: parts[2] ?? null,
    prefix: parts[1] ?? null,
    registry: parts[3] ?? null,
  }
}

function parseCymruAsName(record: string | null): string | null {
  if (record == null) return null
  const parts = record.split('|').map((part) => part.trim())
  return cleanAsName(parts[4] ?? null)
}

async function lookupCymru(ip: string): Promise<CymruOrigin & { asName: string | null }> {
  const originName = `${ip.split('.').reverse().join('.')}.origin.asn.cymru.com`
  const originRecord = await withTimeout(
    resolveTxt(originName).then(firstTxtRecord),
    CYMRU_TIMEOUT_MS,
    `Team Cymru origin lookup timed out for ${ip}`,
  )
  const origin = parseCymruOrigin(originRecord)
  if (origin.asn == null) return { ...origin, asName: null }

  const asNumber = origin.asn.replace(/^AS/, '')
  const asName = await withTimeout(
    resolveTxt(`AS${asNumber}.asn.cymru.com`).then(firstTxtRecord).then(parseCymruAsName),
    CYMRU_TIMEOUT_MS,
    `Team Cymru ASN lookup timed out for ${origin.asn}`,
  ).catch(() => null)
  return { ...origin, asName }
}

function collectRdapEmails(entity: unknown, emails: Set<string>): void {
  if (!isRecord(entity)) return
  const vcard = entity.vcardArray
  if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) return
  for (const item of vcard[1]) {
    if (!Array.isArray(item) || item.length < 4) continue
    if (item[0] !== 'email') continue
    const email = item[3]
    if (typeof email === 'string' && email.trim() !== '') emails.add(email.trim())
  }
}

async function lookupRdap(ip: string): Promise<{
  contactEmails: string[]
  country: string | null
  rdapName: string | null
}> {
  const response = await fetch(`https://rdap.org/ip/${encodeURIComponent(ip)}`, {
    signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`RDAP lookup failed for ${ip}: ${response.status} ${response.statusText}`)
  }

  const body: unknown = await response.json()
  if (!isRecord(body)) {
    throw new Error(`RDAP lookup for ${ip} returned a non-object response`)
  }

  const emails = new Set<string>()
  const entities = body.entities
  if (Array.isArray(entities)) {
    for (const entity of entities) collectRdapEmails(entity, emails)
  }

  return {
    contactEmails: uniqueSortedEmails(emails),
    country: readString(body, 'country'),
    rdapName: readString(body, 'name'),
  }
}

export async function lookupNetworkOwner(ip: string): Promise<NetworkOwnerInfo> {
  const [cymru, rdap] = await Promise.all([
    lookupCymru(ip).catch(() => ({
      asName: null,
      asn: null,
      country: null,
      prefix: null,
      registry: null,
    })),
    lookupRdap(ip).catch(() => ({
      contactEmails: [],
      country: null,
      rdapName: null,
    })),
  ])

  return {
    asName: cymru.asName,
    asn: cymru.asn,
    contactEmails: rdap.contactEmails,
    country: rdap.country ?? cymru.country,
    fetchedAt: new Date().toISOString(),
    ip,
    prefix: cymru.prefix,
    rdapName: rdap.rdapName,
    registry: cymru.registry,
    source: 'team-cymru+rdap',
  }
}
