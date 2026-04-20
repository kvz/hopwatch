import type { PeerConfig } from './config.ts'

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export interface ObserverRegionLink {
  host: string
  isActive: boolean
  label: string
  url: string
}

// The self link always points at the current directory so it works regardless
// of how hopwatch is mounted (root, /hopwatch/, behind any reverse-proxy
// prefix). pathSuffix is only used when building absolute peer URLs.
// selfHost is the Host header of the current request (e.g.
// "observer1-ap-southeast-1-production.transloadit.com"). We combine it with
// the mount path borrowed from a remote peer (they all share the same
// deployment layout) so the active row's subtitle matches the remote rows —
// no more repeated label.
export function getPeerNavLinks(
  selfLabel: string,
  selfHost: string | null,
  peers: PeerConfig[],
  pathSuffix: string,
): ObserverRegionLink[] {
  let selfSubtitle = selfLabel
  if (selfHost != null) {
    const firstPeer = peers[0]
    let mountPath = ''
    if (firstPeer != null) {
      const peerUrl = firstPeer.url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
      const slash = peerUrl.indexOf('/')
      mountPath = slash === -1 ? '' : peerUrl.slice(slash)
    }
    selfSubtitle = `${selfHost}${mountPath}`
  }
  const self: ObserverRegionLink = {
    host: selfSubtitle,
    isActive: true,
    label: selfLabel,
    url: './',
  }
  const remote: ObserverRegionLink[] = peers.map((peer) => ({
    host: peer.url.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    isActive: false,
    label: peer.label,
    url: `${peer.url.replace(/\/+$/, '')}${pathSuffix}`,
  }))
  return [self, ...remote]
}
