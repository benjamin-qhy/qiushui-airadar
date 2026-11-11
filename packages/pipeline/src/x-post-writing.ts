// Adapted from AIHOT 41cee09 (MIT); see docs/prompts/single-table-content/AIHOT-LICENSE.
export const IDENTITY_LEXICON: ReadonlyArray<{
  id: string
  name: string
  patterns: RegExp[]
}> = [
  {
    id: 'openai',
    name: 'OpenAI',
    patterns: [/openai|chatgpt|\bgpt-?[o\d]|\bsora\b|\bcodex\b/i],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    patterns: [
      /anthropic|\bclaude\b/i,
      /\b(?:opus|sonnet|haiku)\s*\d+(?:[.-]\d+)*\b/i,
      /\bfable\s*\d+(?:[.-]\d+)*\b|\bmythos\b/i,
    ],
  },
  {
    id: 'google',
    name: 'Google / Gemini',
    patterns: [
      /google|deepmind|\bgemini\b|notebooklm|\bveo\s?\d|\bAlphaFold\b|\bAMIE\b/i,
    ],
  },
  { id: 'deepseek', name: 'DeepSeek', patterns: [/deepseek|深度求索/i] },
  { id: 'xai', name: 'xAI / Grok', patterns: [/\bxai\b|\bgrok\b/i] },
  {
    id: 'meta',
    name: 'Meta / Llama',
    patterns: [/\bMeta\b/, /\bmeta\s?ai\b|\bllama\b/i],
  },
  {
    id: 'microsoft',
    name: 'Microsoft / Copilot',
    patterns: [/microsoft|copilot|微软/i],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    patterns: [
      /nvidia|英伟达|\bnemotron\b|\bnemo\b|\bblackwell\b|\brubin(?:\s+ultra)?\b|\bcuda\b/i,
    ],
  },
  { id: 'qwen', name: '千问 Qwen', patterns: [/\bqwen|通义|千问/i] },
  { id: 'hugging-face', name: 'Hugging Face', patterns: [/hugging\s?face/i] },
  { id: 'cursor', name: 'Cursor', patterns: [/\bCursor\b/] },
  {
    id: 'kimi',
    name: '月之暗面 / Kimi',
    patterns: [/\bkimi\b|月之暗面|\bmoonshot\s?ai\b/i],
  },
  { id: 'openrouter', name: 'OpenRouter', patterns: [/openrouter/i] },
  { id: 'minimax', name: 'MiniMax', patterns: [/minimax/i] },
  { id: 'zhipu', name: '智谱 GLM', patterns: [/智谱|\bglm-?[4-9]/i] },
  { id: 'hunyuan', name: '腾讯混元', patterns: [/混元|hunyuan/i] },
  {
    id: 'doubao',
    name: '字节豆包',
    patterns: [/豆包|doubao|字节跳动|bytedance/i],
  },
  { id: 'mistral', name: 'Mistral', patterns: [/mistral/i] },
  { id: 'perplexity', name: 'Perplexity', patterns: [/\bPerplexity\b/] },
  { id: 'runway', name: 'Runway', patterns: [/\brunway\b/i] },
  { id: 'suno', name: 'Suno', patterns: [/\bsuno\b/i] },
  { id: 'midjourney', name: 'Midjourney', patterns: [/midjourney/i] },
  { id: 'stability-ai', name: 'Stability AI', patterns: [/stability\s?ai/i] },
  { id: 'elevenlabs', name: 'ElevenLabs', patterns: [/eleven\s?labs/i] },
  { id: 'vllm', name: 'vLLM', patterns: [/\bvllm\b/i] },
  { id: 'ollama', name: 'Ollama', patterns: [/\bollama\b/i] },
  { id: 'windsurf', name: 'Windsurf', patterns: [/windsurf/i] },
  { id: 'devin', name: 'Devin', patterns: [/\bdevin\b/i] },
  { id: 'manus', name: 'Manus', patterns: [/\bmanus\b/i] },
  {
    id: 'apple',
    name: 'Apple AI',
    patterns: [/\bapple\s?(intelligence|silicon|ai)\b|苹果(智能|\s?AI)/i],
  },
  {
    id: 'amazon',
    name: 'Amazon / AWS',
    patterns: [/amazon|\baws\b|\bawscloud\b|亚马逊/i],
  },
  {
    id: 'baidu',
    name: '百度文心',
    patterns: [/百度|baidu|文心|\bernie\s?bot\b/i],
  },
]

