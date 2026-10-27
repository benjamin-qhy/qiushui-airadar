import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const dataRoot = process.env.QIUSHUI_AIRADAR_ACCEPT_ROOT
const secretFile = process.env.QIUSHUI_AIRADAR_SECRET_FILE
const baseUrl = process.env.QIUSHUI_AIRADAR_ACCEPTANCE_URL
const logRoot = process.env.QIUSHUI_AIRADAR_LOG_ROOT
if (!dataRoot || !secretFile || !baseUrl || !logRoot) {
  throw new Error(
    'QIUSHUI_AIRADAR_ACCEPT_ROOT, QIUSHUI_AIRADAR_SECRET_FILE, QIUSHUI_AIRADAR_LOG_ROOT, and QIUSHUI_AIRADAR_ACCEPTANCE_URL are required'
  )
}

const secretEntries = (await readFile(secretFile, 'utf8'))
  .split(/\r?\n/u)
  .map((line) => {
    const separator = line.indexOf('=')
    return separator > 0
      ? [line.slice(0, separator), line.slice(separator + 1)]
      : undefined
  })
  .filter((entry): entry is [string, string] =>
    Boolean(entry && entry[1].length >= 6)
  )

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(filePath)
      else result.push(filePath)
    }
  }
  await visit(root)
  return result
}

const dataFiles = await filesUnder(dataRoot)
const repositoryMarkdown = (await filesUnder(process.cwd())).filter(
  (file) => path.extname(file).toLowerCase() === '.md'
)
let logFiles: string[] = []
try {
  logFiles = await filesUnder(logRoot)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

const files = [...new Set([...dataFiles, ...repositoryMarkdown, ...logFiles])]
for (const file of files) {
  const content = await readFile(file)
  for (const [name, value] of secretEntries) {
    if (content.includes(Buffer.from(value))) {
      throw new Error(`Secret ${name} was found in ${file}`)
    }
  }
}

const apiPaths = [
  '/api/contents',
  '/api/daily',
  '/api/sources',
  '/api/providers',
  '/api/runtime',
  '/api/config?level=global',
]
for (const apiPath of apiPaths) {
  const response = await fetch(`${baseUrl}${apiPath}`)
  if (!response.ok)
    throw new Error(`${apiPath} returned HTTP ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  for (const [name, value] of secretEntries) {
    if (body.includes(Buffer.from(value))) {
      throw new Error(`Secret ${name} was exposed by ${apiPath}`)
    }
  }
}

process.stdout.write(
  `${JSON.stringify({
    secretsChecked: secretEntries.length,
    filesChecked: files.length,
    apiResponsesChecked: apiPaths.length,
    markdownChecked: repositoryMarkdown.length,
    sqliteChecked: dataFiles.filter((file) => file.endsWith('.sqlite')).length,
    logsChecked: logFiles.length,
    result: 'passed',
  })}\n`
)
