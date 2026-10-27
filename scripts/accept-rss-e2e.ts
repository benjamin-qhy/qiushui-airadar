import path from 'node:path'
import { homedir } from 'node:os'

import { RuntimeRepository } from '../packages/runtime/src/index.js'
import {
  createCodexPiGateway,
  rssAcceptanceModel,
  runRssPipeline,
} from '../packages/pipeline/src/index.js'

const dataRoot = process.env.QIUSHUI_AIRADAR_ACCEPTANCE_ROOT
if (!dataRoot) {
  throw new Error(
    'QIUSHUI_AIRADAR_ACCEPTANCE_ROOT must name an isolated test directory'
  )
}

const repository = await RuntimeRepository.open(dataRoot)
try {
  const gateway = createCodexPiGateway(
    path.join(
      process.env.CODEX_HOME ?? path.join(homedir(), '.codex'),
      'auth.json'
    ),
    rssAcceptanceModel
  )
  const result = await runRssPipeline({
    repository,
    source: {
      id: 'simon-willison-rss',
      feedUrl: 'https://simonwillison.net/atom/everything/',
    },
    modelGateway: gateway,
    profile:
      '关注人工智能产品、智能体、开发工具与企业落地。偏好可信、具体、有新信息并且可以转化为实际行动的内容。',
    profileVersionId: 'acceptance-profile-v1',
    ruleVersion: 'rss-rules-v1',
    modelRouteVersion: `pi-${rssAcceptanceModel}-v1`,
    limit: 1,
  })
  const manualResult =
    process.env.QIUSHUI_AIRADAR_ACCEPTANCE_REANALYZE === '1' &&
    result.analyses[0]
      ? await runRssPipeline({
          repository,
          source: {
            id: 'simon-willison-rss',
            feedUrl: 'https://simonwillison.net/atom/everything/',
          },
          modelGateway: gateway,
          profile:
            '关注人工智能产品、智能体、开发工具与企业落地。偏好可信、具体、有新信息并且可以转化为实际行动的内容。',
          profileVersionId: 'acceptance-profile-v1',
          ruleVersion: 'rss-rules-v1',
          modelRouteVersion: `pi-${rssAcceptanceModel}-v1`,
          limit: 1,
          manualReanalysisContentId: result.analyses[0].contentId,
        })
      : undefined
  const analyses = [...result.analyses, ...(manualResult?.analyses ?? [])]
  process.stdout.write(
    `${JSON.stringify(
      {
        dataRoot,
        model: rssAcceptanceModel,
        discovered: result.discovered,
        succeeded: result.succeeded,
        failed: result.failed,
        analyses: analyses.map((analysis) => ({
          id: analysis.id,
          contentId: analysis.contentId,
          version: analysis.version,
          provider: analysis.provider,
          model: analysis.model,
          durationMs: analysis.durationMs,
          usage: analysis.usage,
          recommendation: analysis.result.recommendation,
          totalScore: analysis.result.totalScore,
        })),
      },
      null,
      2
    )}\n`
  )
} finally {
  await repository.close()
}
