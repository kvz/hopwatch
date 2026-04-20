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
export function getPeerNavLinks(
  selfLabel: string,
  peers: PeerConfig[],
  pathSuffix: string,
): ObserverRegionLink[] {
  const self: ObserverRegionLink = {
    host: selfLabel,
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
