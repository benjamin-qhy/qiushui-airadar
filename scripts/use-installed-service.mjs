import { homedir, platform } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const address = 'http://127.0.0.1:43120/'
try {
  const response = await fetch(new URL('health', address), {
    signal: AbortSignal.timeout(2000),
  })
  if (response.ok) {
    process.stdout.write(`统一使用正式系统：${address}\n`)
    process.exit(0)
  }
} catch {
  // Start the installed service below when it is not already ready.
}

const binary = path.join(
  homedir(),
  '.qiushuiai-airadar',
  'program',
  'bin',
  platform() === 'win32' ? 'qiushuiai-airadar.cmd' : 'qiushuiai-airadar'
)
const result = spawnSync(binary, ['service', 'start'], { stdio: 'inherit' })
if (result.error) {
  process.stderr.write(`正式服务启动失败：${result.error.message}\n`)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
  if (result.status === 0)
    process.stdout.write(`统一使用正式系统：${address}\n`)
}
