import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { parseListenAddress } from './listen.ts'

export const probeModeSchema = z.enum(['default', 'netns'])
export type ProbeMode = z.infer<typeof probeModeSchema>

export const probeEngineSchema = z.enum(['mtr', 'native', 'connect'])
export type ProbeEngine = z.infer<typeof probeEngineSchema>

// `icmp` sends ICMP Echo Requests (or the mtr equivalent) - the default, and
// what hopwatch has always done. `tcp` sends TCP SYN probes to the target's
// port. The two can disagree by tens of percentage points on the same path:
// some transit routers rate-limit ICMP but forward TCP normally (or vice
// versa). When the production workload is HTTPS to S3/R2/etc., TCP is what
// actually reflects user-visible reliability.
export const probeProtocolSchema = z.enum(['icmp', 'tcp'])
export type ProbeProtocol = z.infer<typeof probeProtocolSchema>

const targetSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'target id must be slug-safe'),
  label: z.string().min(1),
  // `host` lands in `mtr`/`nsenter` argv untouched. A host that starts with `-`
  // (e.g. `-h`, `--report-cycles=1`) would be parsed as an option instead of a
  // destination and make the probe wildly misbehave - reject at config time so
  // this can't sneak in via a typo or a hostile config file.
  host: z
    .string()
    .min(1)
    .regex(/^[^-]/, 'host must not start with "-" (would be interpreted as an mtr flag)'),
  probe_mode: probeModeSchema.default('default'),
  // `mtr` shells out to the external mtr binary (default, battle-tested).
  // `native` uses the built-in Linux raw-ICMP/TCP traceroute prober (no
  // external mtr needed, but the process needs CAP_NET_RAW). `connect` measures
  // end-to-end TCP connect success/latency without pretending to be traceroute.
  engine: probeEngineSchema.default('mtr'),
  netns: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'netns must be slug-safe (no "/" or "..")')
    .optional(),
  group: z.string().optional(),
  protocol: probeProtocolSchema.default('icmp'),
  // Only consulted when protocol='tcp'. 443 covers the HTTPS case that
  // motivates TCP probing (S3, R2, Hetzner Object Storage). Operators can
  // override per target when probing a non-HTTPS service.
  port: z.number().int().min(1).max(65535).default(443),
})
export type TargetConfig = z.infer<typeof targetSchema>

const peerSchema = z.object({
  id: z.string().min(1),
  // `peer.url` is rendered unescaped into the peer dropdown's `href`. `z.url()`
  // alone accepts `javascript:` / `data:` schemes, which would let a malformed
  // or malicious peer config deliver clickable script URLs to dashboard users.
  // Restrict to http/https.
  url: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: 'peer url must use http:// or https://',
    })
    // Peer URLs surface into href + subtitle via string slicing in
    // layout.ts. Embedded credentials (`https://user:pass@host`) or a
    // query/hash would either leak into the dashboard subtitle or be
    // stripped inconsistently from the link target. Reject them at config
    // load so the rendered link always matches what the operator wrote.
    .refine(
      (value) => {
        try {
          const parsed = new URL(value)
          if (parsed.username !== '' || parsed.password !== '') return false
          if (parsed.search !== '' || parsed.hash !== '') return false
          return true
        } catch {
          return false
        }
      },
      {
        message: 'peer url must not include credentials, query string, or fragment',
      },
    ),
  label: z.string().min(1),
})
export type PeerConfig = z.infer<typeof peerSchema>

const serverSchema = z.object({
  // Loopback by default. Hop topology + reverse-DNS for every target is
  // sensitive enough that we'd rather operators opt into exposing the UI -
  // front with nginx (README shows the proxy recipe) or set
  // `listen = "0.0.0.0:8080"` explicitly. Before this, fresh installs bound
  // on every interface with no authentication shipped.
  listen: z.string().default('127.0.0.1:8080'),
  data_dir: z.string().default('./hopwatch-data'),
  public_url: z.string().url().optional(),
  node_label: z.string().optional(),
})
export type ServerConfig = z.infer<typeof serverSchema>

