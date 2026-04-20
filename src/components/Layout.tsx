import type { ReactNode } from 'react'
import { styles } from './styles.ts'

interface LayoutProps {
  title: string
  children: ReactNode
}

export function Layout({ title, children }: LayoutProps): ReactNode {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style>{styles}</style>
      </head>
      <body>
        <main>{children}</main>
        <script src="./assets/sortable-tables.js" defer />
      </body>
    </html>
  )
}
