import { describe, expect, test } from 'vitest'
import { compareSortValues, parseSortValue } from '../client/sortable-tables.ts'

describe('parseSortValue', () => {
  test('number: strips unit suffixes and parses decimals', () => {
    expect(parseSortValue('1.5 ms', 'number')).toBe(1.5)
    expect(parseSortValue('42%', 'number')).toBe(42)
    expect(parseSortValue('1,234.5', 'number')).toBe(1234.5)
  })

  test('number: n/a and empty are missing', () => {
    expect(parseSortValue('n/a', 'number')).toBe(null)
    expect(parseSortValue('', 'number')).toBe(null)
    expect(parseSortValue('—', 'number')).toBe(null)
  })

  test('loss: treats the loss % display format (including "unknown") as numeric', () => {
    expect(parseSortValue('0.00%', 'loss')).toBe(0)
    expect(parseSortValue('12.8%', 'loss')).toBe(12.8)
    expect(parseSortValue('unknown', 'loss')).toBe(null)
  })

  test('time: reads the ISO timestamp off <time datetime="…"> via data-sort-value', () => {
    expect(parseSortValue('2026-04-20T10:00:00.000Z', 'time')).toBe(
      Date.parse('2026-04-20T10:00:00.000Z'),
    )
    expect(parseSortValue('not-a-date', 'time')).toBe(null)
  })

  test('text: lowercases for case-insensitive comparison', () => {
    expect(parseSortValue('CloudFlare', 'text')).toBe('cloudflare')
    expect(parseSortValue('  trimmed  ', 'text')).toBe('trimmed')
  })
})

describe('compareSortValues', () => {
  test('ascending numeric sort', () => {
    const values = [3, 1, 2, 10]
    values.sort((a, b) => compareSortValues(a, b, 'asc'))
    expect(values).toEqual([1, 2, 3, 10])
  })

  test('descending numeric sort', () => {
    const values = [3, 1, 2, 10]
    values.sort((a, b) => compareSortValues(a, b, 'desc'))
    expect(values).toEqual([10, 3, 2, 1])
  })

  test('nulls always sort to the end regardless of direction', () => {
    const asc = [2, null, 1, null, 3]
    asc.sort((a, b) => compareSortValues(a, b, 'asc'))
    expect(asc).toEqual([1, 2, 3, null, null])

    const desc = [2, null, 1, null, 3]
    desc.sort((a, b) => compareSortValues(a, b, 'desc'))
    expect(desc).toEqual([3, 2, 1, null, null])
  })

  test('string sort uses locale-aware comparison', () => {
    const values = ['banana', 'apple', 'Cherry']
    values.sort((a, b) => compareSortValues(a.toLowerCase(), b.toLowerCase(), 'asc'))
    expect(values).toEqual(['apple', 'banana', 'Cherry'])
  })
})
