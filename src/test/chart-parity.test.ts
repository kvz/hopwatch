import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'
import { describe, expect, test } from 'vitest'
import { type ChartPoint, renderChartSvg } from '../lib/core.ts'

interface FixtureBudget {
  maxMismatchPct: number
  maxRms: number
}

interface ParityBaseline {
  description: string
  fixtures: Record<string, FixtureBudget>
  pixelThreshold: number
}

interface FixtureIndex {
  fixtures: FixtureIndexEntry[]
  rangeHours: number
}

interface FixtureIndexEntry {
  anchorTs: number
  name: string
  pointsPath: string
  referencePngPath: string
  upperLimitMs: number | null
}

interface PointsFile {
  points: ChartPoint[]
}

interface DiffResult {
  mismatchedPixels: number
  rmsDelta: number
  totalPixels: number
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const FIXTURES_DIR = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'mtr-fixtures', 'real-ap')
const FONT_DIR = path.join(REPO_ROOT, 'vendor', 'fonts')
const CHART_WIDTH = 697
const CHART_HEIGHT = 297

async function loadBaseline(): Promise<ParityBaseline> {
  const raw = await readFile(path.join(REPO_ROOT, 'src', 'test', 'parity-baseline.json'), 'utf8')
  return JSON.parse(raw) as ParityBaseline
}

async function loadIndex(): Promise<FixtureIndex> {
  const raw = await readFile(path.join(FIXTURES_DIR, 'index.json'), 'utf8')
  return JSON.parse(raw) as FixtureIndex
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
    if (delta > threshold) {
      mismatched += 1
    }
  }

  return {
    mismatchedPixels: mismatched,
    rmsDelta: Math.sqrt(squaredSum / (width * height * 3)),
    totalPixels: width * height,
  }
}

const baseline = await loadBaseline()
const index = await loadIndex()

describe('chart parity', () => {
  for (const fixture of index.fixtures) {
    const budget = baseline.fixtures[fixture.name]
    if (!budget) {
      continue
    }

    test(`${fixture.name} stays within mismatch budget`, async () => {
      const pointsJsonPath = path.join(FIXTURES_DIR, fixture.pointsPath)
      const referencePngPath = path.join(FIXTURES_DIR, fixture.referencePngPath)
      const points = (JSON.parse(await readFile(pointsJsonPath, 'utf8')) as PointsFile).points

      const svg = renderChartSvg(points, {
        height: CHART_HEIGHT,
        now: fixture.anchorTs * 1000,
        rangeMs: index.rangeHours * 60 * 60 * 1000,
        title: fixture.name,
        upperLimitMs: fixture.upperLimitMs ?? undefined,
        width: CHART_WIDTH,
      })
      const pngBuf = await rasterize(svg, CHART_WIDTH, CHART_HEIGHT)

      const diff = await pixelDiff(pngBuf, referencePngPath, baseline.pixelThreshold)
      const mismatchPct = (diff.mismatchedPixels / diff.totalPixels) * 100

      expect
        .soft(mismatchPct, `${fixture.name} mismatch %`)
        .toBeLessThanOrEqual(budget.maxMismatchPct)
      expect.soft(diff.rmsDelta, `${fixture.name} RMS delta`).toBeLessThanOrEqual(budget.maxRms)
    }, 30_000)
  }
})
