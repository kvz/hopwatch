import type { ReactNode } from 'react'
import type { HopRecord } from '../lib/snapshot.ts'
import { UnknownHopHost } from './HopHost.tsx'

interface DiagnosisSummaryProps {
  summary: string
  hops: HopRecord[]
}

interface Token {
  id: string
  node: ReactNode
}

function splitOn(tokens: Token[], needle: string, buildMatch: (id: string) => ReactNode): Token[] {
  const result: Token[] = []
  for (const token of tokens) {
    if (typeof token.node !== 'string') {
      result.push(token)
      continue
    }

    let remaining = token.node
    let part = 0
    let cursor = remaining.indexOf(needle)
    while (cursor !== -1) {
      if (cursor > 0) {
        result.push({ id: `${token.id}.${part++}`, node: remaining.slice(0, cursor) })
      }

      const matchId = `${token.id}.${part++}`
      result.push({ id: matchId, node: buildMatch(matchId) })
      remaining = remaining.slice(cursor + needle.length)
      cursor = remaining.indexOf(needle)
    }

    if (remaining !== '') {
      result.push({ id: `${token.id}.${part++}`, node: remaining })
    }
  }

  return result
}

// Tokenize the plain diagnosis summary into runs of text, inline <code> for
// recognized hop hosts, and the unknown-host marker for "???". Longer hosts
// are matched first so a substring host does not eat a longer one.
export function DiagnosisSummary({ summary, hops }: DiagnosisSummaryProps): ReactNode {
  const hostTokens = [
    ...new Set(hops.map((hop) => hop.host).filter((host) => host.trim() !== '' && host !== '???')),
  ].sort((left, right) => right.length - left.length)

  let tokens: Token[] = [{ id: 'root', node: summary }]
  for (const host of hostTokens) {
    tokens = splitOn(tokens, host, () => <code>{host}</code>)
  }
  tokens = splitOn(tokens, '???', () => <UnknownHopHost />)

  return (
    <>
      {tokens.map((token) => (
        <span key={token.id}>{token.node}</span>
      ))}
    </>
  )
}
