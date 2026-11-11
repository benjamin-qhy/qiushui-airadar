import { z } from 'zod'

const id = z.string().min(1)
const timestamp = z.iso.datetime()
const sensitiveParameterKey =
  /(?:apikey|accesskey(?:id)?|token|secret|password|passphrase|authorization|auth|cookie|privatekey|credentials?|bearer|signingkey)$/iu
const secretNamePattern = /^[A-Z][A-Z0-9_]*$/u
const trackingParameters = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
])

export function canonicalizeContentUrl(value: string): string {
  const url = new URL(value)
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase()
    if (
      normalizedKey.startsWith('utm_') ||
      trackingParameters.has(normalizedKey)
    ) {
      url.searchParams.delete(key)
    }
  }
  url.searchParams.sort()
  url.hostname = url.hostname.toLowerCase()
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.toString().replace(/\?$/u, '').replace(/\/$/u, '')
}

export const secretReferenceSchema = z
  .object({ secretRef: z.string().regex(secretNamePattern) })
  .strict()

function isSecretReference(value: unknown): boolean {
  return secretReferenceSchema.safeParse(value).success
}

function findSensitiveParameterPath(
  value: unknown,
  path: (string | number)[] = []
): (string | number)[] | undefined {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findSensitiveParameterPath(entry, [...path, index])
      if (found) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key]
    if (sensitiveParameterKey.test(key.replace(/[^a-z0-9]/giu, ''))) {
      if (isSecretReference(entry)) continue
      return entryPath
    }
    const found = findSensitiveParameterPath(entry, entryPath)
    if (found) return found
  }
  return undefined
}

export const sourceTypeSchema = z.enum([
  'x',
  'youtube',
  'rss',
  'douyin',
  'wechat_channels',
  'xiaohongshu',
])
export const contentKindSchema = z.enum([
  'short_post',
  'video',
  'image_post',
  'article',
])

export const sourceSchema = z
  .object({
    id,
    slug: z.string().min(1),
    name: z.string().min(1),
    type: sourceTypeSchema,
    language: z.enum(['en', 'zh']).default('en'),
    externalIdentity: z.string().min(1),
    status: z.enum(['enabled', 'disabled', 'archived']),
  })
  .strict()

export const contentSchema = z
  .object({
    id,
    kind: contentKindSchema,
    canonicalUrl: z.url(),
    title: z.string().min(1),
  })
  .strict()

export const discoverySchema = z
  .object({
    id,
    sourceId: id,
    contentId: id,
    externalId: z.string().min(1),
    discoveredAt: timestamp,
  })
  .strict()

export const taskSchema = z
  .object({
    id,
    type: z.enum(['discover', 'enrich', 'analyze', 'deliver']),
    status: z.enum(['pending', 'running', 'succeeded', 'failed']),
    attempt: z.number().int().nonnegative(),
    parameterVersionId: id,
  })
  .strict()

export const analysisRunSchema = z
  .object({
    id,
    contentId: id,
    status: z.enum(['pending', 'running', 'succeeded', 'failed']),
    promptVersion: z.string().min(1),
    profileVersionId: id,
    model: z.string().min(1),
  })
  .strict()

export const parameterVersionSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    createdAt: timestamp,
    values: z.record(z.string(), z.unknown()).superRefine((value, context) => {
      const path = findSensitiveParameterPath(value)
      if (path) {
        context.addIssue({
          code: 'custom',
          message: 'Parameter values cannot contain a secret-like key',
          path,
        })
      }
    }),
  })
  .strict()

export const providerSchema = z
  .object({
    id,
    sourceType: sourceTypeSchema,
    enabled: z.boolean(),
    priority: z.number().int().positive(),
  })
  .strict()

export type Source = z.input<typeof sourceSchema>
export type Content = z.infer<typeof contentSchema>
export type Discovery = z.infer<typeof discoverySchema>
export type Task = z.infer<typeof taskSchema>
export type AnalysisRun = z.infer<typeof analysisRunSchema>
export type ParameterVersion = z.infer<typeof parameterVersionSchema>
export type Provider = z.infer<typeof providerSchema>
export type SourceType = z.infer<typeof sourceTypeSchema>
export type ContentKind = z.infer<typeof contentKindSchema>

export * from './content-tags.js'
