import type { ReactNode } from 'react'

const UNKNOWN_HOST_TITLE =
  "Unknown hop identity. The router at this TTL did not send an ICMP Time Exceeded reply that named itself (commonly because it drops or rate-limits ICMP, because reverse DNS has no PTR record, or because it's an anonymizing middlebox), so neither a hostname nor an IP could be recovered."

export function UnknownHopHost(): ReactNode {
  return <code title={UNKNOWN_HOST_TITLE}>???</code>
}

export function HopHost({ host }: { host: string }): ReactNode {
  if (host === '???') {
    return <UnknownHopHost />
  }

  return <code>{host}</code>
}