const identitySchema = z.object({
  // Optional human/operator context for escalation copy. Hopwatch can discover
  // a local hostname and request Host header, but provider/datacenter naming
  // is site-specific and should come from config.
  hostname: z.string().min(1).optional(),
  public_hostname: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  provider_contact_emails: z.array(z.string().min(1)).default([]),
  location: z.string().min(1).optional(),
  datacenter: z.string().min(1).optional(),
  site_label: z.string().min(1).optional(),
  egress_ip: z.string().min(1).optional(),
  // Disabled by default to avoid surprising outbound calls. Operators can set
  // this to an endpoint such as https://api.ipify.org when they want Hopwatch
  // to discover the source NAT IP at daemon startup.
  egress_ip_lookup_url: z.string().url().optional(),
})
export type IdentityConfig = z.infer<typeof identitySchema>

const probeSchema = z.object({
  interval_seconds: z.number().int().positive().default(900),
  packets: z.number().int().positive().default(20),
  ip_version: z.union([z.literal(4), z.literal(6)]).default(4),
  mtr_bin: z.string().default('mtr'),
  concurrency: z.number().int().positive().default(3),
  keep_days: z.number().int().positive().default(14),
  jitter_seconds: z.number().int().nonnegative().default(30),
  namespace_dir: z.string().default(''),
  netns_mount: z.boolean().default(true),
})
export type ProbeSettings = z.infer<typeof probeSchema>

const chartSchema = z.object({
  signature: z.string().default('RRDTOOL / TOBI OETIKER'),
})
export type ChartSettings = z.infer<typeof chartSchema>

const storageSchema = z.object({
  sqlite_path: z.string().default(''),
})
export type StorageSettings = z.infer<typeof storageSchema>

const configSchema = z.object({
  server: serverSchema.default({}),
  identity: identitySchema.default({}),
  probe: probeSchema.default({}),
  chart: chartSchema.default({}),
  storage: storageSchema.default({}),
  target: z.array(targetSchema).default([]),
  peer: z.array(peerSchema).default([]),
})
export type HopwatchConfig = z.infer<typeof configSchema>

export interface LoadedConfig extends HopwatchConfig {
  resolvedSqlitePath: string
  sourcePath: string
  resolvedDataDir: string
}

