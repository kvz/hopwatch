import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadConfig } from '../lib/config.ts'

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
})
