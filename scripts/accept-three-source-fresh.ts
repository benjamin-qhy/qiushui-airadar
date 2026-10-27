import { homedir } from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'

import type { Source } from '../packages/domain/src/index.js'
import {
  enrichArticle,
  enrichYouTubeContent,
  runPlatformDiscovery,
  runRssDiscovery,
} from '../packages/pipeline/src/index.js'
import { RuntimeRepository } from '../packages/runtime/src/index.js'
import {
  createTikHubYouTubeTranscriptProvider,
  createTwitterApiIoProvider,
  createYouTubeDataApiProvider,
  fetchTwitterApiIoArticle,
} from '../packages/source-adapters/src/index.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const testRoot = path.join(
  homedir(),
  '.qiushui-airadar',
  'test-runs',
  'three-source-10'
)
if (path.basename(testRoot) !== 'three-source-10')
  throw new Error('Unsafe test root')
await rm(testRoot, { recursive: true, force: true })

const sources: Source[] = [
  {
    id: 'fresh-x-openai',
    slug: 'fresh-x-openai',
    name: 'X / OpenAI',
    type: 'x',
    language: 'en',
    externalIdentity: 'OpenAI',
    status: 'enabled',
  },
  {
    id: 'fresh-youtube-openai',
    slug: 'fresh-youtube-openai',
    name: 'YouTube / OpenAI',
    type: 'youtube',
    language: 'en',
    externalIdentity: 'https://www.youtube.com/@OpenAI',
    status: 'enabled',
  },
  {
    id: 'fresh-rss-simon',
    slug: 'fresh-rss-simon',
    name: 'RSS / Simon Willison',
    type: 'rss',
    language: 'en',
    externalIdentity: 'https://simonwillison.net/atom/everything/',
    status: 'enabled',
  },
]
const repository = await RuntimeRepository.open(testRoot)
try {
  await repository.importSources(sources)
  const x = createTwitterApiIoProvider({
    apiKey: required('TWITTERAPI_IO_KEY'),
  })
  const youtube = createYouTubeDataApiProvider({
    apiKey: required('YOUTUBE_API_KEY'),
  })
  const xResult = await runPlatformDiscovery({
    repository,
    runner: x,
    source: sources[0]!,
    limit: 10,
  })
  const youtubeResult = await runPlatformDiscovery({
    repository,
    runner: youtube,
    source: sources[1]!,
    limit: 10,
  })
  const rssResult = await runRssDiscovery({
    repository,
    source: { id: sources[2]!.id, feedUrl: sources[2]!.externalIdentity },
    limit: 10,
    initialLookbackDays: 60,
  })
  if (
    xResult.items.length !== 10 ||
    youtubeResult.items.length !== 10 ||
    rssResult.discovered !== 10
  ) {
    throw new Error(
      `Expected 10 each; got X=${xResult.items.length}, YouTube=${youtubeResult.items.length}, RSS=${rssResult.discovered}`
    )
  }

  const captions = createTikHubYouTubeTranscriptProvider({
    token: required('TIKHUB_API_KEY'),
  })
  let youtubeCaptions = 0
  for (const item of youtubeResult.items) {
    try {
      const result = await enrichYouTubeContent({
        repository,
        contentId: item.platformIdentity!,
        transcriptProvider: captions,
      })
      if (result.status === 'succeeded') youtubeCaptions += 1
    } catch {
      /* A single unavailable caption must not hide the other nine results. */
    }
  }

  let rssArticles = 0
  let rssImages = 0
  for (const id of rssResult.contentIds) {
    const content = repository.getContent(id)
    if (!content?.canonicalUrl) continue
    try {
      const article = await enrichArticle(content.canonicalUrl)
      await repository.mergeContentIdentity(id, id, article)
      rssArticles += 1
      rssImages += article.images.length
    } catch {
      /* Report incomplete articles in the final counts. */
    }
  }

  let xArticles = 0
  for (const item of xResult.items) {
    if (item.content.kind !== 'article' || !item.platformIdentity) continue
    try {
      const article = await fetchTwitterApiIoArticle({
        apiKey: required('TWITTERAPI_IO_KEY'),
        tweetId: item.externalId,
        canonicalUrl: item.content.canonicalUrl,
      })
      await repository.completeContentEnrichment(item.platformIdentity, article)
      xArticles += 1
    } catch {
      /* The provider may not expose every long-form post. */
    }
  }

  const contents = repository.listContents()
  const report = {
    testRoot,
    x: {
      discovered: xResult.items.length,
      withImages: xResult.items.filter((item) => item.images?.length).length,
      withQuotes: xResult.items.filter((item) => item.quotedPost).length,
      enrichedArticles: xArticles,
    },
    youtube: {
      discovered: youtubeResult.items.length,
      captions: youtubeCaptions,
    },
    rss: {
      discovered: rssResult.discovered,
      enrichedArticles: rssArticles,
      images: rssImages,
    },
    totalContents: contents.length,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await repository.close()
}
