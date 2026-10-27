import { RuntimeRepository } from '../packages/runtime/src/index.js'

const dataRoot = process.env.QIUSHUI_AIRADAR_ACCEPT_ROOT
if (!dataRoot) throw new Error('QIUSHUI_AIRADAR_ACCEPT_ROOT is required')

function counts<T>(
  values: T[],
  key: (value: T) => string
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(Object.groupBy(values, key)).map(([name, group]) => [
      name,
      group?.length ?? 0,
    ])
  )
}

const repository = await RuntimeRepository.open(dataRoot)
try {
  const contents = repository.listContents()
  const analyses = repository.listAnalyses()
  const analysisCalls = repository.listAnalysisCalls()
  const providerAttempts = repository.listProviderAttempts()
  const tasks = repository.listTasks()
  const usage = analyses.reduce(
    (total, analysis) => ({
      inputTokens: total.inputTokens + analysis.usage.inputTokens,
      outputTokens: total.outputTokens + analysis.usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + analysis.usage.cacheReadTokens,
      cacheWriteTokens:
        total.cacheWriteTokens + analysis.usage.cacheWriteTokens,
      costUsd: total.costUsd + analysis.usage.costUsd,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    }
  )
  process.stdout.write(
    `${JSON.stringify(
      {
        dataRoot,
        contents: contents.length,
        contentKinds: counts(contents, (content) => content.kind ?? 'unknown'),
        discoveries: repository.listDiscoveries().length,
        sources: repository.listSources().length,
        analyses: analyses.length,
        analysisCalls: analysisCalls.length,
        models: [...new Set(analyses.map((analysis) => analysis.model))],
        usage,
        tasks: tasks.length,
        taskStatuses: counts(tasks, (task) => task.status),
        providerAttempts: providerAttempts.length,
        providerStatuses: counts(providerAttempts, (attempt) => attempt.status),
        interactionSnapshots: repository.listInteractionSnapshots().length,
        relatedContentLinks: repository.listRelatedContents().length,
        parameterVersions: repository.listParameterVersions().length,
        userStates: repository.listContentUserStates().length,
        audits: repository.listAudits().length,
      },
      null,
      2
    )}\n`
  )
} finally {
  await repository.close()
}
