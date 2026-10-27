import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'

const execute = promisify(execFile)
const installer = join(process.cwd(), 'scripts/install-release.sh')

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))(
  'release installer shell setup',
  () => {
    it('migrates the previous installation without losing data and keeps LAN binding', async () => {
      const home = await mkdtemp(join(tmpdir(), 'airadar-rename-home-'))
      const previous = join(home, '.qiushuiai-airadar')
      const current = join(home, '.qiushui-airadar')
      const fixtures = join(home, 'fixtures')
      const mockBin = join(home, 'mock-bin')
      try {
        await mkdir(join(previous, 'production-data/config'), {
          recursive: true,
        })
        await mkdir(join(previous, 'production-data/contents'), {
          recursive: true,
        })
        await mkdir(join(previous, 'program/bin'), { recursive: true })
        await mkdir(fixtures)
        await mkdir(mockBin)
        const preserved = {
          'config/sources.yaml': 'sources: []\n',
          'config/analysis.yaml': 'provider: preserved\n',
          'contents/example.md': '# Existing content\n',
          '.env': 'TEST_KEY=private-test-value\n',
          'model-auth.json': '{"test":"preserved"}',
          'source-state.json': '{"cursor":"preserved"}',
        }
        for (const [name, value] of Object.entries(preserved))
          await writeFile(join(previous, 'production-data', name), value)
        for (const suffix of ['', '-wal', '-shm'])
          await writeFile(
            join(
              previous,
              'production-data',
              `qiushuiai-airadar.sqlite${suffix}`
            ),
            `database${suffix}`
          )
        const oldCli = join(previous, 'program/bin/qiushuiai-airadar')
        await writeFile(
          oldCli,
          '#!/bin/sh\ntouch "$HOME/old-service-stopped"\n'
        )
        await chmod(oldCli, 0o755)
        const staged = join(home, 'fixture-package')
        await mkdir(staged)
        await writeFile(
          join(staged, 'package.json'),
          JSON.stringify({
            name: '@qiushui-airadar/cli',
            version: '0.8.0',
            bin: { 'qiushui-airadar': 'cli.js' },
          })
        )
        await writeFile(
          join(staged, 'cli.js'),
          `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='--version') console.log('0.8.0');else fs.writeFileSync(process.env.HOME+'/.service-call',process.argv.slice(2).join(' '));\n`
        )
        await execute('npm', ['pack', '--pack-destination', fixtures], {
          cwd: staged,
        })
        const archive = 'qiushui-airadar-cli-0.8.0.tgz'
        const hash = createHash('sha256')
          .update(await readFile(join(fixtures, archive)))
          .digest('hex')
        await writeFile(
          join(fixtures, `${archive}.sha256`),
          `${hash}  ${archive}\n`
        )
        await writeFile(
          join(fixtures, 'qiushui-airadar-release.json'),
          JSON.stringify({
            version: '0.8.0',
            package: archive,
            checksum: `${archive}.sha256`,
          })
        )
        await writeFile(
          join(mockBin, 'curl'),
          `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const index=args.indexOf('-o');if(index>=0){const url=args.find(x=>x.startsWith('https://'));fs.copyFileSync(path.join(process.env.AIRADAR_INSTALL_FIXTURES,path.basename(url)),args[index+1]);}else console.log('{"status":"ready"}');\n`
        )
        await chmod(join(mockBin, 'curl'), 0o755)
        await writeFile(join(mockBin, 'uname'), '#!/bin/sh\necho Linux\n')
        await chmod(join(mockBin, 'uname'), 0o755)
        await execute('/bin/sh', [installer], {
          env: {
            ...process.env,
            HOME: home,
            SHELL: '/bin/zsh',
            PATH: `${mockBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
            AIRADAR_INSTALL_FIXTURES: fixtures,
          },
        })
        assert.ok(!existsSync(previous))
        assert.ok(existsSync(join(home, 'old-service-stopped')))
        assert.equal(
          await readFile(join(home, '.service-call'), 'utf8'),
          'service install --host 0.0.0.0 --port 43120'
        )
        for (const [name, value] of Object.entries(preserved))
          assert.equal(
            await readFile(join(current, 'production-data', name), 'utf8'),
            value
          )
        for (const suffix of ['', '-wal', '-shm'])
          assert.equal(
            await readFile(
              join(
                current,
                'production-data',
                `qiushui-airadar.sqlite${suffix}`
              ),
              'utf8'
            ),
            `database${suffix}`
          )
        assert.ok(existsSync(join(current, 'program/bin/qiushui-airadar')))
        await mkdir(previous)
        await assert.rejects(
          execute('/bin/sh', [installer], {
            env: {
              ...process.env,
              HOME: home,
              SHELL: '/bin/zsh',
              PATH: `${mockBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
              AIRADAR_INSTALL_FIXTURES: fixtures,
            },
          }),
          /新旧安装目录同时存在/u
        )
        assert.equal(
          await readFile(
            join(current, 'production-data/model-auth.json'),
            'utf8'
          ),
          preserved['model-auth.json']
        )
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    })

    it('makes the installed command available in a new zsh and stays idempotent', async () => {
      const home = await mkdtemp(join(tmpdir(), 'airadar-installer-home-'))
      const programBin = join(home, '.qiushui-airadar/program/bin')
      const command = join(programBin, 'qiushui-airadar')
      await mkdir(programBin, { recursive: true })
      await writeFile(command, '#!/bin/sh\necho test-command\n')
      await chmod(command, 0o755)
      await writeFile(
        join(home, '.zshrc'),
        '# customer settings\n# >>> qiushuiai-airadar installer >>>\nexport PATH="$HOME/.qiushuiai-airadar/program/bin:$PATH"\n# <<< qiushuiai-airadar installer <<<\n'
      )

      const nodeBin = dirname(process.execPath)
      const env = {
        ...process.env,
        HOME: home,
        SHELL: '/bin/zsh',
        PATH: `${nodeBin}:/usr/bin:/bin`,
      }

      try {
        await execute('/bin/sh', [installer, '--configure-path-only'], { env })
        const first = await readFile(join(home, '.zshrc'), 'utf8')
        await execute('/bin/sh', [installer, '--configure-path-only'], { env })
        const second = await readFile(join(home, '.zshrc'), 'utf8')

        assert.equal(second, first)
        assert.match(first, /^# customer settings$/mu)
        assert.match(first, /qiushui-airadar installer/u)
        assert.ok(!first.includes('qiushuiai-airadar'))
        assert.equal(
          first.match(/>>> qiushui-airadar installer >>>/gu)?.length,
          1
        )
        assert.ok(first.includes('$HOME/.qiushui-airadar/program/bin'))

        const result = await execute(
          '/bin/zsh',
          [
            '-dfc',
            'source "$HOME/.zshrc"; qiushui-airadar; node -p process.versions.node',
          ],
          { env }
        )
        assert.equal(
          result.stdout.trim(),
          `test-command\n${process.versions.node}`
        )
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    })
  }
)
