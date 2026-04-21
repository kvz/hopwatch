import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { parseListenAddress } from './listen.ts'

export const probeModeSchema = z.enum(['default', 'netns'])
export type ProbeMode = z.infer<typeof probeModeSchema>

export const probeEngineSchema = z.enum(['mtr', 'native'])
export type ProbeEngine = z.infer<typeof probeEngineSchema>

const targetSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'target id must be slug-safe'),
  label: z.string().min(1),
  // `host` lands in `mtr`/`nsenter` argv untouched. A host that starts with `-`
  // (e.g. `-h`, `--report-cycles=1`) would be parsed as an option instead of a
  // destination and make the probe wildly misbehave — reject at config time so
  // this can't sneak in via a typo or a hostile config file.
  host: z
    .string()
    .min(1)
    .regex(/^[^-]/, 'host must not start with "-" (would be interpreted as an mtr flag)'),
  probe_mode: probeModeSchema.default('default'),
  // `mtr` shells out to the external mtr binary (default, battle-tested).
  // `native` uses the built-in Linux raw-ICMP prober (no external mtr
  // needed, but the process needs CAP_NET_RAW).
  engine: probeEngineSchema.default('mtr'),
  netns: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'netns must be slug-safe (no "/" or "..")')
    .optional(),
  group: z.string().optional(),
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
  // sensitive enough that we'd rather operators opt into exposing the UI —
  // front with nginx (README shows the proxy recipe) or set
  // `listen = "0.0.0.0:8080"` explicitly. Before this, fresh installs bound
  // on every interface with no authentication shipped.
  listen: z.string().default('127.0.0.1:8080'),
  data_dir: z.string().default('./hopwatch-data'),
  public_url: z.string().url().optional(),
  node_label: z.string().optional(),
})
export type ServerConfig = z.infer<typeof serverSchema>

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

const configSchema = z.object({
  server: serverSchema.default({}),
  probe: probeSchema.default({}),
  chart: chartSchema.default({}),
  target: z.array(targetSchema).default([]),
  peer: z.array(peerSchema).default([]),
})
export type HopwatchConfig = z.infer<typeof configSchema>

export interface LoadedConfig extends HopwatchConfig {
  sourcePath: string
  resolvedDataDir: string
}

function applyEnvOverrides(raw: unknown): unknown {
  const env = process.env
  const overrides: Record<string, Record<string, string | number>> = {
    server: {},
    probe: {},
    chart: {},
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

  if (typeof raw !== 'object' || raw === null) {
    return { ...overrides }
  }

  const rawRecord = raw as Record<string, unknown>
  const merged: Record<string, unknown> = { ...rawRecord }
  for (const section of ['server', 'probe', 'chart'] as const) {
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

    if (target.engine === 'native' && config.probe.ip_version === 6) {
      // collectSnapshot() rejects this combination at runtime; catch it at
      // config-load time so `hopwatch config-check` flags the problem before
      // the daemon is started and the first probe cycle fails.
      throw new Error(
        `target '${target.id}' uses engine='native' but probe.ip_version=6; IPv6 is not yet supported by the native prober`,
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

  // `path.resolve()` normalizes both absolute and relative data_dir values —
  // in particular it strips trailing separators. safeResolve() later compares
  // `resolved.startsWith(root + sep)`, and a stored `/var/lib/hopwatch/` would
  // otherwise fail every prefix check because the resolved target is
  // `/var/lib/hopwatch/file`, not `/var/lib/hopwatch//file`.
  const resolvedDataDir = path.isAbsolute(config.server.data_dir)
    ? path.resolve(config.server.data_dir)
    : path.resolve(path.dirname(absolute), config.server.data_dir)

  return { ...config, sourcePath: absolute, resolvedDataDir }
}

export function formatConfigSummary(config: LoadedConfig): string {
  const lines = [
    `config:    ${config.sourcePath}`,
    `data dir:  ${config.resolvedDataDir}`,
    `listen:    ${config.server.listen}`,
    `targets:   ${config.target.length}`,
    `peers:     ${config.peer.length}`,
    `cadence:   ${config.probe.interval_seconds}s, ${config.probe.packets} packets`,
  ]
  return lines.join('\n')
}
