import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { formatConfigSummary, loadConfig } from '../lib/config.ts'

describe('loadConfig netns validation', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hopwatch-config-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeConfig(contents: string): Promise<string> {
    const configPath = path.join(dir, 'hopwatch.toml')
    await writeFile(configPath, contents)
    return configPath
  }

  test('rejects a netns name that contains path traversal', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "evil"
label = "evil"
host = "example.com"
probe_mode = "netns"
netns = "../escape"
`)
    await expect(loadConfig(configPath)).rejects.toThrow(/netns/)
  })

  test('rejects a netns name that contains a slash', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "slashy"
label = "slashy"
host = "example.com"
probe_mode = "netns"
netns = "a/b"
`)
    await expect(loadConfig(configPath)).rejects.toThrow(/netns/)
  })

  test('accepts a slug-safe netns name', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "good"
label = "good"
host = "example.com"
probe_mode = "netns"
netns = "ns-uk-1"
`)
    const config = await loadConfig(configPath)
    expect(config.target[0].netns).toBe('ns-uk-1')
  })

  test('defaults engine to "mtr" when not specified', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "t1"
label = "t1"
host = "example.com"
`)
    const config = await loadConfig(configPath)
    expect(config.target[0].engine).toBe('mtr')
  })

  test('accepts engine="native" with the default probe mode', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "t1"
label = "t1"
host = "example.com"
engine = "native"
`)
    const config = await loadConfig(configPath)
    expect(config.target[0].engine).toBe('native')
  })

  test('defaults protocol to "icmp" and port to 443', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "t1"
label = "t1"
host = "example.com"
`)
    const config = await loadConfig(configPath)
    expect(config.target[0].protocol).toBe('icmp')
    expect(config.target[0].port).toBe(443)
  })

  test('accepts protocol="tcp" with a custom port', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "t1"
label = "t1"
host = "example.com"
protocol = "tcp"
port = 8443
`)
    const config = await loadConfig(configPath)
    expect(config.target[0].protocol).toBe('tcp')
    expect(config.target[0].port).toBe(8443)
  })

  test('rejects protocol="tcp" combined with ip_version=6 (not yet supported)', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[probe]
ip_version = 6

[[target]]
id = "t1"
label = "t1"
host = "example.com"
protocol = "tcp"
`)
    await expect(loadConfig(configPath)).rejects.toThrow(/IPv6 TCP/)
  })

  test('rejects engine="native" combined with ip_version=6', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[probe]
ip_version = 6

[[target]]
id = "t1"
label = "t1"
host = "example.com"
engine = "native"
`)
    await expect(loadConfig(configPath)).rejects.toThrow(/IPv6/)
  })

  test('strips a trailing slash from an absolute data_dir so safeResolve still accepts served paths', async () => {
    // safeResolve compares `resolved !== root && !resolved.startsWith(root + sep)`.
    // When `data_dir = "/var/lib/hopwatch/"` is preserved verbatim, the prefix check
    // never matches (the resolved path is `/var/lib/hopwatch/file`, not
    // `/var/lib/hopwatch//file`), so every served file 404s. Normalize the value at
    // config load time.
    const trailing = `${dir}/`
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${trailing}"

[[target]]
id = "t1"
label = "t1"
host = "example.com"
`)
    const config = await loadConfig(configPath)
    expect(config.resolvedDataDir).toBe(dir)
  })

  test('defaults sqlite storage to an opt-in sidecar under data_dir', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "t1"
label = "t1"
host = "example.com"
`)
    const config = await loadConfig(configPath)
    expect(config.storage.sqlite_write).toBe(false)
    expect(config.resolvedSqlitePath).toBe(path.join(dir, 'hopwatch.sqlite'))
    expect(formatConfigSummary(config)).toContain('sqlite:    disabled')
  })

  test('accepts explicit sqlite sidecar settings', async () => {
    const dbPath = path.join(dir, 'custom.sqlite')
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[storage]
sqlite_path = "${dbPath}"
sqlite_write = true

[[target]]
id = "t1"
label = "t1"
host = "example.com"
`)
    const config = await loadConfig(configPath)
    expect(config.storage.sqlite_write).toBe(true)
    expect(config.resolvedSqlitePath).toBe(dbPath)
    expect(formatConfigSummary(config)).toContain(`sqlite:    ${dbPath}`)
  })

  test('rejects engine="native" combined with probe_mode="netns"', async () => {
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "t1"
label = "t1"
host = "example.com"
engine = "native"
probe_mode = "netns"
netns = "ns-uk-1"
`)
    await expect(loadConfig(configPath)).rejects.toThrow(/not yet supported/)
  })

  test('rejects target IDs that differ only in case, which collide on case-insensitive filesystems', async () => {
    // Target IDs are reused verbatim as on-disk directory names. On macOS
    // (APFS, default case-insensitive) `Foo` and `foo` map to the same
    // directory, so snapshots and rollups silently overwrite each other.
    // Linux filesystems treat them as distinct, but we reject at load time
    // everywhere so the collision never reaches production.
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[[target]]
id = "Foo"
label = "upper"
host = "a.example"

[[target]]
id = "foo"
label = "lower"
host = "b.example"
`)
    await expect(loadConfig(configPath)).rejects.toThrow(/duplicate target id/)
  })

  test('rejects engine="native" combined with probe.packets > 2048 (native seq overflow)', async () => {
    // The native prober packs (cycle, ttl) into the 16-bit ICMP seq field;
    // only 11 bits of cycle fit (0-2047). Past cycle 2047 the seq wraps and
    // late replies from a pre-wrap cycle overwrite a post-wrap send time,
    // producing garbage RTT. Cap at config time so operators discover the
    // limit before the daemon is even started.
    const configPath = await writeConfig(`
[server]
listen = ":0"
data_dir = "${dir}"

[probe]
packets = 3000

[[target]]
id = "t1"
label = "t1"
host = "example.com"
engine = "native"
`)
    await expect(loadConfig(configPath)).rejects.toThrow(/native prober supports at most/)
  })
})
