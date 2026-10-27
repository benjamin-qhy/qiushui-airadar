import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const run = promisify(execFile)
const dataRoot = process.env.AIRADAR_DATA_ROOT
const whisperModel = process.env.AIRADAR_WHISPER_MODEL
const date = process.argv[2]
const limit = Number(process.env.AIRADAR_RECOVERY_LIMIT ?? 100)
const youtubeOnly = process.env.AIRADAR_RECOVERY_YOUTUBE_ONLY === '1'
if (!dataRoot || !whisperModel || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  throw new Error(
    'Set AIRADAR_DATA_ROOT and AIRADAR_WHISPER_MODEL, then pass YYYY-MM-DD.'
  )
}

const from = new Date(`${date}T00:00:00+08:00`).toISOString()
const until = new Date(
  new Date(`${date}T00:00:00+08:00`).getTime() + 86_400_000
).toISOString()
const database = new DatabaseSync(
  path.join(dataRoot, 'qiushui-airadar.sqlite'),
  {
    readOnly: true,
  }
)
const rows = database
  .prepare(
    `SELECT id, canonical_url AS url, external_content_id AS externalId FROM contents
     WHERE process_status='waiting-manual-transcription'
       AND source_platform='x' AND content_kind='video'
       AND first_inflow_at>=? AND first_inflow_at<?
       ${youtubeOnly ? "AND canonical_url LIKE '%youtube.com%'" : ''}
     ORDER BY first_inflow_at LIMIT ?`
  )
  .all(from, until, limit)
database.close()

let next = 0
let completed = 0
let failed = 0
async function worker() {
  while (next < rows.length) {
    const row = rows[next++]
    const temporary = await mkdtemp(path.join(tmpdir(), 'airadar-x-video-'))
    try {
      const url =
        row.url ??
        (row.externalId ? `https://x.com/i/status/${row.externalId}` : '')
      if (
        !/^https:\/\/(?:x\.com|www\.youtube\.com|youtube\.com|youtu\.be)\//.test(
          url
        )
      )
        throw new Error('Missing video URL')
      await run(
        'yt-dlp',
        [
          '--no-update',
          '--no-playlist',
          '--quiet',
          '--no-warnings',
          '-x',
          '--audio-format',
          'mp3',
          '-o',
          path.join(temporary, 'audio.%(ext)s'),
          url,
        ],
        { timeout: 600_000, maxBuffer: 1_000_000 }
      )
      await run(
        'whisper-cli',
        [
          '-m',
          whisperModel,
          '-f',
          path.join(temporary, 'audio.mp3'),
          '-l',
          'en',
          '-nt',
          '-otxt',
          '-of',
          path.join(temporary, 'transcript'),
        ],
        { timeout: 600_000, maxBuffer: 2_000_000 }
      )
      const transcript = (
        await readFile(path.join(temporary, 'transcript.txt'), 'utf8')
      ).trim()
      if (transcript.split(/\s+/u).length < 3)
        throw new Error('Transcript has fewer than 3 words')
      const response = await fetch(
        `http://127.0.0.1:43120/api/contents/${row.id}/retry`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transcript }),
          signal: AbortSignal.timeout(180_000),
        }
      )
      if (!response.ok) {
        const result = await response.json()
        throw new Error(`${response.status} ${result.error ?? 'retry_failed'}`)
      }
      completed++
      process.stdout.write(
        `completed ${row.id} (${completed}/${rows.length})\n`
      )
    } catch (error) {
      failed++
      process.stderr.write(
        `failed ${row.id}: ${error instanceof Error ? error.message : String(error)}\n`
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}

await Promise.all(Array.from({ length: Math.min(2, rows.length) }, worker))
await writeFile(
  path.join(dataRoot, `video-recovery-${date}.json`),
  JSON.stringify({ date, total: rows.length, completed, failed })
)
process.stdout.write(
  `video recovery ${date}: ${completed} completed, ${failed} failed\n`
)
if (failed) process.exitCode = 1
