import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { SingleTableRepository } from '../packages/runtime/src/index.js'

const execute = promisify(execFile)
const packageManagerCli = process.env.npm_execpath
if (!packageManagerCli) throw new Error('Run through pnpm smoke:deployed')
const tempRoot = join(process.cwd(), '.tmp')
await mkdir(tempRoot, { recursive: true })
const target = await mkdtemp(join(tempRoot, 'qiushui-airadar-install-upgrade-'))
const installRoot = join(target, 'install')
const dataRoot = join(target, 'data')
const staging = join(target, 'candidate')
const packRoot = join(target, 'pack')
const children = new Set<ChildProcess>()

async function install(tarball: string) {
  const args = [
    'install',
    '--prefix',
    installRoot,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ]
  if (process.platform === 'win32') {
    await execute(process.execPath, [
      join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      ...args,
    ])
  } else await execute('npm', args, { timeout: 120_000 })
}
const cli = join(installRoot, 'node_modules/@qiushui-airadar/cli/dist/cli.js')
async function start() {
  const child = spawn(
    process.execPath,
    [cli, 'service', 'run', '--port', '0'],
    {
      cwd: target,
      env: {
        ...process.env,
        QIUSHUI_AIRADAR_DATA_ROOT: dataRoot,
        QIUSHUI_AIRADAR_SECRET_FILE: join(dataRoot, '.env'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  children.add(child)
  const origin = await new Promise<string>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(
      () => reject(new Error(`Readiness timeout: ${stderr}`)),
      20_000
    )
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Service exited ${code}: ${stderr}`))
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const value = JSON.parse(line) as { host: string; port: number }
          if (value.port) {
            clearTimeout(timer)
            resolve(
              `http://${value.host === '0.0.0.0' ? '127.0.0.1' : value.host}:${value.port}`
            )
          }
        } catch {
          /* Wait for a complete line. */
        }
      }
    })
  })
  return { child, origin }
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const ended = new Promise<void>((resolve) =>
      child.once('exit', () => resolve())
    )
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    await ended
    clearTimeout(timer)
  }
  children.delete(child)
}
async function get(origin: string, pathname: string) {
  const response = await fetch(`${origin}${pathname}`)
  assert.equal(response.status, 200, pathname)
  return response
}
try {
  await mkdir(packRoot, { recursive: true })
  await cp(join(process.cwd(), 'apps/cli'), staging, {
    recursive: true,
    filter: (file) => !file.split(/[\\/]/u).includes('node_modules'),
  })
  const manifest = JSON.parse(
    await readFile(join(staging, 'package.json'), 'utf8')
  ) as { version: string; devDependencies?: unknown }
  const currentVersion = manifest.version
  // A prerelease of this build exercises npm replacement, not historical schema migration.
  manifest.version = `${currentVersion}-acceptance.1`
  delete manifest.devDependencies
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest))
  await execute(
    process.platform === 'win32' ? process.execPath : 'npm',
    [
      ...(process.platform === 'win32'
        ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
        : []),
      'pack',
      '--pack-destination',
      packRoot,
    ],
    {
      cwd: staging,
    }
  )
  const oldPackage = (await readdir(packRoot)).find((name) =>
    name.endsWith('.tgz')
  )!
  await install(join(packRoot, oldPackage))
  assert.equal(
    (await execute(process.execPath, [cli, '--version'])).stdout.trim(),
    manifest.version
  )
  let active = await start()
  assert.equal(
    (
      (await (await get(active.origin, '/health')).json()) as {
        service: string
      }
    ).service,
    'qiushui-airadar-single-table'
  )
  await get(active.origin, '/api/sources')
  await stop(active.child)

  const repository = await SingleTableRepository.open(dataRoot)
  const row = await repository.saveOriginal({
    platform: 'x',
    sourceType: 'x',
    sourceAccountId: 'release-test',
    sourceAccountName: '安装验收',
    externalContentId: 'preserved',
    title: '升级保留测试',
    body: '升级后正文保持不变。',
    kind: 'short_post',
    format: 'plain_text',
    language: 'zh',
  })
  repository.setRead(row.id, true)
  repository.setUtilizationActions(row.id, ['favorite'])
  repository.close()
  const profile = join(dataRoot, 'config/profile.yaml')
  const profileBefore = `${await readFile(profile, 'utf8')}\n# user-owned configuration must survive\n`
  await writeFile(profile, profileBefore)
  const sourcesFile = join(dataRoot, 'config/sources.yaml')
  const disabledSources = (await readFile(sourcesFile, 'utf8')).replaceAll(
    'enabled: true',
    'enabled: false'
  )
  await writeFile(sourcesFile, disabledSources)
  const secretBefore = '# local secret file must survive\n'
  await writeFile(join(dataRoot, '.env'), secretBefore, { mode: 0o600 })

  await execute(process.execPath, [
    packageManagerCli,
    '--filter',
    '@qiushui-airadar/cli',
    'pack',
    '--pack-destination',
    packRoot,
  ])
  const currentPackage = join(
    packRoot,
    `qiushui-airadar-cli-${currentVersion}.tgz`
  )
  await install(currentPackage)
  assert.equal(
    (await execute(process.execPath, [cli, '--version'])).stdout.trim(),
    currentVersion
  )
  active = await start()
  const html = await (await get(active.origin, '/')).text()
  assert.ok(html.includes('<title>qiushui-airadar</title>'))
  const asset = /src="([^"]+\.js)"/u.exec(html)?.[1]
  assert.ok(asset)
  await get(active.origin, asset)
  await get(active.origin, '/sources')
  await get(active.origin, '/api/sources')
  await get(active.origin, '/api/contents')
  assert.equal((await fetch(`${active.origin}/api/not-found`)).status, 404)
  assert.equal((await fetch(`${active.origin}/missing.js`)).status, 404)
  await stop(active.child)
  const collected = await execute(process.execPath, [cli, 'collect'], {
    cwd: target,
    env: {
      ...process.env,
      QIUSHUI_AIRADAR_DATA_ROOT: dataRoot,
      QIUSHUI_AIRADAR_SECRET_FILE: join(dataRoot, '.env'),
    },
  })
  assert.deepEqual(JSON.parse(collected.stdout), [])
  assert.equal(await readFile(sourcesFile, 'utf8'), disabledSources)
  const reopened = await SingleTableRepository.open(dataRoot)
  assert.equal(reopened.getById(row.id)?.read, 1)
  assert.ok(
    reopened.getById(row.id)?.utilization_actions_json.includes('favorite')
  )
  assert.equal(await reopened.readBody(row.id, 'zh'), '升级后正文保持不变。')
  reopened.close()
  assert.equal(await readFile(profile, 'utf8'), profileBefore)
  assert.equal(await readFile(join(dataRoot, '.env'), 'utf8'), secretBefore)
  assert.equal(
    (
      await readdir(
        join(installRoot, 'node_modules/@qiushui-airadar/cli/prompts')
      )
    ).length,
    3
  )
  process.stdout.write(
    `PASS: npm install ${manifest.version} → ${currentVersion}; standalone Web/assets/API; data/read/favorite/config/secrets preserved.\n`
  )
} finally {
  for (const child of children) await stop(child)
  await rm(target, { recursive: true, force: true })
}