/** 这些域名上的文章，发布方就是对应的公司（托管平台如 GitHub、arXiv 不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{
  entityId: string
  domains: readonly string[]
}> = [
  { entityId: 'openai', domains: ['openai.com'] },
  { entityId: 'anthropic', domains: ['anthropic.com', 'claude.com'] },
  {
    entityId: 'google',
    domains: ['deepmind.google', 'ai.google', 'blog.google'],
  },
  { entityId: 'deepseek', domains: ['deepseek.com'] },
  { entityId: 'xai', domains: ['x.ai'] },
  { entityId: 'meta', domains: ['ai.meta.com'] },
  { entityId: 'microsoft', domains: ['microsoft.com'] },
  { entityId: 'nvidia', domains: ['nvidia.com'] },
  { entityId: 'qwen', domains: ['qwen.ai'] },
  { entityId: 'cursor', domains: ['cursor.com'] },
  { entityId: 'openrouter', domains: ['openrouter.ai'] },
]

/** 原文里的这些写法也算提到了对应公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{
  entityId: string
  pattern: RegExp
}> = [
  { entityId: 'meta', pattern: /@AIatMeta\b/i },
  { entityId: 'zhipu', pattern: /\bZhipu(?:\s+AI\b|['’]s\b)/i },
]
export function clampText(s: string, maxChars: number): string {
  const codepoints = Array.from(s)
  return codepoints.length <= maxChars
    ? s
    : codepoints.slice(0, maxChars).join('') + '…'
}

/** Short tweet: under 100 characters of Chinese, under 500 of other text. */
export function isShortTweet(text: string): boolean {
  if (!text) return false
  const cjk = (text.match(/[一-鿿]/g) || []).length
  return text.length < (cjk > text.length * 0.3 ? 100 : 500)
}

function chineseDensity(s: string): number {
  const chinese = (s.match(/[一-鿿]/g) ?? []).length
  const total = s.replace(/\s+/g, '').length
  return total === 0 ? 0 : chinese / total
}

