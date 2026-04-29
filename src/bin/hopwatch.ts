#!/usr/bin/env bun
import { Builtins, Cli, Command, Option } from 'clipanion'
import packageJson from '../../package.json' with { type: 'json' }
import { formatConfigSummary, type LoadedConfig, loadConfig } from '../lib/config.ts'
import { refreshRollups, runCollector } from '../lib/core.ts'
import { startDaemon } from '../lib/daemon.ts'
import { createLogger, type Logger } from '../lib/logger.ts'
import {
  HopwatchSqliteStore,
  importSnapshotsFromDataDir,
  verifySqliteAgainstDataDir,
} from '../lib/sqlite-storage.ts'

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
    if (result.failedTargetSlugs.length > 0 || result.failedRollupSlugs.length > 0) {
      logger.error('probe-once completed with failures', {
        failedRollupSlugs: result.failedRollupSlugs,
        failedTargetSlugs: result.failedTargetSlugs,
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

class StorageImportCommand extends BaseCommand {
  static paths = [['storage', 'import']]

  static usage = Command.Usage({
    description: 'Import existing JSON snapshots and rollups into the SQLite database.',
  })

  db = Option.String('--db', {
    description: 'SQLite path; defaults to storage.sqlite_path or data_dir/hopwatch.sqlite',
  })

  strictExtra = Option.Boolean('--strict-extra', false, {
    description: 'Fail verification if SQLite contains snapshots no longer present as JSON files.',
  })

  skipVerify = Option.Boolean('--skip-verify', false, {
    description: 'Skip count and sha256 verification after import.',
  })

  async execute(): Promise<number> {
    const { config, logger } = await this.resolve()
    const dbPath = this.db ?? config.resolvedSqlitePath
    const store = await HopwatchSqliteStore.open(dbPath)
    try {
      const result = await importSnapshotsFromDataDir(store, config.resolvedDataDir, logger)
      logger.info('sqlite import completed', {
        dbPath,
        failed: result.failed.length,
        imported: result.imported,
        scanned: result.scanned,
      })

      if (result.failed.length > 0) {
        return 1
      }

      if (this.skipVerify) {
        return 0
      }

      const verify = await verifySqliteAgainstDataDir(store, config.resolvedDataDir, {
        strictExtra: this.strictExtra,
      })
      logger.info('sqlite verification completed', {
        extraInSqlite: verify.extraInSqlite.length,
        fileSnapshotCount: verify.fileSnapshotCount,
        missingInSqlite: verify.missingInSqlite.length,
        shaMismatches: verify.shaMismatches.length,
        sqliteIntegrity: verify.sqliteIntegrity,
        sqliteSnapshotCount: verify.sqliteSnapshotCount,
      })
      return verify.ok ? 0 : 1
    } finally {
      store.close()
    }
  }
}

class StorageVerifyCommand extends BaseCommand {
  static paths = [['storage', 'verify']]

  static usage = Command.Usage({
    description: 'Verify that SQLite contains every current JSON snapshot with matching sha256.',
  })

  db = Option.String('--db', {
    description: 'SQLite path; defaults to storage.sqlite_path or data_dir/hopwatch.sqlite',
  })

  strictExtra = Option.Boolean('--strict-extra', false, {
    description: 'Fail if SQLite contains snapshots no longer present as JSON files.',
  })

  async execute(): Promise<number> {
    const { config, logger } = await this.resolve()
    const dbPath = this.db ?? config.resolvedSqlitePath
    const store = await HopwatchSqliteStore.open(dbPath)
    try {
      const verify = await verifySqliteAgainstDataDir(store, config.resolvedDataDir, {
        strictExtra: this.strictExtra,
      })
      logger.info('sqlite verification completed', {
        dbPath,
        extraInSqlite: verify.extraInSqlite.length,
        fileSnapshotCount: verify.fileSnapshotCount,
        missingInSqlite: verify.missingInSqlite.length,
        shaMismatches: verify.shaMismatches.length,
        sqliteIntegrity: verify.sqliteIntegrity,
        sqliteSnapshotCount: verify.sqliteSnapshotCount,
      })
      return verify.ok ? 0 : 1
    } finally {
      store.close()
    }
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
cli.register(StorageImportCommand)
cli.register(StorageVerifyCommand)
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
