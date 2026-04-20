type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface LoggerOptions {
  level: LogLevel
  name: string
  pretty: boolean
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger
  debug(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
}

function resolveLevel(raw: string | undefined): LogLevel {
  const normalized = raw?.toLowerCase().trim()
  if (normalized === 'debug' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }

  return 'info'
}

function formatJson(
  level: LogLevel,
  name: string,
  msg: string,
  bindings: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): string {
  const payload: Record<string, unknown> = {
    t: new Date().toISOString(),
    lvl: level,
    name,
    msg,
    ...bindings,
    ...(fields ?? {}),
  }
  return JSON.stringify(payload)
}

const prettyLevelColors: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
}

function formatPretty(
  level: LogLevel,
  name: string,
  msg: string,
  bindings: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): string {
  const color = prettyLevelColors[level]
  const reset = '\x1b[0m'
  const dim = '\x1b[2m'
  const merged = { ...bindings, ...(fields ?? {}) }
  const tail = Object.keys(merged).length
    ? ` ${dim}${Object.entries(merged)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ')}${reset}`
    : ''
  return `${dim}${new Date().toISOString()}${reset} ${color}${level.padEnd(5)}${reset} ${dim}[${name}]${reset} ${msg}${tail}`
}

function createLoggerWith(options: LoggerOptions, bindings: Record<string, unknown>): Logger {
  const threshold = levelRank[options.level]

  function emit(level: LogLevel, msg: string, fields: Record<string, unknown> | undefined): void {
    if (levelRank[level] < threshold) {
      return
    }

    const line = options.pretty
      ? formatPretty(level, options.name, msg, bindings, fields)
      : formatJson(level, options.name, msg, bindings, fields)

    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }

  return {
    child(extra) {
      return createLoggerWith(options, { ...bindings, ...extra })
    },
    debug(msg, fields) {
      emit('debug', msg, fields)
    },
    info(msg, fields) {
      emit('info', msg, fields)
    },
    warn(msg, fields) {
      emit('warn', msg, fields)
    },
    error(msg, fields) {
      emit('error', msg, fields)
    },
  }
}

export function createLogger(overrides: Partial<LoggerOptions> = {}): Logger {
  const options: LoggerOptions = {
    level: overrides.level ?? resolveLevel(process.env.HOPWATCH_LOG_LEVEL),
    name: overrides.name ?? 'hopwatch',
    pretty: overrides.pretty ?? process.stdout.isTTY === true,
  }
  return createLoggerWith(options, {})
}
