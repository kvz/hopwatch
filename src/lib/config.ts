import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'

export const probeModeSchema = z.enum(['default', 'netns'])
export type ProbeMode = z.infer<typeof probeModeSchema>

const targetSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'target id must be slug-safe'),
  label: z.string().min(1),
  host: z.string().min(1),
  probe_mode: probeModeSchema.default('default'),
  netns: z.string().optional(),
  group: z.string().optional(),
})
export type TargetConfig = z.infer<typeof targetSchema>

const peerSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  label: z.string().min(1),
})
export type PeerConfig = z.infer<typeof peerSchema>

const serverSchema = z.object({
  listen: z.string().default(':8080'),
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
})
export type ProbeSettings = z.infer<typeof probeSchema>

const configSchema = z.object({
  server: serverSchema.default({}),
  probe: probeSchema.default({}),
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

  if (typeof raw !== 'object' || raw === null) {
    return { ...overrides }
  }

  const rawRecord = raw as Record<string, unknown>
  const merged: Record<string, unknown> = { ...rawRecord }
  for (const section of ['server', 'probe'] as const) {
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
  const ids = new Set<string>()
  for (const target of config.target) {
    if (ids.has(target.id)) {
      throw new Error(`duplicate target id: ${target.id}`)
    }

    ids.add(target.id)
    if (target.probe_mode === 'netns' && !target.netns) {
      throw new Error(`target '${target.id}' uses probe_mode='netns' but has no 'netns' field`)
    }
  }

  const peerIds = new Set<string>()
  for (const peer of config.peer) {
    if (peerIds.has(peer.id)) {
      throw new Error(`duplicate peer id: ${peer.id}`)
    }

    peerIds.add(peer.id)
  }

  const resolvedDataDir = path.isAbsolute(config.server.data_dir)
    ? config.server.data_dir
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
