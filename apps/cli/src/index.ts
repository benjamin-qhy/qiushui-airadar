import {
  initializeSingleTableConfig,
  loadSingleTableConfig,
  type SecretStatusReader,
} from '@qiushuiai-airadar/config'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  createSingleTableServiceApp,
  collectSingleTable,
} from '@qiushuiai-airadar/service'
import { fileURLToPath } from 'node:url'
import {
  createSystemServiceManager,
  type ManagedServiceCommand,
  type ServiceManager,
} from './service-manager.js'
import { productionDataRoot } from './paths.js'
import { upgradeFromGitHub } from './remote-upgrade.js'

interface Output {
  write(chunk: string): void
}

interface CliDependencies {
  stdout: Output
  stderr?: Output
  secretStatusReader?: SecretStatusReader
  serviceFactory?: typeof createSingleTableServiceApp
  serviceManager?: ServiceManager
  prepareConfig?: (dataRoot: string) => Promise<string>
  upgradeRunner?: typeof upgradeFromGitHub
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const version = JSON.parse(
  await readFile(path.join(packageRoot, 'package.json'), 'utf8')
).version as string

const help = `qiushuiai-airadar command line

Usage:
  qiushuiai-airadar status
  qiushuiai-airadar collect
  qiushuiai-airadar upgrade [--force]
  qiushuiai-airadar secrets status <NAME>
  qiushuiai-airadar service run [--host <HOST>] [--port <PORT>]
  qiushuiai-airadar service <install|start|stop|restart|status|uninstall> [--host <HOST>] [--port <PORT>]
`

function writeJson(output: Output, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`)
}

export async function runCli(
  args: string[],
  dependencies: CliDependencies
): Promise<number> {
  const [command, subcommand, name] = args
  if (!command || command === '--help' || command === 'help') {
    dependencies.stdout.write(help)
    return 0
  }
  if (command === '--version' || command === 'version') {
    dependencies.stdout.write(`${version}\n`)
    return 0
  }
  if (command === 'status') {
    writeJson(dependencies.stdout, {
      name: 'qiushuiai-airadar',
      status: 'ready',
      version,
    })
    return 0
  }
  if (command === 'secrets' && subcommand === 'status' && name) {
    if (!dependencies.secretStatusReader)
      throw new Error('Secret status reader is not configured')
    writeJson(
      dependencies.stdout,
      await dependencies.secretStatusReader.getStatus(name)
    )
    return 0
  }
  if (command === 'collect') {
    const dataRoot = path.resolve(
      process.env.QIUSHUIAI_AIRADAR_DATA_ROOT ?? productionDataRoot()
    )
    const results = await collectSingleTable({
      dataRoot,
      templateRoot: path.join(packageRoot, 'config'),
      promptsRoot: path.join(packageRoot, 'prompts'),
      secretFile:
        process.env.QIUSHUIAI_AIRADAR_SECRET_FILE ??
        path.join(dataRoot, '.env'),
    })
    writeJson(dependencies.stdout, results)
    return results.some((result) => result.failed) ? 1 : 0
  }
  if (command === 'upgrade') {
    const unknown = args.slice(1).filter((argument) => argument !== '--force')
    if (unknown.length)
      throw new Error(`Unknown upgrade option: ${unknown.join(' ')}`)
    const manager =
      dependencies.serviceManager ??
      createSystemServiceManager({
        nodePath: process.execPath,
        cliPath: process.argv[1] ?? '',
      })
    const result = await (dependencies.upgradeRunner ?? upgradeFromGitHub)({
      currentVersion: version,
      force: args.includes('--force'),
      serviceManager: manager,
      stdout: dependencies.stdout,
    })
    writeJson(dependencies.stdout, result)
    return 0
  }
  if (command === 'service') {
    const hostIndex = args.indexOf('--host')
    const portIndex = args.indexOf('--port')
    const host = hostIndex >= 0 ? args[hostIndex + 1] : '127.0.0.1'
    const portText = portIndex >= 0 ? args[portIndex + 1] : undefined
    const port = portText ? Number(portText) : 43120
    if (
      !host ||
      !['127.0.0.1', '::1', '0.0.0.0'].includes(host) ||
      (portIndex >= 0 && !portText) ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535
    ) {
      throw new Error('service requires a valid --host and --port')
    }
    const managedCommands = new Set<ManagedServiceCommand>([
      'install',
      'start',
      'stop',
      'restart',
      'status',
      'uninstall',
    ])
    if (managedCommands.has(subcommand as ManagedServiceCommand)) {
      const manager =
        dependencies.serviceManager ??
        createSystemServiceManager({
          nodePath: process.execPath,
          cliPath: process.argv[1] ?? '',
        })
      writeJson(
        dependencies.stdout,
        await manager.execute(subcommand as ManagedServiceCommand, {
          host,
          port,
        })
      )
      return 0
    }
    if (subcommand && subcommand !== 'run' && !subcommand.startsWith('--')) {
      throw new Error(`Unknown service command: ${subcommand}`)
    }
    const dataRoot = path.resolve(
      process.env.QIUSHUIAI_AIRADAR_DATA_ROOT ?? productionDataRoot()
    )
    const configRoot = dependencies.prepareConfig
      ? await dependencies.prepareConfig(dataRoot)
      : await initializeSingleTableConfig(
          path.join(packageRoot, 'config'),
          dataRoot
        )
    if (!dependencies.prepareConfig) await loadSingleTableConfig(configRoot)
    const address = await (
      dependencies.serviceFactory ?? createSingleTableServiceApp
    )({
      dataRoot,
      configRoot,
      secretFile:
        process.env.QIUSHUIAI_AIRADAR_SECRET_FILE ??
        path.join(dataRoot, '.env'),
      promptsRoot: path.join(packageRoot, 'prompts'),
      webRoot: fileURLToPath(new URL('../web', import.meta.url)),
    }).start({ host, port })
    writeJson(dependencies.stdout, {
      service: 'qiushuiai-airadar',
      status: 'ready',
      ...address,
    })
    return 0
  }

  dependencies.stderr?.write(`Unknown command: ${args.join(' ')}\n`)
  return 1
}