const stripNoise = (s: string) =>
  s
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]+/g, ' ')
    .replace(/#[A-Za-z0-9_]+/g, ' ')

/** A short tweet in Chinese needs no translation; mixed or English ones do. */
export function needsShortTweetTranslation(text: string): boolean {
  const clean = stripNoise(text)
  if (!looksZh(clean)) return true
  if (chineseDensity(clean) < 0.65) return true
  const englishRuns =
    clean.match(
      /[A-Za-z][A-Za-z0-9+.#/-]*(?:\s+[A-Za-z][A-Za-z0-9+.#/-]*)+/g
    ) ?? []
  return englishRuns.some((run) => run.replace(/\s+/g, '').length >= 10)
}

const lexiconName = (id: string) =>
  IDENTITY_LEXICON.find((e) => e.id === id)?.name ?? null

/** Known companies the texts name, by the pack's identity lexicon (each text on its own). */
export function matchEntityIds(
  texts: Array<string | null | undefined>
): string[] {
  const list = texts.filter(
    (t): t is string => typeof t === 'string' && t.trim().length > 0
  )
  return IDENTITY_LEXICON.filter((e) =>
    e.patterns.some((p) => list.some((t) => p.test(t)))
  ).map((e) => e.id)
}

/** A translation may rejoin a name (GPT 5.5 → GPT-5.5): the input counts in both spellings. */
const surfaceVariants = (texts: Array<string | undefined>) => {
  const exact = texts.filter(
    (t): t is string => typeof t === 'string' && t.trim().length > 0
  )
  return [
    ...exact,
    ...exact.map((t) => t.replace(/\b(gpt|glm)\s+(?=[o\d])/gi, '$1-')),
  ]
}

function publisherEntityId(url?: string): string | null {
  let host: string
  try {
    host = new URL(url ?? '').hostname.toLowerCase()
  } catch {
    return null
  }
  return (
    PUBLISHER_DOMAINS.find((e) =>
      e.domains.some((d) => host === d || host.endsWith(`.${d}`))
    )?.entityId ?? null
  )
}

export interface TranslateInput {
  title: string
  text: string
  sourceKind: string
  sourceName?: string
  documentUrl?: string
  sourceOwnerEntityId?: string | null
  /** The main post of a tweet (not the quoted one), for the short/long decision. */
  mainText?: string
  quotedText?: string
  quotedAuthor?: string
  publishedAt?: Date
  publicationTime?: string | null
}

function identityContext(input: TranslateInput) {
  const publisher = publisherEntityId(input.documentUrl)
  const owner =
    input.sourceOwnerEntityId && lexiconName(input.sourceOwnerEntityId)
      ? input.sourceOwnerEntityId
      : null
  const texts = [
    input.title,
    input.text,
    input.mainText,
    input.quotedText,
    input.sourceName,
  ]
  const allowed = new Set(matchEntityIds(surfaceVariants(texts)))
  const joined = texts.filter(Boolean).join('\n')
  // Authors sometimes lowercase the product name. Require coding context so
  // a mouse cursor alone cannot authorize the editor to introduce the company.
  if (
    /\bcursor\b/iu.test(joined) &&
    /\b(?:claude code|coding agent|IDE|code editor|cursor cloud agents)\b|\bapps\b[^.!?\n]{0,180}\bcursor\b/iu.test(
      joined
    )
  )
    allowed.add('cursor')
  for (const alias of IDENTITY_CONTEXT_ALIASES)
    if (alias.pattern.test(joined)) allowed.add(alias.entityId)
  if (publisher) allowed.add(publisher)
  if (owner) allowed.add(owner)
  return { allowed: [...allowed].sort(), publisher, owner }
}

export interface IdentityGuard {
  outcome: 'pass' | 'fallback'
  unsupportedTitleEntityIds: string[]
  unsupportedSummaryEntityIds: string[]
}

/**
 * A model only words the copy; it cannot introduce a company the input does not name. A title that
 * does falls back to the original Chinese title (or nothing), a summary that does is dropped.
 */
export function enforceIdentity(
  input: TranslateInput,
  copy: { titleZh: string; summaryZh: string }
) {
  const allowed = new Set(identityContext(input).allowed)
  const unsupportedTitleEntityIds = matchEntityIds([copy.titleZh]).filter(
    (id) => !allowed.has(id)
  )
  const unsupportedSummaryEntityIds = matchEntityIds([copy.summaryZh]).filter(
    (id) => !allowed.has(id)
  )
  return {
    titleZh: unsupportedTitleEntityIds.length
      ? looksZh(input.title)
        ? input.title
        : ''
      : copy.titleZh,
    summaryZh: unsupportedSummaryEntityIds.length ? '' : copy.summaryZh,
    identityGuard: {
      outcome:
        unsupportedTitleEntityIds.length || unsupportedSummaryEntityIds.length
          ? 'fallback'
          : 'pass',
      unsupportedTitleEntityIds,
      unsupportedSummaryEntityIds,
    } as IdentityGuard,
  }
}

// Answer-first summary length

export function compactAnswerFirstSummary(
  summary: string,
  maxChars = 190
): string {
  const text = summary.trim().replace(/\s*\n+\s*/g, ' ')
  if (text.length <= maxChars) return text
  const sentences = text.match(/[^。！？!?]+[。！？!?]?/gu) ?? [text]
  let result = ''
  for (const sentence of sentences) {
    if ((result + sentence).length > maxChars) break
    result += sentence
    if (result.length >= 80) break
  }
  // Whole sentences, even a short one, read better than half of the next.
  if (result) return result.trim()
  // The first sentence alone is too long: cut at a clause boundary, never inside a name, number or enumeration.
  const clauses = text.match(/[^，；,;]+[，；,;]?/gu) ?? [text]
  for (const clause of clauses) {
    if ((result + clause).length + 1 > maxChars) break
    result += clause
    if (result.length >= 80) break
  }
  return result.length >= 50 ? `${result.replace(/[，；,;]$/u, '')}。` : text
}

function answerFirstSummaryLengthOk(
  summary: string,
  input: TranslateInput
): boolean {
  const trimmed = summary.trim()
  const sourceLength = input.text.trim().length
  const sentences = trimmed
    .split(/[。！？!?]+/u)
    .map((p) => p.trim())
    .filter(Boolean).length
  const rich = sourceLength >= 500
  return (
    trimmed.length <= 200 &&
    trimmed.length >= (rich ? 80 : 50) &&
    sentences <= 3 &&
    (!rich || sentences >= 2)
  )
}

export const isShortTweetInput = (input: TranslateInput) =>
  input.sourceKind === 'x_search' && isShortTweet(input.mainText || input.title)

/** The length rule (compacted without another call) and the identity guard, for any writing model. */
export function finalizeCopy(
  input: TranslateInput,
  copy: { titleZh: string; summaryZh: string }
) {
  let summaryZh = copy.summaryZh
  if (
    !isShortTweetInput(input) &&
    summaryZh &&
    !answerFirstSummaryLengthOk(summaryZh, input)
  )
    summaryZh = compactAnswerFirstSummary(summaryZh)
  return enforceIdentity(input, { titleZh: copy.titleZh, summaryZh })
}

const ECHO_LINE =
  /^(来源[:：]|【已核验身份上下文】|这些事实只用于防止|原始标题[:：]|【时间锚点】)/

/** The answer without prompt lines repeated at its end. */
export function stripEcho(text: string): string {
  const lines = text.split('\n')
  while (
    lines.length &&
    (lines[lines.length - 1]!.trim() === '' ||
      ECHO_LINE.test(lines[lines.length - 1]!.trim()))
  )
    lines.pop()
  return lines.join('\n').trim()
}

/** `title_zh:` / `summary_zh:` / `body_zh:` lines, with fallbacks for answers that drop the labels. */
export function parseTranslateOutput(text: string): {
  titleZh: string
  summaryZh: string
  bodyZh: string
} {
  let titleZh = ''
  let summaryZh = ''
  let bodyZh = ''
  let titleLine = -1
  let summaryLine = -1
  let bodyLine = -1
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i]!.trim()
    const title = t.match(/^title_zh\s*[:：]\s*(.*)$/)
    if (title) {
      titleZh = title[1]!.trim()
      titleLine = i
      continue
    }
    const summary = t.match(/^summary_zh\s*[:：]\s*(.*)$/)
    if (summary) {
      summaryZh = summary[1]!.trim()
      summaryLine = i
      continue
    }
    const body = t.match(/^body_zh\s*[:：]\s*(.*)$/)
    if (body) {
      bodyZh = body[1]!.trim()
      bodyLine = i
      continue
    }
  }
  // A title without a labelled summary or body: the lines after it are the summary.
  if (titleZh && !summaryZh && bodyLine < 0 && titleLine >= 0) {
    const rest = lines
      .slice(titleLine + 1)
      .map((l) => l.trim())
      .filter(Boolean)
    if (rest.length) summaryZh = rest.join('\n')
  }
  // A summary split over lines: join the unlabelled lines after it.
  if (summaryLine >= 0) {
    const more: string[] = []
    for (let i = summaryLine + 1; i < lines.length; i += 1) {
      const t = lines[i]!.trim()
      if (!t) continue
      if (/^(title_zh|summary_zh|body_zh)\s*[:：]/.test(t)) break
      more.push(t)
    }
    const parts = [summaryZh, ...more].filter(Boolean)
    if (parts.length) summaryZh = parts.join('\n')
  }
  // A body over lines keeps its paragraph breaks.
  if (bodyLine >= 0) {
    const more: string[] = []
    for (let i = bodyLine + 1; i < lines.length; i += 1) {
      if (/^(title_zh|summary_zh|body_zh)\s*[:：]/.test(lines[i]!.trim())) break
      more.push(lines[i]!)
    }
    while (more.length && more[more.length - 1]!.trim() === '') more.pop()
    const parts = bodyZh ? [bodyZh, ...more] : more
    if (parts.length) bodyZh = parts.join('\n')
  }
  if (!titleZh && !summaryZh && !bodyZh) {
    const rest = text.trim().split(/\r?\n/).filter(Boolean)
    if (rest.length >= 2) {
      titleZh = rest[0]!.trim()
      summaryZh = rest.slice(1).join('\n').trim()
    } else if (rest.length === 1) {
      titleZh = rest[0]!.trim()
    }
  }
  return { titleZh, summaryZh: stripEcho(summaryZh), bodyZh: stripEcho(bodyZh) }
}

