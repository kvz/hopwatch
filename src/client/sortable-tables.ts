// Progressive-enhancement client script: finds every <table data-sortable> on
// the page and lets the user click a <th> to sort its <tbody> rows by that
// column. Re-clicking toggles direction, and a third click restores the
// original order. No React, no bundler — just a small plain-TS module served
// as-is to the browser.

export type SortKind = 'text' | 'number' | 'loss' | 'time'
export type SortDirection = 'asc' | 'desc'
export type SortValue = number | string | null

// Translate a declared default direction on a column header into the
// aria-sort token used by both the CSS caret and the activate-cycle. The
// server already ordered rows; we only need the caret to reflect that.
export function ariaSortFor(direction: SortDirection | null): 'ascending' | 'descending' | 'none' {
  if (direction === 'asc') return 'ascending'
  if (direction === 'desc') return 'descending'
  return 'none'
}

export function parseDefaultSort(raw: string | null): SortDirection | null {
  if (raw === 'asc' || raw === 'ascending') return 'asc'
  if (raw === 'desc' || raw === 'descending') return 'desc'
  return null
}

const MISSING_TEXT = new Set(['', 'n/a', '—', '-', 'unknown', 'nan'])

export function parseSortValue(raw: string, kind: SortKind): SortValue {
  const trimmed = raw.trim()
  if (kind === 'text') return trimmed.toLowerCase()

  if (MISSING_TEXT.has(trimmed.toLowerCase())) return null

  if (kind === 'time') {
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? null : parsed
  }

  // number / loss: strip thousands separators, currency, unit suffixes.
  const numeric = Number(trimmed.replace(/[,%\s]/g, '').replace(/[a-zA-Z/]+$/, ''))
  return Number.isFinite(numeric) ? numeric : null
}

export function compareSortValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  // Nulls always sort last, regardless of direction.
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1

  let cmp: number
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b
  } else {
    cmp = String(a).localeCompare(String(b))
  }
  return direction === 'asc' ? cmp : -cmp
}

function readCellValue(cell: HTMLTableCellElement, kind: SortKind): SortValue {
  const override = cell.getAttribute('data-sort-value')
  if (override != null) return parseSortValue(override, kind)
  return parseSortValue(cell.textContent ?? '', kind)
}

// Visual-only rows (e.g. day separators between snapshot runs) carry
// data-row-kind="separator" so they render in the default chronological order
// but stay out of the sort machinery entirely — they'd otherwise pollute the
// comparator and end up in arbitrary positions once a user clicks a header.
function isSortableRow(row: HTMLTableRowElement): boolean {
  return row.getAttribute('data-row-kind') !== 'separator'
}

function sortBody(
  body: HTMLTableSectionElement,
  columnIndex: number,
  kind: SortKind,
  direction: SortDirection,
  originalOrder: HTMLTableRowElement[],
): void {
  const rows = Array.from(body.querySelectorAll<HTMLTableRowElement>(':scope > tr')).filter(
    isSortableRow,
  )
  rows.sort((rowA, rowB) => {
    const cellA = rowA.cells[columnIndex]
    const cellB = rowB.cells[columnIndex]
    const valueA = cellA == null ? null : readCellValue(cellA, kind)
    const valueB = cellB == null ? null : readCellValue(cellB, kind)
    const cmp = compareSortValues(valueA, valueB, direction)
    if (cmp !== 0) return cmp
    // Stable tie-break: original row order.
    return originalOrder.indexOf(rowA) - originalOrder.indexOf(rowB)
  })
  // When a sort is active, separators are meaningless — hide them, keep the
  // sortable rows contiguous. restoreOriginalOrder will un-hide them.
  const allRows = Array.from(body.querySelectorAll<HTMLTableRowElement>(':scope > tr'))
  for (const row of allRows) {
    if (!isSortableRow(row)) row.hidden = true
  }
  for (const row of rows) body.appendChild(row)
}

function restoreOriginalOrder(
  body: HTMLTableSectionElement,
  originalOrder: HTMLTableRowElement[],
): void {
  for (const row of originalOrder) {
    row.hidden = false
    body.appendChild(row)
  }
}

export function enhanceTable(table: HTMLTableElement): void {
  const body = table.tBodies[0]
  if (body == null) return
  const originalOrder = Array.from(body.querySelectorAll<HTMLTableRowElement>(':scope > tr'))
  if (originalOrder.length === 0) return

  const headRow = table.tHead?.rows[0]
  if (headRow == null) return

  const headers = Array.from(headRow.cells)
  for (let index = 0; index < headers.length; index += 1) {
    const th = headers[index]
    const kind = th.getAttribute('data-sort') as SortKind | null
    if (kind == null) continue

    th.setAttribute('role', 'button')
    th.setAttribute('tabindex', '0')
    const defaultDirection = parseDefaultSort(th.getAttribute('data-sort-default'))
    th.setAttribute('aria-sort', ariaSortFor(defaultDirection))
    th.classList.add('is-sortable')

    const onActivate = (): void => {
      const current = th.getAttribute('aria-sort')
      // Cycle: none → asc → desc → none
      let next: 'asc' | 'desc' | 'none'
      if (current === 'none' || current == null) next = 'asc'
      else if (current === 'ascending') next = 'desc'
      else next = 'none'

      for (const other of headers) other.setAttribute('aria-sort', 'none')

      if (next === 'none') {
        restoreOriginalOrder(body, originalOrder)
        th.setAttribute('aria-sort', 'none')
        return
      }

      sortBody(body, index, kind, next, originalOrder)
      th.setAttribute('aria-sort', next === 'asc' ? 'ascending' : 'descending')
    }

    th.addEventListener('click', onActivate)
    th.addEventListener('keydown', (event) => {
      const keyboard = event as KeyboardEvent
      if (keyboard.key === 'Enter' || keyboard.key === ' ') {
        keyboard.preventDefault()
        onActivate()
      }
    })
  }
}

export function enhanceAll(root: ParentNode = document): void {
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table[data-sortable]'))
  for (const table of tables) enhanceTable(table)
}

// Auto-run when loaded as a <script src="…" defer>. Gated so importing the
// module in a test environment (vitest) doesn't blow up.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => enhanceAll())
  } else {
    enhanceAll()
  }
}
