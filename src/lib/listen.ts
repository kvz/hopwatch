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
    const firstColon = listen.indexOf(':')
    if (firstColon < 0) {
      throw new Error(`Invalid listen address "${listen}"`)
    }
    const hostPart = listen.slice(0, firstColon)
    const portPart = listen.slice(firstColon + 1)
    // An unbracketed host part may not itself contain a colon. `host:123:456`
    // would otherwise be split via lastIndexOf into hostname="host:123" +
    // port=456, silently accepting what is almost certainly a typo for an
    // unbracketed IPv6 literal. Bracketed form (`[::1]:8080`) is the only way
    // to encode a colon-bearing hostname.
    if (hostPart.includes(':') || portPart.includes(':')) {
      throw new Error(`Invalid listen address "${listen}"`)
    }
    hostname = hostPart.length === 0 ? undefined : hostPart
    portRaw = portPart
  }

  // `Number("")` silently coerces to 0, which would then pass every remaining
  // check and leave Bun.serve binding a random ephemeral port - hiding a typo
  // like `listen = "127.0.0.1:"` until the next operator wonders why the
  // dashboard is on a different port on each restart.
  if (portRaw === '') {
    throw new Error(`Invalid listen port in "${listen}"`)
  }

  const port = Number(portRaw)
  // Port 0 is a legitimate value - Bun.serve interprets it as "bind any
  // available port", which tests rely on to avoid collisions.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid listen port in "${listen}"`)
  }

  return { hostname, port }
}