function looksZh(s: string) {
  return (
    /\p{Script=Han}/u.test(s) &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s)
  )
}
// 读者看得到的文字里本站不用的词，每项是要找的写法和改法（例如 [/重磅|炸裂/u, "不用夸张的说法，直接写发生了什么"]）。
// 写作那一步写完中文标题、摘要和推荐理由后逐个查，用了就让模型只改这些地方一次（packages/backend/src/editorial/
// analyze.ts 的 mendWording）。只列一眼就能判断的写法：拿不准的不列，否则会误改正常的词。空着就不查。

export const READER_WORDING: ReadonlyArray<readonly [RegExp, string]> = []

export interface ReaderCopy {
  titleZh: string
  summaryZh: string
  reasonZh: string | null
}

const FIELDS: Array<[keyof ReaderCopy, string]> = [
  ['titleZh', '标题'],
  ['summaryZh', '摘要'],
  ['reasonZh', '推荐理由'],
]

/**
 * Every use of a word of the list in a copy, each as a line the model can act on: where, the words around it,
 * and the fix. Each use is its own line, so a copy that mends one of two has fewer.
 */
export function wordingProblems(
  copy: ReaderCopy,
  rules = READER_WORDING
): string[] {
  const problems: string[] = []
  for (const [field, name] of FIELDS) {
    const text = copy[field]
    if (!text) continue
    for (const [pattern, fix] of rules) {
      for (const hit of text.matchAll(
        new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)
      )) {
        problems.push(
          `${name}用了“${hit[0]}”（“${text.slice(Math.max(0, hit.index - 8), hit.index + hit[0].length + 8)}”）：${fix}`
        )
      }
    }
  }
  return problems
}

