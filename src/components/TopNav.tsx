import type { ReactNode } from 'react'
import type { PeerConfig } from '../lib/config.ts'
import { getPeerNavLinks } from '../lib/layout.ts'

interface TopNavSection {
  href: string
  label: string
}

export interface TopNavProps {
  backHref?: string
  backLabel?: string
  pathSuffix: string
  peers: PeerConfig[]
  sections?: TopNavSection[]
  selfHost: string | null
  selfLabel: string
  title?: string
}

export function TopNav({
  backHref,
  backLabel,
  pathSuffix,
  peers,
  sections,
  selfHost,
  selfLabel,
  title,
}: TopNavProps): ReactNode {
  const links = getPeerNavLinks(selfLabel, selfHost, peers, pathSuffix)
  const activeLink = links.find((link) => link.isActive) ?? links[0]

  return (
    <nav className="topnav" aria-label="Primary">
      <div className="topnav-group topnav-group--left">
        <details className="topnav-dropdown">
          <summary>
            <span className="topnav-label">Node:</span>{' '}
            <span className="topnav-value">{activeLink.label}</span>
            <span className="topnav-caret" aria-hidden="true">
              ▾
            </span>
          </summary>
          <div className="topnav-menu">
            {links.map((link) => (
              <a
                key={link.url}
                className={`topnav-menu-item${link.isActive ? ' is-active' : ''}`}
                href={link.url}
                {...(link.isActive ? { 'aria-current': 'page' as const } : {})}
              >
                <span className="topnav-menu-label">{link.label}</span>
                <span className="topnav-menu-host">{link.host}</span>
              </a>
            ))}
          </div>
        </details>
        {backHref != null ? (
          <a className="topnav-back" href={backHref}>
            <span className="topnav-back-arrow" aria-hidden="true">
              ‹
            </span>{' '}
            {backLabel ?? 'Back'}
          </a>
        ) : null}
      </div>
      {title != null && title !== '' ? (
        title === 'hopwatch' ? (
          <a className="topnav-title" href="https://github.com/kvz/hopwatch/">
            {title}
          </a>
        ) : (
          <span className="topnav-title">{title}</span>
        )
      ) : null}
      <div className="topnav-group topnav-group--right">
        {sections != null && sections.length > 0 ? (
          <details className="topnav-dropdown topnav-dropdown--right">
            <summary>
              <span className="topnav-label">On this page</span>
              <span className="topnav-caret" aria-hidden="true">
                ▾
              </span>
            </summary>
            <div className="topnav-menu topnav-menu--right">
              {sections.map((section) => (
                <a key={section.href} className="topnav-menu-item" href={section.href}>
                  {section.label}
                </a>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </nav>
  )
}
