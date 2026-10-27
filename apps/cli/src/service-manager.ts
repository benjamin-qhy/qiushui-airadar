import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { productionDataRoot, serviceRoot } from './paths.js'

const executeFile = promisify(execFile)
const launchdLabel = 'ai.qiushui.qiushui-airadar'
const winswVersion = '2.12.0'
const winswUrl = `https://github.com/winsw/winsw/releases/download/v${winswVersion}/WinSW.NET461.exe`
const winswSha256 =
  'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f'

export type ManagedServiceCommand =
  'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall'

export interface ManagedServiceOptions {
  host: string
  port: number
}

export interface ServiceManager {
  execute(
    command: ManagedServiceCommand,
    options: ManagedServiceOptions
  ): Promise<Record<string, unknown>>
}

interface DefinitionOptions extends ManagedServiceOptions {
  nodePath: string
  cliPath: string
  dataRoot: string
  logRoot: string
  secretFile?: string
  runtimeEnvironment?: Record<string, string>
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function createLaunchdDefinition(options: DefinitionOptions): string {
  const args = [
    options.nodePath,
    options.cliPath,
    'service',
    'run',
    '--host',
    options.host,
    '--port',
    String(options.port),
  ]
  const environment = [
    ['QIUSHUI_AIRADAR_DATA_ROOT', options.dataRoot],
    ...(options.secretFile
      ? ([['QIUSHUI_AIRADAR_SECRET_FILE', options.secretFile]] as const)
      : []),
    ...Object.entries(options.runtimeEnvironment ?? {}),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((argument) => `    <string>${xml(argument)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment.map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(options.logRoot, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(options.logRoot, 'service.error.log'))}</string>
</dict>
</plist>
`
}

export function createWindowsServiceDefinition(
  options: DefinitionOptions
): string {
  const argumentsValue = [
    `&quot;${xml(options.cliPath)}&quot;`,
    'service run',
    `--host ${xml(options.host)}`,
    `--port ${options.port}`,
  ].join(' ')
  const environment = {
    QIUSHUI_AIRADAR_DATA_ROOT: options.dataRoot,
    ...(options.secretFile
      ? { QIUSHUI_AIRADAR_SECRET_FILE: options.secretFile }
      : {}),
    ...options.runtimeEnvironment,
  }
  return `<service>
  <id>qiushui-airadar</id>
  <name>qiushui-airadar</name>
  <description>qiushui-airadar local collection and Web service</description>
  <executable>${xml(options.nodePath)}</executable>
  <arguments>${argumentsValue}</arguments>
${Object.entries(environment)
  .map(([name, value]) => `  <env name="${name}" value="${xml(value)}"/>`)
  .join('\n')}
  <serviceaccount>
    <username>LocalSystem</username>
  </serviceaccount>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="15 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <logpath>${xml(options.logRoot)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
`
}

export function parseWinswStatus(
  output: string
): 'running' | 'stopped' | 'not-installed' {
  if (/inactive\s*\(stopped\)|\bstopped\b/iu.test(output)) return 'stopped'
  if (/active\s*\(running\)|\bstarted\b/iu.test(output)) return 'running'
  return 'not-installed'
}

interface SystemServiceManagerOptions {
  platform?: NodeJS.Platform
  home?: string
  nodePath: string
  cliPath: string
  fetchBinary?: (url: string) => Promise<Buffer>
}

async function runAllowMissing(
  executable: string,
  args: string[]
): Promise<boolean> {
  try {
    await executeFile(executable, args)
    return true
  } catch {
    return false
  }
}

async function runWithRetry(
  executable: string,
  args: string[],
  attempts = 10
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await executeFile(executable, args)
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }
  throw lastError
}

async function ensureWinsw(
  executablePath: string,
  fetchBinary: (url: string) => Promise<Buffer>
): Promise<void> {
  let existing: Buffer | undefined
  try {
    existing = await readFile(executablePath)
  } catch {
    // Downloaded below.
  }
  if (
    existing &&
    createHash('sha256').update(existing).digest('hex') === winswSha256
  ) {
    return
  }
  const binary = await fetchBinary(winswUrl)
  const digest = createHash('sha256').update(binary).digest('hex')
  if (digest !== winswSha256) {
    throw new Error('Downloaded WinSW binary failed SHA-256 verification')
  }
  await writeFile(executablePath, binary, { mode: 0o700 })
  await chmod(executablePath, 0o700)
}

export function createSystemServiceManager(
  options: SystemServiceManagerOptions
): ServiceManager {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const managedServiceRoot = serviceRoot(home)
  const dataRoot =
    process.env.QIUSHUI_AIRADAR_DATA_ROOT ?? productionDataRoot(home)
  const logRoot = path.join(managedServiceRoot, 'logs')
  const secretFile =
    process.env.QIUSHUI_AIRADAR_SECRET_FILE ?? path.join(dataRoot, '.env')
  const runtimeEnvironment = Object.fromEntries(
    [
      [
        'CODEX_AUTH_PATH',
        process.env.CODEX_AUTH_PATH ?? path.join(home, '.codex', 'auth.json'),
      ],
      [
        'QIUSHUI_AIRADAR_WEB_ORIGINS',
        process.env.QIUSHUI_AIRADAR_WEB_ORIGINS,
      ],
      [
        'QIUSHUI_AIRADAR_TRANSCRIBER_URL',
        process.env.QIUSHUI_AIRADAR_TRANSCRIBER_URL,
      ],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  )

  return {
    async execute(command, serviceOptions) {
      await mkdir(logRoot, { recursive: true })
      if (platform === 'darwin') {
        const plistPath = path.join(
          home,
          'Library',
          'LaunchAgents',
          `${launchdLabel}.plist`
        )
        const target = `gui/${process.getuid?.() ?? 0}/${launchdLabel}`
        const domain = `gui/${process.getuid?.() ?? 0}`
        if (command === 'install') {
          await mkdir(path.dirname(plistPath), { recursive: true })
          await writeFile(
            plistPath,
            createLaunchdDefinition({
              ...serviceOptions,
              nodePath: options.nodePath,
              cliPath: options.cliPath,
              dataRoot,
              logRoot,
              secretFile,
              runtimeEnvironment,
            }),
            { mode: 0o600 }
          )
          await runAllowMissing('launchctl', ['bootout', target])
          await runWithRetry('launchctl', ['bootstrap', domain, plistPath])
        } else if (command === 'start') {
          await runWithRetry('launchctl', ['bootstrap', domain, plistPath])
        } else if (command === 'stop') {
          await executeFile('launchctl', ['bootout', target])
        } else if (command === 'restart') {
          const restarted = await runAllowMissing('launchctl', [
            'kickstart',
            '-k',
            target,
          ])
          if (!restarted) {
            await runWithRetry('launchctl', ['bootstrap', domain, plistPath])
          }
        } else if (command === 'status') {
          let running = false
          try {
            const { stdout } = await executeFile('launchctl', ['print', target])
            running =
              /state = running/u.test(stdout) && /pid = \d+/u.test(stdout)
          } catch {
            /* Unloaded service is stopped. */
          }
          return {
            service: 'qiushui-airadar',
            status: running ? 'running' : 'stopped',
            platform: 'macOS',
            definition: plistPath,
          }
        } else {
          await runAllowMissing('launchctl', ['bootout', target])
          await unlink(plistPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
        return {
          service: 'qiushui-airadar',
          status: command === 'uninstall' ? 'uninstalled' : command,
          platform: 'macOS',
          definition: plistPath,
        }
      }

      if (platform === 'win32') {
        const wrapperPath = path.join(
          managedServiceRoot,
          'qiushui-airadar-service.exe'
        )
        const definitionPath = path.join(
          managedServiceRoot,
          'qiushui-airadar-service.xml'
        )
        const fetchBinary =
          options.fetchBinary ??
          (async (url: string) => {
            const response = await fetch(url)
            if (!response.ok) {
              throw new Error(
                `Unable to download WinSW: HTTP ${response.status}`
              )
            }
            return Buffer.from(await response.arrayBuffer())
          })
        if (command === 'install') {
          await ensureWinsw(wrapperPath, fetchBinary)
          await writeFile(
            definitionPath,
            createWindowsServiceDefinition({
              ...serviceOptions,
              nodePath: options.nodePath,
              cliPath: options.cliPath,
              dataRoot,
              logRoot,
              secretFile,
              runtimeEnvironment,
            }),
            { mode: 0o600 }
          )
          await runAllowMissing(wrapperPath, ['stop', definitionPath])
          await runAllowMissing(wrapperPath, ['uninstall', definitionPath])
          await executeFile(wrapperPath, ['install', definitionPath])
          await executeFile(wrapperPath, ['start', definitionPath])
        } else if (command === 'uninstall') {
          await runAllowMissing(wrapperPath, ['stop', definitionPath])
          await executeFile(wrapperPath, ['uninstall', definitionPath])
        } else if (command === 'status') {
          let status: ReturnType<typeof parseWinswStatus> = 'not-installed'
          try {
            const result = await executeFile(wrapperPath, [
              'status',
              definitionPath,
            ])
            status = parseWinswStatus(`${result.stdout}\n${result.stderr}`)
          } catch {
            // A missing Windows service is reported as not installed.
          }
          return {
            service: 'qiushui-airadar',
            status,
            platform: 'Windows',
            definition: definitionPath,
          }
        } else {
          await executeFile(wrapperPath, [command, definitionPath])
        }
        return {
          service: 'qiushui-airadar',
          status: command === 'uninstall' ? 'uninstalled' : command,
          platform: 'Windows',
          definition: definitionPath,
        }
      }

      throw new Error(
        'Managed services are supported only on macOS and Windows'
      )
    },
  }
}
