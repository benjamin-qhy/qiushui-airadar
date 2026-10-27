import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version as string
import { runCli } from './index.js'
import {
  createLaunchdDefinition,
  createWindowsServiceDefinition,
  parseWinswStatus,
} from './service-manager.js'

function outputBuffer() {
  let value = ''
  return {
    write(chunk: string) {
      value += chunk
    },
    value() {
      return value
    },
  }
}

describe('qiushui-airadar CLI', () => {
  it('rejects invalid ports and unsupported installation hosts', async () => {
    for (const args of [
      ['service', 'run', '--port', '123junk'],
      ['service', 'run', '--port'],
      ['service', 'install', '--host', '192.168.3.108'],
    ]) {
      await expect(runCli(args, { stdout: outputBuffer() })).rejects.toThrow(
        'valid --host and --port'
      )
    }
  })

  it('reports the source shell status', async () => {
    const stdout = outputBuffer()
    expect(await runCli(['status'], { stdout })).toBe(0)
    expect(JSON.parse(stdout.value())).toEqual({
      name: 'qiushui-airadar',
      status: 'ready',
      version: packageVersion,
    })
  })

  it('routes remote upgrades and preserves the force option', async () => {
    const stdout = outputBuffer()
    let forced = false
    expect(
      await runCli(['upgrade', '--force'], {
        stdout,
        serviceManager: {
          async execute() {
            return {}
          },
        },
        async upgradeRunner(options) {
          forced = options.force === true
          return {
            previousVersion: packageVersion,
            version: packageVersion,
            changed: false,
          }
        },
      })
    ).toBe(0)
    expect(forced).toBe(true)
    expect(stdout.value()).toContain('"changed":false')
  })

  it('prints only the safe secret status interface', async () => {
    const stdout = outputBuffer()
    const rawSecret = 'super-secret-value'
    expect(
      await runCli(['secrets', 'status', 'TIKHUB_TOKEN'], {
        stdout,
        secretStatusReader: {
          async getStatus(name: string) {
            return { name, configured: true, maskedValue: 'su••••••••••••••ue' }
          },
        },
      })
    ).toBe(0)
    expect(stdout.value()).not.toContain(rawSecret)
    expect(JSON.parse(stdout.value())).toEqual({
      name: 'TIKHUB_TOKEN',
      configured: true,
      maskedValue: 'su••••••••••••••ue',
    })
  })

  it('starts the single-table service with bundled configuration and prompts', async () => {
    const stdout = outputBuffer()
    let singleTable = false
    expect(
      await runCli(['service', '--port', '0'], {
        stdout,
        async prepareConfig(root) {
          return `${root}/config`
        },
        serviceFactory(options) {
          singleTable = Boolean(options?.configRoot && options?.promptsRoot)
          return {
            async start({ host, port }) {
              return { host, port }
            },
            async stop() {},
          }
        },
      })
    ).toBe(0)
    expect(singleTable).toBe(true)
  })

  it('routes managed service commands without starting the foreground server', async () => {
    const stdout = outputBuffer()
    const calls: string[] = []
    expect(
      await runCli(['service', 'install', '--host', '127.0.0.1'], {
        stdout,
        serviceManager: {
          async execute(command, options) {
            calls.push(`${command}:${options.host}:${options.port}`)
            return { service: 'qiushui-airadar', status: 'installed' }
          },
        },
      })
    ).toBe(0)
    expect(calls).toEqual(['install:127.0.0.1:43120'])
    expect(JSON.parse(stdout.value())).toEqual({
      service: 'qiushui-airadar',
      status: 'installed',
    })
  })

  it('allows installing a service on all IPv4 interfaces', async () => {
    const calls: string[] = []
    expect(
      await runCli(['service', 'install', '--host', '0.0.0.0'], {
        stdout: outputBuffer(),
        serviceManager: {
          async execute(command, options) {
            calls.push(`${command}:${options.host}:${options.port}`)
            return { status: 'installed' }
          },
        },
      })
    ).toBe(0)
    expect(calls).toEqual(['install:0.0.0.0:43120'])
  })

  it('keeps service run as the foreground entry used by service wrappers', async () => {
    const stdout = outputBuffer()
    let singleTable = false
    expect(
      await runCli(['service', 'run', '--port', '0'], {
        stdout,
        async prepareConfig(root) {
          return `${root}/config`
        },
        serviceFactory(options) {
          singleTable = Boolean(options?.configRoot && options?.promptsRoot)
          return {
            async start({ host, port }) {
              return { host, port }
            },
            async stop() {},
          }
        },
      })
    ).toBe(0)
    expect(singleTable).toBe(true)
  })
})

describe('service definitions', () => {
  it('creates a launchd agent with startup and crash restart enabled', () => {
    const definition = createLaunchdDefinition({
      nodePath: '/opt/node/bin/node',
      cliPath: '/opt/qiushui-airadar/cli.js',
      dataRoot: '/Users/test/.qiushui-airadar/data',
      logRoot: '/Users/test/.qiushui-airadar/logs',
      host: '127.0.0.1',
      port: 43110,
      runtimeEnvironment: {
        CODEX_AUTH_PATH: '/Users/test/.codex/auth.json',
      },
    })
    expect(definition).toContain('<key>RunAtLoad</key>')
    expect(definition).toContain('<key>KeepAlive</key>')
    expect(definition).toContain('/opt/qiushui-airadar/cli.js')
    expect(definition).toContain('QIUSHUI_AIRADAR_DATA_ROOT')
    expect(definition).toContain('CODEX_AUTH_PATH')
    expect(definition).toContain('/Users/test/.codex/auth.json')
    expect(definition).toContain('127.0.0.1')
  })

  it('creates a WinSW definition with restart, explicit paths, and no secret values', () => {
    const definition = createWindowsServiceDefinition({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cliPath: 'C:\\qiushui-airadar\\cli.js',
      dataRoot: 'C:\\Users\\test\\.qiushui-airadar\\data',
      logRoot: 'C:\\Users\\test\\.qiushui-airadar\\logs',
      host: '127.0.0.1',
      port: 43110,
      runtimeEnvironment: {
        CODEX_AUTH_PATH: 'C:\\Users\\test\\.codex\\auth.json',
      },
    })
    expect(definition).toContain('<onfailure action="restart"')
    expect(definition).toContain('<startmode>Automatic</startmode>')
    expect(definition).toContain('C:\\qiushui-airadar\\cli.js')
    expect(definition).toContain('QIUSHUI_AIRADAR_DATA_ROOT')
    expect(definition).toContain('<username>LocalSystem</username>')
    expect(definition).toContain('CODEX_AUTH_PATH')
    expect(definition).toContain('C:\\Users\\test\\.codex\\auth.json')
    expect(definition).not.toMatch(/api.?key|token|secret=/iu)
  })

  it('distinguishes running and stopped WinSW states', () => {
    expect(parseWinswStatus('Active (running)')).toBe('running')
    expect(parseWinswStatus('Started')).toBe('running')
    expect(parseWinswStatus('Inactive (stopped)')).toBe('stopped')
    expect(parseWinswStatus('Stopped')).toBe('stopped')
    expect(parseWinswStatus('NonExistent')).toBe('not-installed')
  })
})
