#!/usr/bin/env bun
import { Builtins, Cli, Command, Option } from 'clipanion'
import { formatConfigSummary, type LoadedConfig, loadConfig } from '../lib/config.ts'
import { runCollector } from '../lib/core.ts'
import { startDaemon } from '../lib/daemon.ts'
import { createLogger, type Logger } from '../lib/logger.ts'

const binaryVersion = '0.1.0'

abstract class BaseCommand extends Command {
  config = Option.String('-c,--config', 'hopwatch.toml', {
    description: 'Path to hopwatch TOML config',
  })

  logLevel = Option.String('--log-level', {
    description: 'Override HOPWATCH_LOG_LEVEL (debug|info|warn|error)',
  })

  protected async resolve(): Promise<{ config: LoadedConfig; logger: Logger }> {
    const logger = createLogger({
      level: (this.logLevel as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? undefined,
    })
    const config = await loadConfig(this.config)
    return { config, logger }
  }
}

class DaemonCommand extends BaseCommand {
  static paths = [['daemon'], Command.Default]

  static usage = Command.Usage({
    description: 'Run the probe scheduler and HTTP dashboard in one process.',
  })

  async execute(): Promise<number> {
    const { config, logger } = await this.resolve()
    logger.info('starting daemon', { config: config.sourcePath })
    await startDaemon(config, logger)
    return 0
  }
}

class ProbeOnceCommand extends BaseCommand {
  static paths = [['probe-once']]

  static usage = Command.Usage({
    description: 'Run one collection cycle against every target, then exit.',
  })

  async execute(): Promise<number> {
    const { config, logger } = await this.resolve()
    logger.info('probing once', { targets: config.target.length })
    await runCollector(config, logger)
    return 0
  }
}

class RenderCommand extends BaseCommand {
  static paths = [['render']]

  static usage = Command.Usage({
    description: 'Re-render HTML and rollups from existing snapshots, without probing.',
  })

  async execute(): Promise<number> {
    const { config, logger } = await this.resolve()
    await runCollector(config, logger, { renderOnly: true })
    return 0
  }
}

class ConfigCheckCommand extends BaseCommand {
  static paths = [['config-check']]

  static usage = Command.Usage({
    description: 'Load and validate the config file, print a summary.',
  })

  async execute(): Promise<number> {
    const { config } = await this.resolve()
    this.context.stdout.write(`${formatConfigSummary(config)}\n`)
    return 0
  }
}

const cli = new Cli({
  binaryLabel: 'hopwatch',
  binaryName: 'hopwatch',
  binaryVersion,
})

cli.register(Builtins.HelpCommand)
cli.register(Builtins.VersionCommand)
cli.register(DaemonCommand)
cli.register(ProbeOnceCommand)
cli.register(RenderCommand)
cli.register(ConfigCheckCommand)

cli
  .runExit(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })
  .catch((err: unknown) => {
    if (!(err instanceof Error)) {
      throw new Error(`Was thrown a non-error: ${err}`)
    }

    process.stderr.write(`${err.stack ?? err.message}\n`)
    process.exitCode = 1
  })
