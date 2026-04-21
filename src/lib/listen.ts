export interface ParsedListenAddress {
  hostname: string | undefined
  port: number
}

export function parseListenAddress(listen: string): ParsedListenAddress {
  // Accept [ipv6]:port, host:port, and :port (bind-all).
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(listen)
  let hostname: string | undefined
  let portRaw: string
  if (bracketed != null) {
    hostname = bracketed[1]
    portRaw = bracketed[2]
  } else {
    const lastColon = listen.lastIndexOf(':')
    if (lastColon < 0) {
      throw new Error(`Invalid listen address "${listen}"`)
    }
    const hostPart = listen.slice(0, lastColon)
    hostname = hostPart.length === 0 ? undefined : hostPart
    portRaw = listen.slice(lastColon + 1)
  }

  // `Number("")` silently coerces to 0, which would then pass every remaining
  // check and leave Bun.serve binding a random ephemeral port — hiding a typo
  // like `listen = "127.0.0.1:"` until the next operator wonders why the
  // dashboard is on a different port on each restart.
  if (portRaw === '') {
    throw new Error(`Invalid listen port in "${listen}"`)
  }

  const port = Number(portRaw)
  // Port 0 is a legitimate value — Bun.serve interprets it as "bind any
  // available port", which tests rely on to avoid collisions.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid listen port in "${listen}"`)
  }

  return { hostname, port }
}
