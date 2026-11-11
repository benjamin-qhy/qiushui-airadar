export type PageKey =
  | 'daily'
  | 'all'
  | 'unprocessed'
  | 'exceptions'
  | 'favorites'
  | 'junk'
  | 'sources'
  | 'collection-settings'
  | 'models'
  | 'runtime'
  | 'runtime-log'
  | 'config'
export type UtilizationAction =
  'favorite' | 'card' | 'video' | 'article' | 'project'

export interface FeedItem {
  id: string
  title: string
  originalTitle?: string
  chineseTitle?: string
  url?: string
  publishedAt?: string
  discoveredAt?: string
  firstInflowAt?: string
  originalFormat?: 'plain_text' | 'markdown_article' | 'subtitle'
  externalContentId?: string
  processStage?: string
  retryCount?: number
  lastError?: string
  lastProcessedAt?: string
  analyzedAt?: string
  body: string
  hasEnglishBody?: boolean
  summary: string
  keywordsText?: string
  postMode?: string
  editorialJudgment?: string
  valueSummary?: string
  originalLanguage?: 'zh' | 'en' | 'unknown'
  chineseTranslation?: string
  translatedToChinese?: boolean
  translationStatus?:
    | 'not_applicable'
    | 'pending'
    | 'skipped'
    | 'running'
    | 'succeeded'
    | 'failed'
  translationSkipReason?: string
  translationError?: string
  translationChunkCount?: number
  translationCompletedChunks?: number
  topics: string[]
  scores: Record<string, unknown>
  totalScore: number | null
  recommendation: 'core' | 'explore' | 'none'
  kind?: 'short_post' | 'video' | 'audio' | 'image_post' | 'article'
  source?: { id: string; name: string; type: string; language?: 'en' | 'zh' }
  images?: Array<{ order?: number; url: string }>
  quotedPost?: {
    url: string
    authorName?: string
    authorHandle?: string
    text: string
    images: Array<{ order?: number; url: string }>
  }
  repostedBy?: { name: string; handle?: string; url: string }
  video?: {
    durationSeconds?: number
    thumbnailUrl?: string
    mediaUrl?: string
    mediaQuality?: string
    mediaMimeType?: string
    hlsManifestUrl?: string
    assetsFetchedAt?: string
    transcriptText?: string
    transcriptLanguage?: string
    transcriptFormat?: 'txt' | 'srt'
    transcriptChinese?: string
    transcriptChineseFetchedAt?: string
  }
  unprocessedReason?: string
  processStatus:
    | 'processing'
    | 'completed'
    | 'failed'
    | 'waiting-manual-transcription'
    | 'unprocessed'
  originalStatus?: unknown
  read: boolean
  utilizationActions: UtilizationAction[]
  junk: {
    isJunk: boolean
    source: 'ai' | 'manual' | 'rule' | 'none'
    reason?: string
    note?: string
  }
  evidence?: unknown
  interaction?: {
    capturedAt: string
    views: number | null
    likes: number | null
    comments: number | null
    shares: number | null
    saves: number | null
  }
  analysis?: {
    provider: string
    model: string
    profileVersionId: string
    ruleVersion: string
  }
}

export interface ScoreRange {
  id: string
  min: number
  max: number
}

export interface SourceItem {
  id: string
  name: string
  type: string
  language: 'en' | 'zh'
  externalIdentity: string
  status: 'enabled' | 'disabled' | 'archived'
  health: 'healthy' | 'warning' | 'unavailable' | 'disabled'
  metadata?: {
    category: string
    secondaryCategory: string
    tags: string[]
    audiences: string[]
    accountType: string
    official: boolean
  }
  tags?: string[]
  notes?: string
  effectiveParameters: { ids: string[]; values: Record<string, unknown> }
  latestAudit?: {
    discovered: number
    succeeded: number
    failed: number
    finishedAt: string
  }
}

export interface ProviderItem {
  id: string
  name: string
  sourceType: string
  priority?: number
  preferred: boolean
  secretName?: string
  health: { state: string; reason?: string }
  secretStatus?: { configured: boolean; maskedValue?: string }
}

export interface ProviderRouteItem {
  id: string
  name: string
  description: string
  providers: string[]
  availableProviders: string[]
}
