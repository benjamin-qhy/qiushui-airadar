/**
 * One-video TikHub acceptance probe. Requests one paid detail endpoint call.
 *
 * NODE_USE_ENV_PROXY=1 pnpm exec tsx scripts/test-tikhub-wechat-video.ts <object_id|share_url> [--audio] [--transcribe]
 * If huggingface.co is unreachable, set HF_ENDPOINT to a trusted mirror.
 * Credentials are read from QIUSHUIAI_AIRADAR_SECRET_FILE or the installed
 * production .env. Results and optional media stay outside the repository.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { createFileSecretReader } from '../packages/config/src/index.js'

const execFileAsync = promisify(execFile)
const [identity, ...flags] = process.argv.slice(2)
const allowedFlags = new Set(['--audio', '--transcribe'])
if (
  !identity ||
  flags.some((flag) => !allowedFlags.has(flag)) ||
  !(
    /^[0-9]{15,25}$/u.test(identity) ||
    /^https:\/\/weixin\.qq\.com\/sph\/[A-Za-z0-9_-]+$/u.test(identity)
  )
) {
  throw new Error(
    'Usage: test-tikhub-wechat-video.ts <object_id|https://weixin.qq.com/sph/...> [--audio] [--transcribe]'
  )
}

const secretFile =
  process.env.QIUSHUIAI_AIRADAR_SECRET_FILE ??
  path.join(homedir(), '.qiushuiai-airadar', 'production-data', '.env')
const token = await createFileSecretReader(secretFile).get('TIKHUB_API_KEY')
if (!token) throw new Error(`TIKHUB_API_KEY is missing from ${secretFile}`)

const response = await fetch(
  'https://api.tikhub.io/api/v1/wechat_channels/v2/fetch_video_detail',
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...(identity.startsWith('https://')
        ? { share_url: identity }
        : { object_id: identity }),
      raw: false,
    }),
    signal: AbortSignal.timeout(45_000),
  }
)
const responseText = await response.text()
if (!response.ok) throw new Error(`TikHub HTTP ${response.status}`)
const payload = JSON.parse(responseText) as Record<string, unknown>
if (payload.code !== 200) {
  throw new Error(`TikHub response code ${String(payload.code)}`)
}
const data = asRecord(payload.data)
const media = asRecord(data.media)
// TikHub sometimes returns a 64-bit JSON number. Extract its original digits
// before JSON.parse can round it through JavaScript Number.
const rawId = responseText.match(
  /"data"\s*:\s*\{\s*"id"\s*:\s*(?:"(\d{15,25})"|(\d{15,25}))/u
)
const videoId = rawId?.[1] ?? rawId?.[2]
if (!videoId) throw new Error('TikHub video ID was not found in the response')
const outputDir = path.join(
  homedir(),
  '.qiushuiai-airadar',
  'test-output',
  videoId
)
await mkdir(outputDir, { recursive: true, mode: 0o700 })

const summary = {
  id: videoId,
  title: optionalString(data.title) ?? optionalString(data.short_title),
  description: optionalString(data.description),
  publishedAt: data.create_time ?? null,
  durationSeconds: media.duration ?? null,
  interactions: {
    views: data.read_count ?? null,
    likes: data.like_count ?? null,
    comments: data.comment_count ?? null,
    shares: data.forward_count ?? null,
    saves: data.fav_count ?? null,
  },
  mediaAvailable: Boolean(media.full_url && media.decode_key),
  originalCaptionsAvailable: false,
  note: 'TikHub detail has no spoken-word captions or separate audio field. Description is not a transcript.',
} as const
await writeFile(
  path.join(outputDir, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  { mode: 0o600 }
)
process.stdout.write(`${JSON.stringify({ ...summary, outputDir }, null, 2)}\n`)

if (flags.includes('--audio') || flags.includes('--transcribe')) {
  const mediaUrl = optionalString(media.full_url)
  const decodeKey = optionalString(media.decode_key)
  if (!mediaUrl || !decodeKey) {
    throw new Error('TikHub did not return both a media URL and decode key')
  }
  const videoPath = path.join(outputDir, 'video.mp4')
  const audioPath = path.join(outputDir, 'audio.m4a')
  // The URL and decode key must come from this same API response.
  try {
    await execFileAsync(
      'uvx',
      [
        '--from',
        'wxipad-video',
        'wxipad-decrypt',
        mediaUrl,
        decodeKey,
        '--output',
        videoPath,
      ],
      { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }
    )
  } catch {
    // execFile errors can include argv, which contains the signed media URL
    // and per-request decode key. Do not surface that error to the terminal.
    throw new Error('Video download or decryption failed')
  }
  await execFileAsync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      audioPath,
    ],
    { timeout: 120_000 }
  )
  process.stdout.write(`Audio extracted: ${audioPath}\n`)

  if (flags.includes('--transcribe')) {
    try {
      await execFileAsync(
        'uvx',
        [
          '--from',
          'mlx-whisper',
          '--with',
          'socksio',
          'mlx_whisper',
          audioPath,
          '--model',
          'mlx-community/whisper-tiny',
          '--output-name',
          'transcript',
          '--output-dir',
          outputDir,
          '--output-format',
          'all',
          '--language',
          'zh',
          '--verbose',
          'False',
        ],
        { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 }
      )
    } catch {
      throw new Error(
        'Speech transcription failed. Check model download access.'
      )
    }
    const transcriptPath = path.join(outputDir, 'transcript.txt')
    let transcript: string
    try {
      transcript = await readFile(transcriptPath, 'utf8')
    } catch {
      throw new Error(
        'Speech transcription produced no text file. Check model download access.'
      )
    }
    process.stdout.write(
      `Speech transcript: ${transcriptPath} (${transcript.trim().length} characters); subtitles: ${path.join(outputDir, 'transcript.srt')}\n`
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