export async function checkPostCopy(
  input: TranslateInput,
  draft: ReaderCopy,
  revise: (issues: string[], copy: ReaderCopy) => Promise<ReaderCopy>,
  rules = READER_WORDING
): Promise<ReaderCopy> {
  const first = { ...draft, ...finalizeCopy(input, draft) }
  const issues = wordingProblems(first, rules)
  if (!first.titleZh || !first.summaryZh || !issues.length) return first
  const result = await revise(issues, first)
  const next = {
    ...finalizeCopy(input, result),
    reasonZh: first.reasonZh ? result.reasonZh || first.reasonZh : null,
  }
  const numbers = (c: ReaderCopy) =>
    (
      [c.titleZh, c.summaryZh, c.reasonZh]
        .join(' ')
        .match(/\d+(?:[.,]\d+)*/g) ?? []
    )
      .sort()
      .join(' ')
  return next.titleZh &&
    next.summaryZh &&
    numbers(next) === numbers(first) &&
    wordingProblems(next, rules).length < issues.length
    ? next
    : first
}

export function postLanguageProblems(
  copy: ReaderCopy,
  main: string,
  quote = ''
): string[] {
  const output = [copy.titleZh, copy.summaryZh, copy.reasonZh]
    .filter(Boolean)
    .join('\n')
  const source = main + '\n' + quote
  const problems: string[] = []
  for (const char of output.match(/\p{L}/gu) ?? []) {
    if (
      !/[\p{Script=Han}\p{Script=Latin}]/u.test(char) &&
      !source.includes(char)
    ) {
      problems.push('删除或翻译原帖中不存在的异语文字')
      break
    }
  }
  for (const line of copy.summaryZh.split(/\n/u)) {
    const plain = line.replace(/https?:\/\/\S+|[@#]\S+|`[^`]*`/gu, '').trim()
    if (
      !/\p{Script=Han}/u.test(plain) &&
      (plain.match(/\b[a-z]+\b/giu)?.length ?? 0) >= 5 &&
      main.includes(plain) &&
      /[.!?]/u.test(plain)
    ) {
      problems.push('普通英文整句仍是原文，请按上下文翻成中文')
      break
    }
  }
  return problems
}
