import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export * from './single-table-config.js'

export interface SecretReader {
  get(name: string): Promise<string | undefined>
}

export interface SecretStatus {
  name: string
  configured: boolean
  maskedValue?: string
}

export interface SecretStatusReader {
  getStatus(name: string): Promise<SecretStatus>
}

const secretNamePattern = /^[A-Z][A-Z0-9_]*$/

function parseSecretFile(contents: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const name = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    let value = rawValue.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2')
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      try {
        value = JSON.parse(rawValue) as string
      } catch {
        // Keep hand-written .env values with unescaped backslashes readable.
      }
    }
    entries.set(name, value)
  }
  return entries
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '•'.repeat(value.length)
  return `${value.slice(0, 2)}${'•'.repeat(value.length - 4)}${value.slice(-2)}`
}

export function createFileSecretReader(filePath: string): SecretReader {
  return {
    async get(name) {
      if (!secretNamePattern.test(name))
        throw new Error(`Invalid secret name: ${name}`)
      const metadata = await stat(filePath)
      if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
        throw new Error(`Secret file permissions must be 600: ${filePath}`)
      }
      const value = parseSecretFile(await readFile(filePath, 'utf8')).get(name)
      return value || undefined
    },
  }
}

export async function updateFileSecret(
  filePath: string,
  name: string,
  value: string | undefined
): Promise<void> {
  if (!secretNamePattern.test(name))
    throw new Error(`Invalid secret name: ${name}`)
  if (value?.includes('\n') || value?.includes('\r'))
    throw new Error('Secret value must be one line')
  let contents = ''
  try {
    contents = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const replacement = value ? `${name}=${JSON.stringify(value)}\n` : ''
  const pattern = new RegExp(`^${name}=.*(?:\\r?\\n|$)`, 'mu')
  const updated = pattern.test(contents)
    ? contents.replace(pattern, () => replacement)
    : `${contents}${contents && !contents.endsWith('\n') ? '\n' : ''}${replacement}`
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 })
  await rename(temporary, filePath)
}

export function asSecretStatusReader(reader: SecretReader): SecretStatusReader {
  return {
    async getStatus(name) {
      const value = await reader.get(name)
      if (!value) return { name, configured: false }
      return { name, configured: true, maskedValue: maskSecret(value) }
    },
  }
}
