#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import type { NativeChartPoint } from '../src/lib/core.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const FIXTURE_DIR = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'mtr-fixtures', 'real-ap')
const XML_DIR = path.join(FIXTURE_DIR, 'xml')
const IMAGES_DIR = path.join(FIXTURE_DIR, 'images')
const OUT_DIR = path.join(FIXTURE_DIR, 'points')
const RANGE_HOURS = 3

interface ExtractedFixture {
  anchorTs: number
  name: string
  points: NativeChartPoint[]
  referencePngPath: string
  upperLimitMs: number | null
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) {
    return sorted[lo]
  }

  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

async function restoreRrd(xmlGzPath: string, rrdPath: string): Promise<void> {
  const { stdout } = await execa('gunzip', ['-c', xmlGzPath])
  await execa('rrdtool', ['restore', '-', rrdPath], { input: stdout })
}

async function rrdLastTs(rrdPath: string): Promise<number> {
  const { stdout } = await execa('rrdtool', ['last', rrdPath])
  return Number(stdout.trim())
}

async function fetchSamples(
  rrdPath: string,
  startEpoch: number,
  endEpoch: number,
): Promise<NativeChartPoint[]> {
  const { stdout } = await execa('rrdtool', [
    'fetch',
    rrdPath,
    'AVERAGE',
    '--start',
    String(startEpoch),
    '--end',
    String(endEpoch),
  ])
  const lines = stdout.split('\n').filter((line) => line.includes(':') && !line.startsWith(' '))
  const points: NativeChartPoint[] = []
  for (const line of lines) {
    const [tsPart, valuesPart] = line.split(':')
    const ts = Number(tsPart.trim())
    if (!Number.isFinite(ts)) {
      continue
    }

    const values = valuesPart
      .trim()
      .split(/\s+/)
      .map((raw) => (raw === 'nan' || raw === '-nan' || raw === 'NaN' ? Number.NaN : Number(raw)))

    const loss = values[1]
    const median = values[2]
    const pingSeconds = values.slice(3, 23)
    if (Number.isNaN(median) && pingSeconds.every((value) => Number.isNaN(value))) {
      continue
    }

    const samplesMs = pingSeconds
      .filter((value) => Number.isFinite(value))
      .map((value) => value * 1000)
      .sort((a, b) => a - b)
    const lossPct = Number.isFinite(loss) ? (loss / 20) * 100 : null
    const sum = samplesMs.reduce((acc, value) => acc + value, 0)

    points.push({
      destinationLossPct: lossPct,
      rttAvgMs: samplesMs.length === 0 ? null : sum / samplesMs.length,
      rttMaxMs: samplesMs.length === 0 ? null : samplesMs[samplesMs.length - 1],
      rttMinMs: samplesMs.length === 0 ? null : samplesMs[0],
      rttP25Ms: samplesMs.length === 0 ? null : quantile(samplesMs, 0.25),
      rttP50Ms: Number.isFinite(median)
        ? median * 1000
        : samplesMs.length === 0
          ? null
          : quantile(samplesMs, 0.5),
      rttP75Ms: samplesMs.length === 0 ? null : quantile(samplesMs, 0.75),
      rttP90Ms: samplesMs.length === 0 ? null : quantile(samplesMs, 0.9),
      rttSamplesMs: samplesMs.length === 0 ? null : samplesMs,
      timestamp: ts * 1000,
    })
  }

  return points
}

function referencePngForFixture(name: string): string {
  const [category, target] = name.split('__')
  return path.join(IMAGES_DIR, category, `${target}_last_10800.png`)
}

async function extractFixture(
  xmlGzPath: string,
  tmpRoot: string,
): Promise<ExtractedFixture | null> {
  const name = path.basename(xmlGzPath).replace(/\.xml\.gz$/, '')
  const referencePngPath = referencePngForFixture(name)
  if (!existsSync(referencePngPath)) {
    process.stderr.write(`no reference PNG: ${referencePngPath}\n`)
    return null
  }

  const rrdPath = path.join(tmpRoot, `${name}.rrd`)
  await restoreRrd(xmlGzPath, rrdPath)
  const pngMtimeSec = Math.floor(statSync(referencePngPath).mtimeMs / 1000)
  const rrdLast = await rrdLastTs(rrdPath)
  const anchorTs = Math.min(pngMtimeSec, rrdLast)
  const points = await fetchSamples(rrdPath, anchorTs - RANGE_HOURS * 3600, anchorTs)
  if (points.length === 0) {
    process.stderr.write(`no points for ${name}\n`)
    return null
  }

  return {
    anchorTs,
    name,
    points,
    referencePngPath: path.relative(FIXTURE_DIR, referencePngPath),
    upperLimitMs: await readMaxheightAsync(name),
  }
}

async function readMaxheightAsync(fixtureName: string): Promise<number | null> {
  const [category, target] = fixtureName.split('__')
  const maxheightPath = path.join(IMAGES_DIR, category, `${target}.maxheight`)
  if (!existsSync(maxheightPath)) {
    return null
  }

  const text = await readFile(maxheightPath, 'utf8')
  const values = text
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (values.length === 0) {
    return null
  }

  return Math.max(...values) * 1000
}

async function run(): Promise<void> {
  await execa('mkdir', ['-p', OUT_DIR])
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'hopwatch-extract-'))
  const entries = (await readdir(XML_DIR))
    .filter((name) => name.endsWith('.xml.gz'))
    .map((name) => path.join(XML_DIR, name))
    .sort()

  const index: Array<{
    anchorTs: number
    name: string
    pointsPath: string
    referencePngPath: string
    upperLimitMs: number | null
  }> = []

  for (const xmlPath of entries) {
    const fixture = await extractFixture(xmlPath, tmpRoot)
    if (fixture == null) {
      continue
    }

    const outPath = path.join(OUT_DIR, `${fixture.name}.points.json`)
    await writeFile(outPath, `${JSON.stringify({ points: fixture.points }, null, 2)}\n`)
    index.push({
      anchorTs: fixture.anchorTs,
      name: fixture.name,
      pointsPath: path.relative(FIXTURE_DIR, outPath),
      referencePngPath: fixture.referencePngPath,
      upperLimitMs: fixture.upperLimitMs,
    })
    process.stdout.write(`extracted ${fixture.name} (${fixture.points.length} points)\n`)
  }

  await writeFile(
    path.join(FIXTURE_DIR, 'index.json'),
    `${JSON.stringify({ rangeHours: RANGE_HOURS, fixtures: index }, null, 2)}\n`,
  )
  process.stdout.write(`wrote ${path.join(FIXTURE_DIR, 'index.json')}\n`)
}

run().catch((err: unknown) => {
  if (!(err instanceof Error)) {
    throw new Error(`Was thrown a non-error: ${err}`)
  }

  process.stderr.write(`${err.stack ?? err.message}\n`)
  process.exit(1)
})
