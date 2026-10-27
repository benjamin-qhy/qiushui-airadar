import { execFileSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(
  await readFile(path.join(root, 'apps/cli/package.json'), 'utf8')
)
const version = manifest.version
const tag = `v${version}`
const archive = path.join(
  root,
  'release',
  `qiushui-airadar-cli-${version}.tgz`
)
const checksum = `${archive}.sha256`
const releaseManifest = path.join(
  root,
  'release',
  'qiushui-airadar-release.json'
)
for (const file of [archive, checksum, releaseManifest]) await access(file)

const status = execFileSync('git', ['status', '--porcelain'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
if (status)
  throw new Error(
    'Commit all source and documentation changes before publishing'
  )
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
const remote = execFileSync('git', ['rev-parse', 'origin/main'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
if (head !== remote)
  throw new Error('HEAD must match origin/main before publishing')

execFileSync(
  'gh',
  [
    'release',
    'create',
    tag,
    archive,
    checksum,
    releaseManifest,
    path.join(root, 'scripts', 'install-release.sh'),
    '--target',
    head,
    '--title',
    `qiushui-airadar ${version}`,
    '--generate-notes',
  ],
  { cwd: root, stdio: 'inherit' }
)
