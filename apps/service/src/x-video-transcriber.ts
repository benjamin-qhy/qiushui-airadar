import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export function xVideoTranscriptionModel(dataRoot: string): string {
  return (
    process.env.AIRADAR_WHISPER_MODEL ??
    path.join(path.dirname(dataRoot), 'models', 'ggml-small.en.bin')
  )
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}`,
  }
}

export async function checkXVideoTranscription(
  dataRoot: string
): Promise<void> {
  await access(xVideoTranscriptionModel(dataRoot))
  await Promise.all(
    ['yt-dlp', 'ffmpeg', 'whisper-cli'].map((command) =>
      run(command, ['--version'], {
        env: commandEnv(),
        timeout: 10_000,
        maxBuffer: 200_000,
      })
    )
  )
}

export async function transcribeXVideo(
  dataRoot: string,
  url: string
): Promise<string> {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'https:' ||
    !['x.com', 'www.youtube.com', 'youtube.com', 'youtu.be'].includes(
      parsed.hostname
    )
  )
    throw new Error('Video transcription requires an X or YouTube URL')
  const temporary = await mkdtemp(path.join(tmpdir(), 'airadar-x-video-'))
  try {
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
      { env: commandEnv(), timeout: 600_000, maxBuffer: 1_000_000 }
    )
    await run(
      'whisper-cli',
      [
        '-m',
        xVideoTranscriptionModel(dataRoot),
        '-f',
        path.join(temporary, 'audio.mp3'),
        '-l',
        'en',
        '-nt',
        '-otxt',
        '-of',
        path.join(temporary, 'transcript'),
      ],
      { env: commandEnv(), timeout: 600_000, maxBuffer: 2_000_000 }
    )
    const transcript = (
      await readFile(path.join(temporary, 'transcript.txt'), 'utf8')
    ).trim()
    if (transcript.split(/\s+/u).length < 3)
      throw new Error('X video transcription found too little speech')
    return transcript
  } catch (error) {
    throw new Error(
      `X video transcription failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
