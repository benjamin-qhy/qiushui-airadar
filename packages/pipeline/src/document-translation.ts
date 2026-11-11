import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface ModelCapacity {
  contextWindow: number
  maxOutputTokens: number
  provider: string
  model: string
}

export type TranslationSkipReason =
  'video_duration_limit' | 'video_duration_unknown' | 'source_character_limit'

export interface TranslationDocument {
  contentId: string
  title?: string
  body: string
  format: 'plain_text' | 'markdown_article' | 'subtitle'
  kind: 'short_post' | 'video' | 'image_post' | 'article'
  videoDurationSeconds?: number
}

export interface AutomaticTranslationLimits {
  maximumVideoDurationSeconds: number
  maximumSourceCharacters: number
}

export function sourceCharacterCount(body: string): number {
  return Array.from(body).length
}

export function automaticTranslationSkipReason(
  document: TranslationDocument,
  limits: AutomaticTranslationLimits
): TranslationSkipReason | undefined {
  if (document.kind !== 'video') return undefined
  if (document.videoDurationSeconds == null) return 'video_duration_unknown'
  if (document.videoDurationSeconds >= limits.maximumVideoDurationSeconds)
    return 'video_duration_limit'
  if (sourceCharacterCount(document.body) >= limits.maximumSourceCharacters)
    return 'source_character_limit'
  return undefined
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function assertTranslationCompleteness(
  source: string,
  translation: string,
  index: number
): void {
  const minimumCharacters = Math.max(
    1,
    Math.ceil(sourceCharacterCount(source) * 0.12)
  )
  if (sourceCharacterCount(translation.trim()) < minimumCharacters)
    throw new Error(
      `Translation chunk ${index + 1} is suspiciously short and may be incomplete`
    )
}

function safeSourceBytes(capacity: ModelCapacity): number {
  const safeContext = Math.floor(capacity.contextWindow * 0.8)
  const fixedPromptBudget = 4_096
  const shared = Math.floor((safeContext - fixedPromptBudget) / 2)
  const outputBound = Math.max(1_024, capacity.maxOutputTokens - 2_048)
  // Bound each streamed request so long documents can checkpoint regularly.
  const result = Math.min(shared, outputBound, 12_000)
  if (result < 1_024) throw new Error('Translation model capacity is too small')
  return result
}

function hardSplit(value: string, maximumBytes: number): string[] {
  const result: string[] = []
  let start = 0
  let offset = 0
  let bytes = 0
  for (const character of value) {
    const size = utf8Bytes(character)
    if (bytes && bytes + size > maximumBytes) {
      result.push(value.slice(start, offset))
      start = offset
      bytes = 0
    }
    bytes += size
    offset += character.length
  }
  if (offset > start) result.push(value.slice(start, offset))
  return result
}

function splitOversizedBlock(block: string, maximumBytes: number): string[] {
  if (utf8Bytes(block) <= maximumBytes) return [block]
  if (/^```[\s\S]*```$/u.test(block.trim()))
    throw new Error('A Markdown code fence exceeds model capacity')
  const sentences = block.split(/(?<=[.!?。！？])\s+/u)
  if (sentences.length === 1) return hardSplit(block, maximumBytes)
  const result: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (utf8Bytes(sentence) > maximumBytes) {
      if (current) result.push(current)
      result.push(...hardSplit(sentence, maximumBytes))
      current = ''
    } else if (!current || utf8Bytes(`${current} ${sentence}`) <= maximumBytes)
      current = current ? `${current} ${sentence}` : sentence
    else {
      result.push(current)
      current = sentence
    }
  }
  if (current) result.push(current)
  return result
}

export function splitTranslationDocument(
  body: string,
  capacity: ModelCapacity
): string[] {
  const maximumBytes = safeSourceBytes(capacity)
  const blocks = body
    .trim()
    .split(/\n{2,}/u)
    .flatMap((block) => splitOversizedBlock(block, maximumBytes))
  const chunks: string[] = []
  let current = ''
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (current && utf8Bytes(candidate) > maximumBytes) {
      chunks.push(current)
      current = block
    } else current = candidate
  }
  if (current) chunks.push(current)
  if (!chunks.length) throw new Error('Translation source is empty')
  return chunks
}

interface CheckpointManifest {
  sourceHash: string
  promptVersion: string
  provider: string
  model: string
  chunkCount: number
}

async function atomicWrite(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, value, { flag: 'wx' })
  await rename(temporary, file)
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function translateDocument(input: {
  document: TranslationDocument
  capacity: ModelCapacity
  checkpointRoot: string
  promptVersion: string
  translateChunk: (
    body: string,
    index: number,
    count: number,
    previousTranslationTail: string
  ) => Promise<{ chineseTitle: string | null; chineseBody: string }>
  onPlan?: (total: number) => Promise<void> | void
  onProgress?: (completed: number, total: number) => Promise<void> | void
}): Promise<{
  chineseTitle: string | null
  chineseBody: string
  chunkCount: number
}> {
  const chunks = splitTranslationDocument(input.document.body, input.capacity)
  await input.onPlan?.(chunks.length)
  const sourceHash = createHash('sha256')
    .update(input.document.body)
    .digest('hex')
  const directory = path.join(
    input.checkpointRoot,
    createHash('sha256').update(input.document.contentId).digest('hex')
  )
  const manifest: CheckpointManifest = {
    sourceHash,
    promptVersion: input.promptVersion,
    provider: input.capacity.provider,
    model: input.capacity.model,
    chunkCount: chunks.length,
  }
  const previousManifest = await readJson<CheckpointManifest>(
    path.join(directory, 'manifest.json')
  )
  if (
    previousManifest &&
    JSON.stringify(previousManifest) !== JSON.stringify(manifest)
  )
    await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  await atomicWrite(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  ).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })

  const translations: Array<{
    chineseTitle: string | null
    chineseBody: string
  }> = []
  for (let index = 0; index < chunks.length; index++) {
    const checkpoint = path.join(
      directory,
      `chunk-${String(index + 1).padStart(4, '0')}.json`
    )
    let translated = await readJson<{
      chineseTitle: string | null
      chineseBody: string
    }>(checkpoint)
    if (!translated) {
      const tail = translations.at(-1)?.chineseBody.slice(-500) ?? ''
      translated = await input.translateChunk(
        chunks[index]!,
        index,
        chunks.length,
        tail
      )
      if (!translated.chineseBody.trim())
        throw new Error(`Translation chunk ${index + 1} is empty`)
      assertTranslationCompleteness(
        chunks[index]!,
        translated.chineseBody,
        index
      )
      await atomicWrite(checkpoint, `${JSON.stringify(translated, null, 2)}\n`)
    }
    translations.push(translated)
    await input.onProgress?.(index + 1, chunks.length)
  }
  const result = {
    chineseTitle: translations[0]?.chineseTitle ?? null,
    chineseBody: translations
      .map((item) => item.chineseBody.trim())
      .join('\n\n'),
    chunkCount: chunks.length,
  }
  await rm(directory, { recursive: true, force: true })
  return result
}
