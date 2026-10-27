import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  asSecretStatusReader,
  createFileSecretReader,
  updateFileSecret,
} from './index.js'

describe('local secret boundary', () => {
  it('keeps raw values behind the backend reader and exposes only masked status', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'qiushui-airadar-secrets-')
    )
    const file = join(directory, '.env')
    await writeFile(file, 'TIKHUB_TOKEN=super-secret-value\nEMPTY=\n', {
      mode: 0o600,
    })
    await chmod(file, 0o600)

    const backend = createFileSecretReader(file)
    const safe = asSecretStatusReader(backend)

    expect(await backend.get('TIKHUB_TOKEN')).toBe('super-secret-value')
    expect(await safe.getStatus('TIKHUB_TOKEN')).toEqual({
      name: 'TIKHUB_TOKEN',
      configured: true,
      maskedValue: 'su••••••••••••••ue',
    })
    expect(JSON.stringify(await safe.getStatus('TIKHUB_TOKEN'))).not.toContain(
      'super-secret-value'
    )
    expect(await safe.getStatus('MISSING')).toEqual({
      name: 'MISSING',
      configured: false,
    })
  })

  it.runIf(process.platform !== 'win32')(
    'rejects secret files readable by other users on macOS',
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'qiushui-airadar-secrets-')
      )
      const file = join(directory, '.env')
      await writeFile(file, 'TOKEN=value\n', { mode: 0o644 })

      await expect(createFileSecretReader(file).get('TOKEN')).rejects.toThrow(
        'permissions'
      )
    }
  )

  it('updates one credential without exposing or replacing the others', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'qiushui-airadar-secrets-')
    )
    const file = join(directory, '.env')
    await writeFile(file, '# local\nFIRST=keep\nTOKEN=old\n', { mode: 0o600 })
    await updateFileSecret(file, 'TOKEN', 'new value')
    expect(await createFileSecretReader(file).get('FIRST')).toBe('keep')
    expect(await createFileSecretReader(file).get('TOKEN')).toBe('new value')
    expect(await readFile(file, 'utf8')).toContain('# local')
    if (process.platform !== 'win32')
      expect((await stat(file)).mode & 0o077).toBe(0)
    await updateFileSecret(file, 'TOKEN', undefined)
    expect(await createFileSecretReader(file).get('TOKEN')).toBeUndefined()
  })
})
