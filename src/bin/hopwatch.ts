#!/usr/bin/env bun
import { Builtins, Cli, Command, Option } from 'clipanion'
import packageJson from '../../package.json' with { type: 'json' }
import { formatConfigSummary, type LoadedConfig, loadConfig } from '../lib/config.ts'
import { refreshRollups, runCollector } from '../lib/core.ts'
import { startDaemon } from '../lib/daemon.ts'
import { createLogger, type Logger } from '../lib/logger.ts'

// Source the CLI version from package.json (bumped by Changesets on release)
// so `hopwatch --version` cannot drift from the npm metadata.
const binaryVersion = packageJson.version

abstract class BaseCommand extends Command {
  config = Option.String('-c,--config', 'hopwatch.toml', {
    description: 'Path to hopwatch TOML config',
  })

  logLevel = Option.String('--log-level', {
    description: 'Override HOPWATCH_LOG_LEVEL (debug|info|warn|error)',
  })

  protected async resolve(): Promise<{ config: LoadedConfig; logger: Logger }> {
    const logger = createLogger({ level: this.logLevel })
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
    const result = await runCollector(config, logger)
    if (result.failedTargetSlugs.length > 0) {
      logger.error('probe-once completed with failures', {
        failed: result.failedTargetSlugs,
      })
      return 1
    }
    return 0
  }
}

class RollupCommand extends BaseCommand {
  static paths = [['rollup']]

  static usage = Command.Usage({
    description: 'Rebuild hourly and daily rollups from existing snapshots, without probing.',
  })

  async execute(): Promise<number> {
    const { config, logger } = await this.resolve()
    const { failedTargetSlugs } = await refreshRollups(config, logger)
    if (failedTargetSlugs.length > 0) {
      // `hopwatch rollup` is the documented recovery path for stale or
      // corrupt rollups; returning 0 here would tell operators the rebuild
      // worked when it partially did not. Surface the failed slugs and
      // exit non-zero so scripts and humans both notice.
      logger.error('rollups refresh failed for some targets', {
        failedTargetSlugs,
      })
      return 1
    }

    logger.info('rollups refreshed')
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
cli.register(RollupCommand)
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
