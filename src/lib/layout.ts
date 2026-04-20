import type { PeerConfig } from './config.ts'

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

interface ObserverRegionLink {
  host: string
  isActive: boolean
  label: string
  url: string
}

export function getPeerNavLinks(
  selfLabel: string,
  peers: PeerConfig[],
  pathSuffix: string,
): ObserverRegionLink[] {
  // The self link always points at the current directory so it works regardless
  // of how hopwatch is mounted (root, /hopwatch/, behind any reverse-proxy
  // prefix). pathSuffix is only used when building absolute peer URLs.
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

interface TopNavSection {
  href: string
  label: string
}

interface TopNavOptions {
  backHref?: string
  backLabel?: string
  pathSuffix: string
  peers: PeerConfig[]
  sections?: TopNavSection[]
  selfLabel: string
  title?: string
}

export function renderTopNav(options: TopNavOptions): string {
  const { backHref, backLabel, pathSuffix, peers, sections, selfLabel, title } = options
  const links = getPeerNavLinks(selfLabel, peers, pathSuffix)
  const activeLink = links.find((link) => link.isActive) ?? links[0]
  const nodeItems = links
    .map((link) => {
      const activeClass = link.isActive ? ' is-active' : ''
      const aria = link.isActive ? ' aria-current="page"' : ''
      return `      <a class="topnav-menu-item${activeClass}" href="${escapeHtml(link.url)}"${aria}><span class="topnav-menu-label">${escapeHtml(link.label)}</span><span class="topnav-menu-host">${escapeHtml(link.host)}</span></a>`
    })
    .join('\n')
  const nodesMenu = `    <details class="topnav-dropdown">
      <summary><span class="topnav-label">Node:</span> <span class="topnav-value">${escapeHtml(activeLink.label)}</span><span class="topnav-caret" aria-hidden="true">▾</span></summary>
      <div class="topnav-menu">
${nodeItems}
      </div>
    </details>`
  const tocMenu =
    sections && sections.length > 0
      ? `    <details class="topnav-dropdown topnav-dropdown--right">
      <summary><span class="topnav-label">On this page</span><span class="topnav-caret" aria-hidden="true">▾</span></summary>
      <div class="topnav-menu topnav-menu--right">
${sections
  .map(
    (section) =>
      `        <a class="topnav-menu-item" href="${escapeHtml(section.href)}">${escapeHtml(section.label)}</a>`,
  )
  .join('\n')}
      </div>
    </details>`
      : ''
  const backLink = backHref
    ? `    <a class="topnav-back" href="${escapeHtml(backHref)}"><span class="topnav-back-arrow" aria-hidden="true">‹</span> ${escapeHtml(backLabel ?? 'Back')}</a>`
    : ''
  const titleEl = title
    ? title === 'hopwatch'
      ? `  <a class="topnav-title" href="https://github.com/kvz/hopwatch/">${escapeHtml(title)}</a>`
      : `  <span class="topnav-title">${escapeHtml(title)}</span>`
    : ''
  return `<nav class="topnav" aria-label="Primary">
  <div class="topnav-group topnav-group--left">
${[nodesMenu, backLink].filter((part) => part.length > 0).join('\n')}
  </div>
${titleEl}
  <div class="topnav-group topnav-group--right">
${tocMenu}
  </div>
</nav>`
}

export function renderLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f6f1;
      --panel: #fffdf6;
      --text: #1d2a20;
      --muted: #58635b;
      --line: #d9ddcf;
      --good: #245c2a;
      --warn: #915f00;
      --bad: #9f1d1d;
      --accent: #184d47;
      --code: #edf1e5;
      --scale-0: #245c2a;
      --scale-1: #56711c;
      --scale-2: #857000;
      --scale-3: #a15b00;
      --scale-4: #b04611;
      --scale-5: #9f1d1d;
    }

    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: linear-gradient(180deg, #f1f1ea 0%, var(--bg) 100%);
      color: var(--text);
    }

    main {
      max-width: 1480px;
      margin: 0 auto;
      padding: 32px 20px 56px;
    }

    h1, h2 {
      margin: 0 0 12px;
      line-height: 1.1;
    }

    p, li {
      line-height: 1.5;
    }

    a {
      color: var(--accent);
    }

    .topnav {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 16px;
      margin: -32px -20px 24px;
      padding: 10px 20px;
      background: rgba(255, 253, 246, 0.88);
      backdrop-filter: saturate(1.3) blur(10px);
      -webkit-backdrop-filter: saturate(1.3) blur(10px);
      border-bottom: 1px solid var(--line);
      box-shadow: 0 6px 18px rgba(17, 24, 20, 0.05);
    }

    .topnav-group {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .topnav-group--left {
      flex: 1 1 auto;
    }

    .topnav-group--right {
      flex: 0 0 auto;
      margin-left: auto;
    }

    .topnav-title {
      flex: 0 1 auto;
      min-width: 0;
      font-weight: 700;
      font-size: 14px;
      color: var(--text);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    a.topnav-title:hover {
      color: var(--accent);
    }

    dfn {
      font-style: normal;
      cursor: help;
      border-bottom: 1px dotted var(--muted);
    }

    .topnav-back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 8px;
      text-decoration: none;
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
    }

    .topnav-back:hover {
      background: rgba(24, 77, 71, 0.08);
    }

    .topnav-back-arrow {
      font-size: 16px;
      line-height: 1;
    }

    .topnav-dropdown {
      position: relative;
      font-size: 13px;
    }

    .topnav-dropdown > summary {
      list-style: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfaf4;
      color: var(--accent);
      font-weight: 600;
      user-select: none;
    }

    .topnav-dropdown > summary::-webkit-details-marker {
      display: none;
    }

    .topnav-dropdown > summary:hover {
      background: #f2efe4;
    }

    .topnav-dropdown[open] > summary {
      background: var(--accent);
      border-color: var(--accent);
      color: #f7f7f1;
    }

    .topnav-label {
      color: var(--muted);
      font-weight: 500;
    }

    .topnav-dropdown[open] .topnav-label {
      color: rgba(247, 247, 241, 0.75);
    }

    .topnav-value {
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .topnav-caret {
      font-size: 10px;
      line-height: 1;
    }

    .topnav-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      min-width: 220px;
      display: flex;
      flex-direction: column;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      box-shadow: 0 14px 32px rgba(17, 24, 20, 0.12);
      z-index: 30;
    }

    .topnav-menu--right {
      left: auto;
      right: 0;
    }

    .topnav-menu-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border-radius: 6px;
      text-decoration: none;
      color: var(--text);
      font-size: 13px;
    }

    .topnav-menu-item:hover {
      background: var(--code);
    }

    .topnav-menu-item.is-active {
      background: rgba(24, 77, 71, 0.1);
      color: var(--accent);
      font-weight: 600;
    }

    .topnav-menu-label {
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 12px;
    }

    .topnav-menu-host {
      font-size: 11px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }

    .topnav-menu-item.is-active .topnav-menu-host {
      color: var(--accent);
    }

    .lede {
      color: var(--muted);
      margin-bottom: 24px;
    }

    .status-age {
      color: var(--muted);
      font-weight: 500;
      white-space: nowrap;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px 20px;
      box-shadow: 0 10px 24px rgba(17, 24, 20, 0.04);
      margin-bottom: 20px;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }

    .summary-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.5);
      padding: 12px 14px;
    }

    .summary-card strong {
      display: block;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .graph-grid {
      display: grid;
      gap: 14px;
    }

    .graph-grid--mini {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    .graph-grid--root {
      grid-template-columns: 1fr;
    }

    .graph-card {
      display: block;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.6);
      padding: 12px;
      text-decoration: none;
      color: inherit;
      box-shadow: 0 8px 18px rgba(17, 24, 20, 0.04);
    }

    .graph-card h3 {
      margin: 0 0 8px;
      font-size: 15px;
      line-height: 1.2;
    }

    .graph-card img {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 10px;
      background: #f3f5ee;
      border: 1px solid rgba(29, 42, 32, 0.08);
    }

    .chart-svg {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 10px;
    }

    .thumb-link {
      display: block;
      min-width: 158px;
    }

    .thumb-link img {
      display: none;
    }

    .thumb-link svg {
      display: block;
      width: 158px;
      max-width: 100%;
      height: 42px;
      border-radius: 6px;
    }

    .graph-caption {
      margin-top: 8px;
      font-size: 12px;
      color: var(--muted);
    }

    .target-meta {
      margin-bottom: 18px;
    }

    time[datetime] {
      white-space: nowrap;
    }

    .table-wrap {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin: 0 -4px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    th, td {
      text-align: left;
      padding: 10px 8px;
      border-top: 1px solid var(--line);
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-weight: 600;
      border-top: 0;
      padding-top: 0;
      white-space: nowrap;
    }

    code, pre {
      font-family: ui-monospace, SFMono-Regular, monospace;
    }

    pre {
      background: var(--code);
      border-radius: 12px;
      padding: 14px;
      overflow-x: auto;
      max-width: 100%;
      font-size: 12px;
      line-height: 1.45;
    }

    .scroll-x {
      max-width: 100%;
      overflow-x: auto;
    }

    .panel-hint {
      color: var(--muted);
      font-size: 13px;
      margin: 4px 0 10px;
    }

    details.raw-events {
      margin-top: 12px;
    }

    details.raw-events > summary {
      cursor: pointer;
      color: var(--accent);
      font-size: 13px;
    }

    .loss {
      font-weight: 700;
    }

    .loss.good {
      color: var(--good);
    }

    .loss.warn {
      color: var(--warn);
    }

    .loss.bad {
      color: var(--bad);
    }

    .loss.unknown {
      color: var(--muted);
    }

    .loss.scale-0 {
      color: var(--scale-0);
    }

    .loss.scale-1 {
      color: var(--scale-1);
    }

    .loss.scale-2 {
      color: var(--scale-2);
    }

    .loss.scale-3 {
      color: var(--scale-3);
    }

    .loss.scale-4 {
      color: var(--scale-4);
    }

    .loss.scale-5 {
      color: var(--scale-5);
    }

    @media (max-width: 760px) {
      main {
        padding: 20px 14px 40px;
      }

      .topnav {
        margin: -20px -14px 16px;
        padding: 8px 14px;
        gap: 10px;
      }

      .topnav-title {
        display: none;
      }

      .topnav-group {
        gap: 8px;
      }

      .topnav-menu {
        min-width: 180px;
      }

      .panel {
        padding: 14px 12px;
        border-radius: 12px;
      }

      h1 {
        font-size: 26px;
        overflow-wrap: anywhere;
      }

      th, td {
        padding: 8px 6px;
      }

      pre {
        font-size: 11px;
        padding: 10px;
      }
    }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>
`
}
