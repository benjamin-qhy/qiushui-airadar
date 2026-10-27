---
status: approved-for-development
date: 2026-09-17
updated: 2026-09-18
scope: content storage, processing state, configuration, and legacy-data replacement
---

# 单表 + Markdown 内容存储改造方案

本文是已获用户确认的开发方案。改造可按此方案实施；旧数据仍须在新结构通过真实抓取验收后才删除。

## 1. 这份方案解决什么问题

从本次改造起，qiushui-airadar 不再把一条内容拆散到内容、任务、分析、用户状态、互动快照、索引等多张表中。系统只保留一个新建的 SQLite 数据库文件，里面也只保留一张业务表：`contents`。

一条内容有两种保存形式：

- `contents` 表：负责搜索、筛选、排序、当前处理状态、AI 分析、评分和页面展示所需的字段。
- 每条内容的 Markdown 文件：负责让人可以直接阅读的中文内容（有中文原文或已翻译时）、英文原文（有英文原文时），以及完整执行日志。

这不是“把所有内容塞进数据库”的方案。正文不进表；表只是可查询的内容目录和当前结果。也不是“全文扫描文件”的方案：关键词搜索仅查 `contents` 中的标题、总结、关键词和来源字段，不扫描 Markdown。

## 2. 已确认的不可变规则

| 规则 | 具体含义 |
| --- | --- |
| 只有一张表 | 新数据库中只允许 `contents`；不保留任务、日志、分析、投影、缓存、全文检索或来源表。 |
| 允许普通索引 | 索引和唯一约束不是第二张表；它们只为去重、列表和字段搜索提速。禁止 FTS 虚拟表。 |
| 内容身份 | 常规内容以 `来源账号 + 内容 ID` 唯一；文章以链接唯一。 |
| 文件规则 | 每条内容必有 `执行日志.md`。中文原文或已经翻译的英文内容有 `中文.md`；有英文原文时有 `英文.md`。低分或垃圾英文内容不翻译，也不创建空的 `中文.md`。 |
| 按日期归档 | 按首次入库时的上海本地日期建立 `YYYYMMDD` 目录，其下内容目录名依次包含“平台 + 博主 + 唯一识别 + 原始标题”；原文没有标题时省略标题段。重复采集不移动目录。 |
| 顺序处理 | 信源按 YAML 顺序逐个执行；当前信源的内容处理完毕后再执行下一个。抓取列表接口只发首个请求，一律不请求下一页。 |
| 先分析后翻译 | 英文内容先完成分析与评分；仅非垃圾且总分达到 YAML 阈值的英文内容再意译为中文。 |
| AI 语言 | AI 生成的总结、关键词、垃圾判断理由、评分理由及其他分析结果使用中文。未翻译的英文短帖直接复制原帖正文作为 `summary`，这是原文而非 AI 生成结果。 |
| AI 结果进表 | 第一轮产出的 Markdown 总结、关键词与垃圾判断，以及第二轮产出的个人价值说明、四项评分及理由都在 `contents`。 |
| 配置文件化 | 信源、排程、模型、规则、保留期在 YAML；密钥在 `.env`；信源游标在本机 YAML。 |
| 不自动修复 | 表和文件不同步时，不做启动扫描、后台补偿或自动重建；人工重新执行该内容才会重试。 |
| 旧数据不迁移 | 通过新结构的一次真实抓取验收后，直接删除旧运行数据、旧数据库和旧格式 Markdown。 |

## 3. 落盘目录

假设数据根目录为 `$QIUSHUIAI_QIUSHUI_AIRADAR_DATA_ROOT`，一条内容的文件结构如下。日期取首次入库时间在 `Asia/Shanghai` 的日历日。目录规则固定为 `<平台>-<博主>-<唯一识别>[-<原始标题>]`；中括号表示原文有标题时才增加这一段。`博主`优先使用来源账号的公开 handle/名称；文章没有明确作者时使用来源配置中的账号名称。`唯一识别`对普通内容使用平台内容 ID，对文章使用规范化链接的 SHA-256 摘要；文章仍以完整规范化链接去重，摘要只用于目录名。数据库保存相对路径。

```text
$QIUSHUIAI_QIUSHUI_AIRADAR_DATA_ROOT/
  qiushui-airadar.sqlite                 # 仅含 contents 表和普通索引
  contents/
    20260917/
      x-OpenAI-<平台内容ID>-<原始标题>/ # 有原始标题
        中文.md                     # 中文原文或达到翻译门槛时
        英文.md                     # 有英文原文时
        执行日志.md
      x-OpenAI-<平台内容ID>/          # 原帖没有标题，不加标题段
        英文.md
        执行日志.md
      rss-OpenAI-News-<文章链接SHA-256>-<原始标题>/
        中文.md
        执行日志.md
  config/
    sources.yaml
    runtime.yaml
    analysis.yaml
    retention.yaml
    local/
      source-state.yaml           # 不提交 Git
  .env                            # 不提交 Git
```