function applyEnvOverrides(raw: unknown): unknown {
  const env = process.env
  const overrides: Record<string, Record<string, boolean | number | string | string[]>> = {
    server: {},
    identity: {},
    probe: {},
    chart: {},
    storage: {},
  }

  if (env.HOPWATCH_LISTEN) {
    overrides.server.listen = env.HOPWATCH_LISTEN
  }

  if (env.HOPWATCH_DATA_DIR) {
    overrides.server.data_dir = env.HOPWATCH_DATA_DIR
  }

  if (env.HOPWATCH_PUBLIC_URL) {
    overrides.server.public_url = env.HOPWATCH_PUBLIC_URL
  }

  if (env.HOPWATCH_NODE_LABEL) {
    overrides.server.node_label = env.HOPWATCH_NODE_LABEL
  }

  if (env.HOPWATCH_IDENTITY_HOSTNAME) {
    overrides.identity.hostname = env.HOPWATCH_IDENTITY_HOSTNAME
  }

  if (env.HOPWATCH_IDENTITY_PUBLIC_HOSTNAME) {
    overrides.identity.public_hostname = env.HOPWATCH_IDENTITY_PUBLIC_HOSTNAME
  }

  if (env.HOPWATCH_IDENTITY_PROVIDER) {
    overrides.identity.provider = env.HOPWATCH_IDENTITY_PROVIDER
  }

  if (env.HOPWATCH_IDENTITY_PROVIDER_CONTACT_EMAILS) {
    overrides.identity.provider_contact_emails =
      env.HOPWATCH_IDENTITY_PROVIDER_CONTACT_EMAILS.split(',')
        .map((email) => email.trim())
        .filter((email) => email !== '')
  }

  if (env.HOPWATCH_IDENTITY_LOCATION) {
    overrides.identity.location = env.HOPWATCH_IDENTITY_LOCATION
  }

  if (env.HOPWATCH_IDENTITY_DATACENTER) {
    overrides.identity.datacenter = env.HOPWATCH_IDENTITY_DATACENTER
  }

  if (env.HOPWATCH_IDENTITY_SITE_LABEL) {
    overrides.identity.site_label = env.HOPWATCH_IDENTITY_SITE_LABEL
  }

  if (env.HOPWATCH_IDENTITY_EGRESS_IP) {
    overrides.identity.egress_ip = env.HOPWATCH_IDENTITY_EGRESS_IP
  }

  if (env.HOPWATCH_IDENTITY_EGRESS_IP_LOOKUP_URL) {
    overrides.identity.egress_ip_lookup_url = env.HOPWATCH_IDENTITY_EGRESS_IP_LOOKUP_URL
  }

  if (env.HOPWATCH_MTR_BIN) {
    overrides.probe.mtr_bin = env.HOPWATCH_MTR_BIN
  }

  if (env.HOPWATCH_PROBE_INTERVAL_SECONDS) {
    overrides.probe.interval_seconds = Number(env.HOPWATCH_PROBE_INTERVAL_SECONDS)
  }

  if (env.HOPWATCH_PROBE_PACKETS) {
    overrides.probe.packets = Number(env.HOPWATCH_PROBE_PACKETS)
  }

  if (env.HOPWATCH_KEEP_DAYS) {
    overrides.probe.keep_days = Number(env.HOPWATCH_KEEP_DAYS)
  }

  if (env.HOPWATCH_NAMESPACE_DIR) {
    overrides.probe.namespace_dir = env.HOPWATCH_NAMESPACE_DIR
  }

  if (env.HOPWATCH_CHART_SIGNATURE) {
    overrides.chart = { signature: env.HOPWATCH_CHART_SIGNATURE }
  }

  if (env.HOPWATCH_SQLITE_PATH) {
    overrides.storage.sqlite_path = env.HOPWATCH_SQLITE_PATH
  }

  if (typeof raw !== 'object' || raw === null) {
    return { ...overrides }
  }

  const rawRecord = raw as Record<string, unknown>
  const merged: Record<string, unknown> = { ...rawRecord }
  for (const section of ['server', 'identity', 'probe', 'chart', 'storage'] as const) {
    const current = (rawRecord[section] as Record<string, unknown> | undefined) ?? {}
    const layer = overrides[section]
    if (Object.keys(layer).length > 0) {
      merged[section] = { ...current, ...layer }
    }
  }

  return merged
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const absolute = path.resolve(configPath)
  const raw = await readFile(absolute, 'utf8')
  const parsed = parseToml(raw)
  const overlayed = applyEnvOverrides(parsed)
  const result = configSchema.safeParse(overlayed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid hopwatch config at ${absolute}:\n${issues}`)
  }

  const config = result.data

  // Surface a malformed listen address at config-load time (and in
  // `hopwatch config-check`) instead of waiting for the daemon to fail when
  // it hands the value to Bun.serve().
  try {
    parseListenAddress(config.server.listen)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid hopwatch config at ${absolute}: server.listen: ${reason}`)
  }

  // Target IDs are reused verbatim as on-disk directory names. On macOS/APFS
  // and Windows (case-insensitive by default) `Foo` and `foo` map to the same
  // directory, so their snapshots and rollups would silently stomp each other.
  // Dedup case-insensitively to catch the collision everywhere, even though
  // Linux filesystems treat them as distinct paths.
  const idsLower = new Set<string>()
  for (const target of config.target) {
    const idLower = target.id.toLowerCase()
    if (idsLower.has(idLower)) {
      throw new Error(`duplicate target id: ${target.id}`)
    }

    idsLower.add(idLower)
    if (target.probe_mode === 'netns' && !target.netns) {
      throw new Error(`target '${target.id}' uses probe_mode='netns' but has no 'netns' field`)
    }

    if (target.engine === 'native' && target.probe_mode === 'netns') {
      // Running the native prober inside a network namespace needs setns(),
      // which the FFI prober doesn't do yet. Flip back to engine='mtr' (which
      // uses nsenter) or move this target out of netns.
      throw new Error(
        `target '${target.id}' uses engine='native' with probe_mode='netns', which is not yet supported`,
      )
    }

    if (target.engine === 'connect' && target.probe_mode === 'netns') {
      // Running connect probes in a netns would need nsenter/setns support in
      // the connect engine. Keep this explicit instead of silently probing from
      // the host namespace and labeling it as namespace evidence.
      throw new Error(
        `target '${target.id}' uses engine='connect' with probe_mode='netns', which is not yet supported`,
      )
    }

    if (target.engine === 'connect' && target.protocol !== 'tcp') {
      throw new Error(
        `target '${target.id}' uses engine='connect' but protocol='${target.protocol}'; engine='connect' requires protocol='tcp'`,
      )
    }

    if (target.engine === 'native' && config.probe.ip_version === 6) {
      // collectSnapshot() rejects this combination at runtime; catch it at
      // config-load time so `hopwatch config-check` flags the problem before
      // the daemon is started and the first probe cycle fails.
      throw new Error(
        `target '${target.id}' uses engine='native' but probe.ip_version=6; IPv6 is not yet supported by the native prober`,
      )
    }

    if (target.protocol === 'tcp' && config.probe.ip_version === 6) {
      // mtr supports --tcp over IPv6 and the native TCP prober would too, but
      // we haven't exercised either combination against real v6 paths yet.
      // Fail fast instead of shipping an untested code path.
      throw new Error(
        `target '${target.id}' uses protocol='tcp' but probe.ip_version=6; IPv6 TCP probing is not yet supported`,
      )
    }

    // The native prober packs (cycle, ttl) into the 16-bit ICMP seq field
    // (11 bits for cycle). Past cycle 2047 the seq wraps and late replies
    // from a pre-wrap cycle overwrite post-wrap send times, returning
    // garbage RTT. encodeSeq() throws, but we'd rather reject at config
    // load than fail mid-probe.
    if (target.engine === 'native' && config.probe.packets > 2048) {
      throw new Error(
        `target '${target.id}' uses engine='native' but probe.packets=${config.probe.packets}; the native prober supports at most 2048 packets per probe`,
      )
    }
  }

  const peerIds = new Set<string>()
  for (const peer of config.peer) {
    if (peerIds.has(peer.id)) {
      throw new Error(`duplicate peer id: ${peer.id}`)
    }

    peerIds.add(peer.id)
  }

  // `path.resolve()` normalizes both absolute and relative data_dir values -
  // in particular it strips trailing separators. safeResolve() later compares
  // `resolved.startsWith(root + sep)`, and a stored `/var/lib/hopwatch/` would
  // otherwise fail every prefix check because the resolved target is
  // `/var/lib/hopwatch/file`, not `/var/lib/hopwatch//file`.
  const resolvedDataDir = path.isAbsolute(config.server.data_dir)
    ? path.resolve(config.server.data_dir)
    : path.resolve(path.dirname(absolute), config.server.data_dir)
  const sqlitePath =
    config.storage.sqlite_path.trim() === ''
      ? path.join(resolvedDataDir, 'hopwatch.sqlite')
      : config.storage.sqlite_path
  const resolvedSqlitePath = path.isAbsolute(sqlitePath)
    ? path.resolve(sqlitePath)
    : path.resolve(path.dirname(absolute), sqlitePath)

  return { ...config, sourcePath: absolute, resolvedDataDir, resolvedSqlitePath }
}

export function formatConfigSummary(config: LoadedConfig): string {
  const lines = [
    `config:    ${config.sourcePath}`,
    `data dir:  ${config.resolvedDataDir}`,
    `listen:    ${config.server.listen}`,
    `targets:   ${config.target.length}`,
    `peers:     ${config.peer.length}`,
    `cadence:   ${config.probe.interval_seconds}s, ${config.probe.packets} packets`,
    `sqlite:    ${config.resolvedSqlitePath}`,
  ]
  return lines.join('\n')
}
