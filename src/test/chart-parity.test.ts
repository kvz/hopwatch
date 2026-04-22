import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'
import { afterAll, describe, expect, test } from 'vitest'
import { type ChartPoint, renderChartSvg } from '../lib/core.ts'

// Pixel-parity regression suite. Each fixture pairs a real SmokePing PNG with
// the probe data that produced it (extracted from rrdtool). We render the same
// data through our native SVG pipeline, rasterize via resvg using the vendored
// DejaVu Mono font, and compare pixel-for-pixel against the reference.
//
// The manifest stores a *locked* mismatchPct and rmsDelta per fixture. Tests
// fail if either value drifts outside ± tolerance of the locked value, in
// either direction. Relocking — whether parity improved or we intentionally
// changed the renderer — requires `UPDATE_PARITY_BASELINE=1 bun run test`.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const FIXTURES_DIR = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'smokeping')
const MANIFEST_PATH = path.join(FIXTURES_DIR, 'fixtures.json')
const FONT_DIR = path.join(REPO_ROOT, 'vendor', 'fonts')
const CHART_WIDTH = 697
const CHART_HEIGHT = 297

interface LockedParity {
  mismatchPct: number
  rmsDelta: number
}

interface FixtureEntry {
  anchorTs: number
  locked: LockedParity
  name: string
  pointsPath: string
  referencePngPath: string
  upperLimitMs: number | null
}

interface FixturesManifest {
  description: string
  fixtures: FixtureEntry[]
  pixelThreshold: number
  rangeHours: number
  toleranceRms: number
  tolerancePct: number
}

interface PointsFile {
  points: ChartPoint[]
}

interface DiffResult {
  mismatchPct: number
  rmsDelta: number
}

async function loadManifest(): Promise<FixturesManifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as FixturesManifest
}

async function rasterize(svg: string, width: number, height: number): Promise<Buffer> {
  const svgDoc = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:#fff">
${svg}
</svg>`
  const resvg = new Resvg(svgDoc, {
    background: '#ffffff',
    fitTo: { mode: 'original' },
    font: {
      defaultFontFamily: 'DejaVu Sans Mono',
      fontDirs: [FONT_DIR],
      loadSystemFonts: false,
      monospaceFamily: 'DejaVu Sans Mono',
    },
  })
  return Buffer.from(resvg.render().asPng())
}

async function pixelDiff(
  renderedPng: Buffer,
  referencePngPath: string,
  threshold: number,
): Promise<DiffResult> {
  const [rMeta, refMeta] = await Promise.all([
    sharp(renderedPng).metadata(),
    sharp(referencePngPath).metadata(),
  ])
  const width = Math.min(rMeta.width ?? 0, refMeta.width ?? 0)
  const height = Math.min(rMeta.height ?? 0, refMeta.height ?? 0)
  const [renderedBuf, referenceBuf] = await Promise.all([
    sharp(renderedPng)
      .resize(width, height, { fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer(),
    sharp(referencePngPath)
      .resize(width, height, { fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer(),
  ])

  let mismatched = 0
  let squaredSum = 0
  for (let i = 0; i < renderedBuf.length; i += 3) {
    const dr = renderedBuf[i] - referenceBuf[i]
    const dg = renderedBuf[i + 1] - referenceBuf[i + 1]
    const db = renderedBuf[i + 2] - referenceBuf[i + 2]
    const delta = Math.abs(dr) + Math.abs(dg) + Math.abs(db)
    squaredSum += dr * dr + dg * dg + db * db
    if (delta > threshold) mismatched += 1
  }

  const totalPixels = width * height
  return {
    mismatchPct: (mismatched / totalPixels) * 100,
    rmsDelta: Math.sqrt(squaredSum / (totalPixels * 3)),
  }
}

async function measure(fixture: FixtureEntry, manifest: FixturesManifest): Promise<DiffResult> {
  const pointsJsonPath = path.join(FIXTURES_DIR, fixture.pointsPath)
  const referencePngPath = path.join(FIXTURES_DIR, fixture.referencePngPath)
  const points = (JSON.parse(await readFile(pointsJsonPath, 'utf8')) as PointsFile).points

  const svg = renderChartSvg(points, {
    height: CHART_HEIGHT,
    now: fixture.anchorTs * 1000,
    rangeMs: manifest.rangeHours * 60 * 60 * 1000,
    title: fixture.name,
    upperLimitMs: fixture.upperLimitMs ?? undefined,
    width: CHART_WIDTH,
  })
  const pngBuf = await rasterize(svg, CHART_WIDTH, CHART_HEIGHT)
  return pixelDiff(pngBuf, referencePngPath, manifest.pixelThreshold)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

const manifest = await loadManifest()
const updateMode = process.env.UPDATE_PARITY_BASELINE === '1'
const measured = new Map<string, DiffResult>()

describe('chart parity vs real SmokePing output', () => {
  for (const fixture of manifest.fixtures) {
    test(`${fixture.name} stays within ± tolerance of locked parity`, async () => {
      const diff = await measure(fixture, manifest)
      measured.set(fixture.name, diff)

      if (updateMode) return

      const pctDrift = diff.mismatchPct - fixture.locked.mismatchPct
      const rmsDrift = diff.rmsDelta - fixture.locked.rmsDelta
      const hint = `relock with \`UPDATE_PARITY_BASELINE=1 bun run test -- chart-parity\` if intentional`

      expect
        .soft(
          Math.abs(pctDrift),
          `${fixture.name}: mismatchPct=${round(diff.mismatchPct)}% vs locked ${fixture.locked.mismatchPct}% (drift ${pctDrift > 0 ? '+' : ''}${round(pctDrift)}pp; ${hint})`,
        )
        .toBeLessThanOrEqual(manifest.tolerancePct)
      expect
        .soft(
          Math.abs(rmsDrift),
          `${fixture.name}: rmsDelta=${round(diff.rmsDelta)} vs locked ${fixture.locked.rmsDelta} (drift ${rmsDrift > 0 ? '+' : ''}${round(rmsDrift)}; ${hint})`,
        )
        .toBeLessThanOrEqual(manifest.toleranceRms)
    }, 30_000)
  }

  afterAll(async () => {
    if (!updateMode) return
    const updated = {
      ...manifest,
      fixtures: manifest.fixtures.map((fixture) => {
        const diff = measured.get(fixture.name)
        if (!diff) return fixture
        return {
          ...fixture,
          locked: { mismatchPct: round(diff.mismatchPct), rmsDelta: round(diff.rmsDelta) },
        }
      }),
    }
    await writeFile(MANIFEST_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
    console.log(`\nParity baseline relocked at ${path.relative(REPO_ROOT, MANIFEST_PATH)}`)
  })
})