文件名中的平台、博主、原始标题先做统一安全转义：去掉路径分隔符和控制字符，压缩空白，避免系统保留名称；原标题只取最多 60 个 Unicode 字符，完整原标题仍保存在表和 Markdown 属性中。若不同账号的内容 ID 可能重复，`唯一识别`中还要包含来源账号 ID 的稳定摘要。目录名只由首次入库时的原始元数据计算一次，写入表中的 Markdown 路径后不得因博主改名、标题变化、重抓或重新翻译而重命名。重复采集继续更新同一目录和同一行 `contents`；重新翻译覆盖 `中文.md` 正文，原因、模型和时间追加到 `执行日志.md`。

## 4. `contents` 完整表结构

### 4.1 建表 SQL

以下 SQL 是开发时应落地的目标结构。时间均为 ISO 8601 UTC 字符串；布尔值使用 `0`/`1`；所有 `*_json` 都是 JSON 文本，仍只存在于这一行里。

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE contents (
  -- 身份与来源
  id TEXT PRIMARY KEY,
  identity_kind TEXT NOT NULL
    CHECK (identity_kind IN ('source_content_id', 'article_url')),
  identity_value TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  source_platform TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  source_account_name TEXT NOT NULL,
  external_content_id TEXT,
  canonical_url TEXT,

  -- 内容基础信息与文件位置
  title TEXT NOT NULL,
  original_title TEXT,
  chinese_title TEXT,
  content_kind TEXT NOT NULL
    CHECK (content_kind IN ('short_post', 'video', 'image_post', 'article')),
  original_format TEXT NOT NULL DEFAULT 'plain_text'
    CHECK (original_format IN ('plain_text', 'markdown_article', 'subtitle')),
  original_language TEXT NOT NULL CHECK (original_language IN ('zh', 'en', 'unknown')),
  translated_to_chinese INTEGER NOT NULL DEFAULT 0 CHECK (translated_to_chinese IN (0, 1)),
  original_status TEXT NOT NULL DEFAULT 'available'
    CHECK (original_status IN ('available', 'deleted', 'private', 'unavailable')),
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  first_inflow_at TEXT NOT NULL,
  chinese_markdown_path TEXT,
  english_markdown_path TEXT,
  execution_log_markdown_path TEXT NOT NULL,

  -- 搜索、列表与 AI 内容结果
  summary TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  keywords_text TEXT NOT NULL DEFAULT '',
  value_summary TEXT,
  interest_fit_level INTEGER CHECK (interest_fit_level BETWEEN 1 AND 5),
  interest_fit_reason TEXT,
  concrete_gain_level INTEGER CHECK (concrete_gain_level BETWEEN 1 AND 5),
  concrete_gain_reason TEXT,
  substance_level INTEGER CHECK (substance_level BETWEEN 1 AND 5),
  substance_reason TEXT,
  new_information_level INTEGER CHECK (new_information_level BETWEEN 1 AND 5),
  new_information_reason TEXT,
  total_score INTEGER CHECK (total_score BETWEEN 0 AND 100),
  recommendation TEXT NOT NULL DEFAULT 'none'
    CHECK (recommendation IN ('core', 'explore', 'none')),
  scoring_rule_json TEXT,
  analysis_extra_json TEXT NOT NULL DEFAULT '{}',

  -- 垃圾判断、人工使用状态
  is_junk INTEGER NOT NULL DEFAULT 0 CHECK (is_junk IN (0, 1)),
  junk_source TEXT NOT NULL DEFAULT 'none'
    CHECK (junk_source IN ('ai', 'manual', 'rule', 'none')),
  junk_reason TEXT,
  junk_note TEXT,
  junk_updated_at TEXT,
  read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
  utilization_actions_json TEXT NOT NULL DEFAULT '[]',

  -- 互动、媒体与展示数据
  interaction_captured_at TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  images_json TEXT NOT NULL DEFAULT '[]',
  video_duration_seconds INTEGER,
  video_thumbnail_url TEXT,
  video_media_url TEXT,
  quoted_post_json TEXT,
  reposted_by_json TEXT,

  -- 当前处理状态；没有任务表，状态直接写回这一行
  process_status TEXT NOT NULL DEFAULT 'processing'
    CHECK (process_status IN ('processing', 'completed', 'failed', 'waiting-manual-transcription')),
  processing_stage TEXT NOT NULL DEFAULT 'discovered'
    CHECK (processing_stage IN ('discovered', 'enriching', 'classifying', 'scoring', 'translating', 'completed', 'failed', 'waiting-manual-transcription')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error TEXT,
  last_processed_at TEXT,
  delete_after TEXT,

  -- AI 调用可追溯信息；请求与响应写入脱敏日志，不在表中重复存放
  analyzed_at TEXT,
  analysis_provider TEXT,
  analysis_model TEXT,
  analysis_prompt_version TEXT,
  analysis_profile_version_id TEXT,
  analysis_rule_version TEXT,
  analysis_duration_ms INTEGER,
  analysis_input_tokens INTEGER,
  analysis_output_tokens INTEGER,
  analysis_cache_read_tokens INTEGER,
  analysis_cache_write_tokens INTEGER,
  analysis_cost_usd REAL,
  analysis_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX contents_list_sort
  ON contents (is_junk, process_status, recommendation, first_inflow_at DESC, total_score DESC);
CREATE INDEX contents_source_time
  ON contents (source_platform, source_account_id, published_at DESC);
CREATE INDEX contents_status_retry
  ON contents (process_status, processing_stage, retry_count, last_processed_at);
CREATE INDEX contents_keyword_search
  ON contents (title, chinese_title, summary, keywords_text, value_summary, source_account_name);
CREATE INDEX contents_expiry
  ON contents (delete_after) WHERE delete_after IS NOT NULL;
```

### 4.2 字段定义

| 字段组 | 字段 | 定义与用途 |
| --- | --- | --- |
| 身份 | `id` | 系统内部 UUID；不会因为原标题或链接参数变化而变化。 |
| 身份 | `identity_kind` / `identity_value` / `identity_key` | 内容去重键。普通内容的 `identity_key` 是 `source:<source_account_id>:content:<平台内容ID>`；文章是 `article:<规范化链接>`，所以同一篇文章即使被不同账号发现也只会有一行。 |
| 来源 | `source_platform` / `source_type` | 平台名与适配器类型，例如 `x`、`youtube`、`rss`。 |
| 来源 | `source_account_id` / `source_account_name` | 采集配置中稳定账号 ID 与页面显示名。唯一约束以 ID 而非显示名为准。 |
| 基础 | `external_content_id` / `canonical_url` | 供跳转原内容、诊断和身份判断；文章仅要求 `canonical_url`。 |
| 基础 | `title` / `original_title` / `chinese_title` | `title` 是当前展示标题，英译中后改为中文；`original_title` 保存抓取到的原标题，原帖无标题时为 `NULL`，目录名也没有标题段；`chinese_title` 保存中文标题，未翻译的英文内容为空。无原标题时，页面展示标题由应用从正文生成，不能伪装为原始标题。 |
| 基础 | `content_kind` | `short_post`、`video`、`image_post`、`article`，对应现有内容类型筛选。 |
| 基础 | `original_format` | 原文格式：普通文本、Markdown 文章、字幕。决定意译时保留 Markdown 排版还是按字幕时间顺序整理自然段。 |
| 基础 | `original_language` / `translated_to_chinese` | 原始语言和是否经过英译中。`unknown` 不应伪装成已翻译。 |
| 基础 | `original_status` | 原文可用性：可用、已删、私密、不可用；支持页面的“原文不可用”筛选。 |
| 时间 | `published_at` / `discovered_at` / `first_inflow_at` | 分别是原文发布、当前发现、首次进入系统的时间；日期筛选以 `first_inflow_at` 为准。 |
| 文件 | 三个 `*_markdown_path` | 相对数据根目录的路径，绝不存绝对路径。执行日志必填；中英文路径在没有对应正文时为空。 |
| 检索 | `summary` | 长内容由 AI 生成中文 Markdown 总结；短帖初始直接复制帖子正文，英文短帖达到翻译门槛后替换为中文意译。字段保留 Markdown 换行和列表，搜索只查字段文本。 |
| 检索 | `keywords_json` / `keywords_text` | 第一轮模型调用生成的中文关键词，同一份结果的展示数组和标准化搜索文本；后者只用于普通字段搜索，不引入全文索引表。 |
| 个人价值 | `value_summary` | 第二轮模型调用生成的一段简短中文说明，直接回答“我看完能获得什么”；价值低时说明收获有限的原因。垃圾内容跳过评分时为 `NULL`。 |
| 评分 | 4 组 `*_level` / `*_reason` | 四项 1–5 级评分及中文依据：兴趣匹配、具体收获、内容扎实度、新信息。权重依次为 40%、30%、20%、10%。 |
| 评分 | `total_score` / `recommendation` / `scoring_rule_json` | 总分 0–100、`core`/`explore`/`none` 分级，以及生成这次结果时的规则快照。 |
| AI 扩展 | `analysis_extra_json` | 暂未被页面搜索、筛选或排序的新 AI 返回字段；仍在同一行。升级为产品字段后再拆成独立列。 |
| 垃圾 | `is_junk` 等 | 垃圾不是立即删除；来源、理由、人工备注和更新时间都可审计。 |
| 用户状态 | `read` / `utilization_actions_json` | 已读和已用于收藏、卡片、视频、文章、项目等状态。 |
| 互动/媒体 | `interaction_*`、媒体 JSON 字段 | 当前最新互动快照及详情页渲染所需媒体数据；不保留多次快照历史。 |
| 流程 | `process_status` / `processing_stage` | 总状态用于筛选；当前步骤用于排障。两者都只代表当前情况。 |
| 流程 | `retry_count` / `last_error` / `last_processed_at` | 当前行的重试信息；完整逐次记录只在日志 Markdown。 |
| 清理 | `delete_after` | 垃圾内容的自动物理删除时间；为空表示不因保留期自动删除。 |
| AI 成本 | `analyzed_at` 至 `analysis_error` | 本次成功或失败的分析元信息与成本。请求与响应写入脱敏后的执行日志，不在表中重复保存。 |
| 审计 | `created_at` / `updated_at` | 本行创建和最后更新的系统时间。 |

### 4.3 四项评分规则

新版以 `config/profile.yaml` 中确认的兴趣与目标为依据，使用四项互不重复的 1–5 档评分。关注方向归纳为 AI 产品与应用、AI Agent/多智能体及技术框架、RAG/知识库、企业 AI 落地、AI 新技术与模型发布、自媒体运营、产品增长和一人公司实践；具体价值重点是可复用工具、工作流改进、产品机会、客户洞察、内容素材和商业判断。

| 字段前缀 | 中文名称 | 权重 | 判断问题 |
| --- | --- | ---: | --- |
| `interest_fit` | 兴趣匹配 | 40% | 是否贴近用户的兴趣与当前目标，而不只是碰巧提到 AI？ |
| `concrete_gain` | 具体收获 | 30% | 看完能否获得可复用工具、工作流改进、产品机会、客户洞察、内容素材或商业判断？ |
| `substance` | 内容扎实度 | 20% | 有没有事实、方法、案例、证据和适用边界？ |
| `new_information` | 新信息 | 10% | 有没有一手经验、新数据或新视角，而不只是转述？ |

每项 `level` 为 1–5，`reason` 必须用中文解释。启用的权重总和必须为 100%，否则配置校验失败。总分由程序按 `round(Σ((level - 1) × 25 × weight / 100))` 计算，范围 0–100；模型不直接输出总分。垃圾判断独立于四项评分，人工标记优先，垃圾内容不进入推荐。默认精选门槛：`core` 总分至少 80、`interest_fit = 5`、`concrete_gain >= 4`、`substance >= 3`；`explore` 总分至少 60、`interest_fit >= 4`、`concrete_gain >= 3`、`substance >= 3`；否则 `none`。门槛及权重可在 YAML 中调整，每条内容的 `scoring_rule_json` 记录实际使用的版本与快照。

此四项方案与现有[七项综合价值分 ADR](../adr/0002-use-one-versioned-composite-value-score.md)不一致。方案获准进入开发时，须同步更新该 ADR、界面评分展示及相关契约；在那之前，ADR 仍描述现行系统，不得把本方案误称为已实现。

### 4.4 字段搜索规则

普通关键词搜索使用参数化 SQL，对以下字段做大小写不敏感的 `LIKE` 匹配：`title`、`chinese_title`、`summary`、`keywords_text`、`value_summary`、`source_account_name`。不读取、更不遍历 Markdown 文件。

分数、状态、日期、来源、类型、垃圾、已读和推荐级别均使用明确列筛选。`analysis_extra_json` 不进入当前搜索条件；若以后产品需要以其中某字段筛选，应先把该字段提升为独立列和对应索引，而不是新建一张表。

## 5. 三类 Markdown 文档契约

Markdown 的定位是“可读档案”，不是第二份可搜索数据库。文件都使用 UTF-8、LF 换行；文件名固定，不随标题变化。内容文件的 Front matter 在每次处理完成、人工改垃圾状态或重评分后同步更新；其中的标题、总结、关键词、垃圾判断、评分与推荐状态是对应表字段在该时刻的快照。搜索仍只查询表。

### 5.1 `中文.md`

适用于中文原文，或已经达到翻译门槛并完成意译的英文内容。低分或垃圾英文内容不生成 `中文.md`，表内 `chinese_markdown_path` 为 `NULL`。Front matter 包含表中的关键字段；未完成分析时评分等属性可以为 `null`，分析完成后同步更新。

```markdown
---
content_id: "<contents.id>"
language: "zh-CN"
content_mode: "translation" # translation | original
source_platform: "<source_platform>"
source_account_id: "<source_account_id>"
original_format: "<contents.original_format>"
source_url: "<canonical_url>"
published_at: "<ISO-8601 或空>"
generated_at: "<ISO-8601>"
title: "<contents.title>"
original_title: "<contents.original_title>" # 原文无标题时改为 YAML null（不加引号）
summary: |-
  <contents.summary 的首行，可包含 Markdown>
  <后续行保持缩进与原有换行>
keywords_text: "<contents.keywords_text>"
value_summary: "<contents.value_summary>"
is_junk: false
junk_reason: null
total_score: 83
recommendation: "core"
scores:
  interest_fit: { level: 5, reason: "<中文理由>" }
  concrete_gain: { level: 4, reason: "<中文理由>" }
  substance: { level: 4, reason: "<中文理由>" }
  new_information: { level: 3, reason: "<中文理由>" }
translation_provider: "<provider 或 original>"
translation_model: "<model 或 original>"
---

<完整中文正文；意译时原样写 chineseBody，不自动补大小标题>
```

属性定义：`content_id` 必须与表主键一致；`content_mode` 明确内容是翻译还是中文原文；`source_url` 只存可公开访问的原文链接；`translation_*` 在中文原文时写 `original`，绝不虚构模型。`title` 是当前表中展示标题，`original_title` 是抓取原标题；`summary` 使用 YAML `|-` 多行文本，原样保留 Markdown 结构；`keywords_text`、`value_summary`、`is_junk`、`junk_reason`、`total_score`、`recommendation` 和四项 `scores` 分别镜像表中的当前结果。垃圾内容不评分时，`value_summary`、总分和四项评分写 YAML `null`，推荐级别为 `none`。正文按来源格式保存：Markdown 文章保留原有层级，字幕意译按自然段写入，不由文件写入器额外添加标题；正文不混入执行日志。

### 5.2 `英文.md`

只在 `original_language = en` 且取得英文正文时创建。它保存采集/富化后得到的英文原文。即使该内容被判垃圾或低分、没有中文译文，也必须保留此文件；Front matter 中的分析字段仍使用中文。

```markdown
---
content_id: "<contents.id>"
language: "en"
source_platform: "<source_platform>"
source_account_id: "<source_account_id>"
original_format: "<contents.original_format>"
source_url: "<canonical_url>"
published_at: "<ISO-8601 或空>"
captured_at: "<ISO-8601>"
title: "<contents.title>"
original_title: "<contents.original_title>" # 原文无标题时改为 YAML null（不加引号）
summary: |-
  <contents.summary 的首行，可包含 Markdown 或原帖文本>
  <后续行保持缩进与原有换行>
keywords_text: "<contents.keywords_text>"
value_summary: "<contents.value_summary>"
is_junk: false
junk_reason: null
total_score: 83
recommendation: "core"
scores:
  interest_fit: { level: 5, reason: "<中文理由>" }
  concrete_gain: { level: 4, reason: "<中文理由>" }
  substance: { level: 4, reason: "<中文理由>" }
  new_information: { level: 3, reason: "<中文理由>" }
---

<完整英文原文；若原文为 Markdown，原样保留标题、列表等格式>
```

属性定义：`captured_at` 是英文原文写入文件的时间；`title`、`summary` 等镜像处理后的当前表值，因此英文文件也可能显示中文标题和中文总结；正文始终保留英文原文及已有的 Markdown 格式，写入器不额外添加标题。未翻译的英文短帖，其 `summary` 暂为英文原帖正文。垃圾内容不评分时，`value_summary`、总分和四项评分写 YAML `null`，推荐级别为 `none`。该文件缺失时 `english_markdown_path` 必须为 `NULL`，不能创建空文件占位。

### 5.3 `执行日志.md`

每次采集、富化、总结、分析、翻译、人工重试、人工删除前的操作都追加一个事件；不覆盖历史事件。每次对供应商或 AI 模型的调用都保存脱敏后的完整文本/JSON `request` 和 `response`，包括失败响应；二进制媒体保存 URL、大小、类型及文件引用，不内嵌二进制。若请求在收到响应前失败，`response` 写明“未收到响应”和错误类型，不能伪造 HTTP 状态码。日志不作为系统恢复依据，系统也不会扫描它来修复表。

````markdown
---
content_id: "<contents.id>"
created_at: "<ISO-8601>"
---

# 执行日志

## <ISO-8601> | score | succeeded

- 阶段：`scoring`
- 触发方式：`scheduled` # scheduled | manual-retry | manual-action
- 耗时：`1234 ms`
- 重试次数：`0`
- 处理器：`<provider>/<model>`
- 提示词：`02-内容分析与评分.md`，版本 `3`
- 结果：已写入个人价值说明和四项评分；程序另行计算总分与推荐级别。

### request

```json
{"method":"POST","url":"https://example.invalid/analyze","headers":{"Authorization":"[REDACTED]"},"body":{"promptId":"content-analysis-and-scores","promptVersion":3,"title":"示例标题","content":"示例内容"}}
```

### response

```json
{"status":200,"body":{"valueSummary":"能学到一套可复用的内容筛选做法，并据此调整自己的工作流程。","scores":{"interestFit":{"level":5,"reason":"契合当前工作"},"concreteGain":{"level":4,"reason":"方法可复用"},"substance":{"level":4,"reason":"有实际步骤"},"newInformation":{"level":3,"reason":"有部分新见解"}}}}}
```

## <ISO-8601> | translate | failed

- 阶段：`translating`
- 触发方式：`manual-retry`
- 耗时：`456 ms`
- 重试次数：`1`
- 错误摘要：`<经脱敏后的错误>`

### request

```json
{"method":"POST","url":"https://example.invalid/translate","headers":{"Authorization":"[REDACTED]"},"body":{"content":"English text"}}
```

### response

```json
{"status":503,"body":{"error":"provider unavailable"}}
```
````

事件属性定义：时间、动作、状态、阶段、触发方式、耗时、重试次数、处理器、`request`、`response` 和经脱敏的错误摘要为固定项。文本/JSON 请求和响应在脱敏后保留原有字段与内容；Cookie、API Key、Authorization 值、URL 中的 token、私密账号信息和其他凭证必须先脱敏再落盘。供应商响应不得因为大而静默截断；如无法安全脱敏，记录失败原因并阻止该次请求/响应原文落盘。对没有外部调用的内部状态变更，`request`、`response` 明确写 `无`。这些调用记录属于该内容的执行日志，随内容保留；删除内容时一并删除，不单独按供应商响应保留期从日志中清除。

## 6. 配置文件契约

| 文件 | 是否提交 Git | 负责内容 |
| --- | --- | --- |
| `config/sources.yaml` | 是 | 信源账号、平台、抓取参数、启停状态；不含游标和密钥。 |
| `config/runtime.yaml` | 是 | 时区、定时规则、最大重试次数、每信源抓取上限、垃圾自动删除策略；信源串行运行，每个抓取接口只请求一页。 |
| `config/analysis.yaml` | 是 | 分析模型名称、提示词版本号、四项评分权重与精选门槛，以及英文内容意译的最低总分阈值。 |
| `config/profile.yaml` | 是 | 用户兴趣、当前目标、排除规则；分析提示词从这里读取，经人工确认后才更新。 |
| `config/retention.yaml` | 是 | 垃圾内容保留期及其他非敏感清理规则；内容的执行日志随内容一同保留或删除。 |
| `config/local/source-state.yaml` | 否 | 每个来源的上次已见内容 ID/时间、最后采集时间、运行时覆盖；不建来源/进度表，也不保存分页游标。 |
| `.env` | 否 | API Key、Cookie、私密端点；不得进入数据库、Markdown、日志或 Git。 |

`source-state.yaml` 的最小格式：

```yaml
sources:
  x_openai:
    last_seen_content_id: "<上次已见的帖子 ID>"
    last_collected_at: "2026-09-17T00:00:00.000Z"
    enabled_override: null
```

上次已见 ID 只用于识别增量内容，不能作为 `next_page`、`cursor` 等分页参数发起后续列表请求。若供应商首个请求本身要求一个“起点”参数，适配器可使用上次已见 ID，但本轮仍只请求一次列表；该参数及其用途要写入执行日志。

配置加载顺序固定为：仓库默认 YAML → 本机 `config/local` 覆盖 → `.env` 密钥注入。服务启动时只输出“加载了哪些非敏感配置文件”和“哪些密钥已配置”，绝不输出密钥值。

`config/analysis.yaml` 中须有 `translation.minimum_total_score`（0–100 的整数）。翻译条件是 `is_junk = false` 且 `total_score >= minimum_total_score`。等于阈值时翻译；无有效评分、AI 分析失败时不翻译，内容保持待处理/失败状态。这个阈值只控制英文到中文的意译，不改变 `recommendation` 的评分阈值。

`config/profile.yaml` 归纳用户关注方向：自媒体运营、AI 产品与应用、AI Agent 与多智能体、Agent 技术框架、RAG/知识库、企业 AI 落地、AI 新技术与模型发布、产品增长、一人公司等；关注这些内容能否带来可复用工具、工作流改进、产品机会、客户洞察、内容素材或商业判断。只出现某个关键词不等于高匹配。画像及排除规则由用户维护，AI 不能自行修改生效版本。

短帖与长帖的判断优先使用平台明确的长文、帖子串和字幕标识；平台没有此信息时使用 `summarization.long_content_min_chars` 判定正文长度。每条可处理内容都调用第一轮提示词；只有长内容要求该次调用返回总结正文，短帖只返回关键词和垃圾判断。首次识别的短/长模式写入执行日志，重抓时不能仅因展示标题变化而改变模式。

所有发给大模型的提示词统一保存在 [`prompts/single-table-content/`](../prompts/single-table-content/)；每次调用只选用该目录中的一份 Markdown 提示词，填入内容和画像等变量。日志记录提示词文件名与内容摘要，便于复查实际发出的版本。

配置示例：

```yaml
translation:
  minimum_total_score: 60 # 最终数值由配置决定；达到 60 分才翻译
summarization:
  long_content_min_chars: 1000 # 仅在平台没有明确长内容标识时使用
scoring:
  weights: { interest_fit: 40, concrete_gain: 30, substance: 20, new_information: 10 }
  core_threshold: 80
  explore_threshold: 60
  core_min_levels: { interest_fit: 5, concrete_gain: 4, substance: 3 }
  explore_min_levels: { interest_fit: 4, concrete_gain: 3, substance: 3 }
```

## 7. 新处理流程

```text
按 sources.yaml 顺序取一个信源
  → 调用一次列表接口，不跟随分页游标；按配置上限处理本次返回内容
  → 逐条去重、抓取完整帖子/长文/字幕，并先保存原始内容与执行日志
  → 第 1 次 AI 调用：提取中文关键词、判断是否垃圾；长文/长帖/字幕同时生成通俗易懂的中文 Markdown 总结
    短帖在这次调用中只做关键词与垃圾判断，summary 仍直接取原帖正文
  → 最终标记为垃圾：写回判定并完成处理；总分与四项评分为 NULL、推荐级别为 none，不翻译
    非垃圾：第 2 次 AI 调用，只读完整原文与用户画像，输出一段个人价值说明及四项评分理由
  → 程序按版本化权重计算总分、推荐级别，并判断翻译门槛
  → 英文且非垃圾且总分达到 translation.minimum_total_score：意译成中文
    其他英文内容：保留英文原文，不生成 中文.md
  → 写回同一行 contents，更新内容 Markdown 的关键属性
  → 当前信源所有内容处理结束后，才开始下一个信源
```

“不分页”只针对抓取接口的后续页请求；若返回某条帖子的正文不完整，仍按适配器需要请求该帖子的详情、长文或字幕。单个内容处理失败要记录失败并继续该信源的下一条，避免阻塞所有信源；该信源本轮所有内容达到完成、失败或待人工转写之一，才进入下一个信源。短帖也调用第一轮模型做关键词与垃圾判断，但第一轮不为短帖生成总结；第二轮模型不接收第一轮生成的文章总结。

“先保存原始内容”的含义是：英文内容先写 `英文.md`，中文内容先写 `中文.md`，并建立同一条 `contents` 记录；长文或字幕需要先取到完整正文再进入总结。英文内容之后若达标，再新建 `中文.md`。若某条内容尚未取到可用正文，记录失败或待人工转写，不创建空正文文件。

英文短帖在第一轮前把英文正文暂存为 `summary`；达到翻译门槛后，更新 `summary` 为中文意译、`title` 与 `chinese_title` 为中文标题，`original_title` 保留原题。英文长内容的 `summary` 和关键词已在第一轮生成中文结果，意译正文后不重复改写这两个字段。低分或垃圾英文内容的 `summary`：短帖保留英文正文，长内容保留第一轮生成的中文总结。第一轮 AI 垃圾判断不得覆盖已有人工标记；以最终垃圾状态决定是否跳过第二轮。所有情况下，AI 生成的关键词、垃圾理由、评分理由及个人价值说明均为中文。

### 7.1 每条内容调用大模型的次数

以下是**方案中的正常成功路径**，指处理一条内容所需的大模型调用；抓取接口、取得字幕/正文的供应商接口不计入。失败重试、模型返回格式不合格后的重试、人工重跑会增加实际调用次数，每次都须分别写执行日志。

| 内容类型 | 第一轮：关键词/垃圾判断，长内容另含总结 | 第二轮：个人价值与四项评分 | 达标英文意译 | 正常调用合计 |
| --- | ---: | ---: | ---: | ---: |
| 垃圾短帖或垃圾长内容（任何语言） | 1 | 0 | 0 | **1** |
| 非垃圾中文短帖或长内容 | 1 | 1 | 0 | **2** |
| 非垃圾英文短帖或长内容，低于翻译阈值 | 1 | 1 | 0 | **2** |
| 非垃圾英文短帖或长内容，达到翻译阈值 | 1 | 1 | 1 | **3** |

三个调用各做一件事：

1. **中文总结与内容判定**：每条可处理内容调用一次，输出中文关键词与垃圾判断；长内容额外输出专业而通俗的中文 Markdown `summary`，短帖不生成总结。提示词：[`01-中文总结与内容判定.md`](../prompts/single-table-content/01-中文总结与内容判定.md)。
2. **内容分析与评分**：仅非垃圾内容调用，输入完整原文和用户画像，不输入前一轮的文章总结。输出一段简短的个人价值说明及四项 1–5 档评分和中文理由。总分、推荐级别及意译门槛由程序计算。提示词：[`02-内容分析与评分.md`](../prompts/single-table-content/02-内容分析与评分.md)。
3. **英文意译**：仅非垃圾且达标时调用。字幕按原有时间顺序整合成自然段意译；原文为 Markdown 的文章保留原有标题、段落、列表、链接等格式，不另加大小标题。英文短帖用译文更新 `summary`；英文长内容保留前面生成的中文 Markdown `summary` 与关键词。提示词：[`03-英文内容意译.md`](../prompts/single-table-content/03-英文内容意译.md)。

视频若没有可用字幕且需要单独的语音转写服务，其调用次数、成本取决于转写服务，属于抓取/富化阶段，不能算进上表固定的大模型次数；等待人工转写的内容不会进入总结与评分。图片帖若需要额外 OCR 或视觉识别，也须单独记录该服务调用，再按提取出的正文属于短内容还是长内容走上述路径。

写入失败时：本次操作返回失败，更新当前行的 `process_status`、`processing_stage`、`last_error`、`retry_count` 并追加可写入的日志；不启动后台补偿、不在下次启动时扫描修复。人工选择“重新执行此内容”才允许再次处理。

## 8. 旧数据删除与开发顺序

旧数据删除获得明确授权，但只能发生在新结构真实验收之后。开发按下列顺序执行：

1. 新增新的数据根目录、配置模板、单表运行时和三类 Markdown 写入器；此阶段绝不触碰旧数据根目录。
2. 将抓取、去重、翻译、分析、页面列表与手动操作改为只读写新 `contents` 表和新目录。
3. 用至少一个中文短帖、一个高分英文短帖、一个低分或垃圾英文短帖、一个英文长内容、一个文章链接内容完成真实抓取验收；验证单页抓取、信源串行、字段搜索、评分、翻译分流、日志中的脱敏请求/响应和对应文件。
4. 确认新数据库的 `sqlite_master` 中只有 `contents` 表；确认没有 FTS 虚拟表和旧运行表。
5. 停止服务，精确删除旧数据根目录中的旧数据库、旧索引、旧格式 Markdown、历史任务和历史处理记录；不迁移、不备份。
6. 启动新服务，重新执行一次真实抓取；验证旧目录没有被重建，且新数据仅落入新单表和新目录。

删除属于不可逆操作。实际执行前必须先用只读命令确认旧/新数据根目录、服务进程和待删除的精确路径；不得使用宽泛路径或递归清理工作区。

## 9. 开发验收清单

- 数据库 `sqlite_master` 只出现 `contents` 表；允许普通 `index`，不允许其他 `table` 或 `virtual table`。
- 普通内容、文章链接、重复内容均符合唯一身份规则。
- 中文原文及达标的英文内容有 `中文.md`；低分或垃圾英文内容没有 `中文.md`，但有 `英文.md`；每条必有 `执行日志.md`。目录按首次入库上海日期归档，目录名依次为平台、博主、唯一识别、可选原始标题；无原标题时不加标题段，重抓或改标题时不重命名。
- 两个以上信源顺序执行；抓取列表接口对每个信源只请求一页，帖子的详情或字幕可单独请求。
- 短帖第一轮只产出中文关键词和垃圾判断，`summary` 仍取原帖正文；英文短帖达标意译后更新为中文。长内容第一轮产出专业、通俗易懂的中文 Markdown 总结与关键词/垃圾判断。
- 垃圾内容只调用第一轮，评分与总分为 `NULL` 且不翻译；非垃圾内容第二轮只接收原文和画像，不接收第一轮文章总结。模型调用次数符合第 7.1 节四种正常路径；三份提示词都在同一目录，日志保存提示词文件名及版本。
- 字幕意译按时间与语义自然分段；Markdown 文章意译保留原有标题、列表、链接和代码等结构，译文面向非技术读者且不新增大小标题。
- 内容 Markdown 的 Front matter 包含 `title`、`original_title`、保留换行的 `summary`、`keywords_text`、一段 `value_summary`、`is_junk`、四项评分、总分、推荐状态；完成处理后与表字段一致。
- 执行日志中的每次外部调用都含经脱敏的 `request` 和 `response`，含失败响应，不泄露凭证。
- 列表的关键词搜索不读取 Markdown；搜索覆盖标题、中文标题、总结、关键词、一段个人价值说明和来源账号。
- 当前界面的状态、推荐、已读、垃圾、日期、类型、来源、总分排序、四项评分和具体收获均由 `contents` 字段提供。
- AI 元信息、评分理由和费用字段可在同一行读取；未使用的新结果只进 `analysis_extra_json`。
- 运行配置、信源游标和密钥均从规定文件读取；密钥不会落入 SQLite、Markdown 或日志。
- 故意制造一次文件写入失败时，不会出现自动修复或第二张表；只有人工重试才重新执行。
- 旧数据删除仅在真实抓取验收通过后发生，并证明新系统不再依赖旧数据库。

## 10. 非目标

- 不迁移历史内容、历史任务、历史分析、历史互动快照或旧数据库。
- 不提供跨文件全文搜索、向量搜索、FTS 或第二张缓存/索引表。
- 不提供自动恢复、自动扫描修复、自动备份或回滚旧数据。
- 不把 API Key、Cookie 等凭证写入 Markdown、SQLite 行或运行日志；外部调用的请求与响应在执行日志中完整记录可安全脱敏的文本/JSON 内容。
