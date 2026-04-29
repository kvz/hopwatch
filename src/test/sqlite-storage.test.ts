import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { execa } from 'execa'
import { describe, test } from 'vitest'

describe('HopwatchSqliteStore', () => {
  test('uses relational SQLite rows without JSON blob columns', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hopwatch-sqlite-storage-'))
    await execa('bun', ['src/test/sqlite-storage-bun-check.ts', dir])
  })
})
