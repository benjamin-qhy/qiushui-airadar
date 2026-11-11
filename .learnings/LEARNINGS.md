# Learnings

## [LRN-20260920-MP1] correction

**Logged**: 2026-09-20T08:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary

“模型管理”中的“提供商”专指大模型提供商，不是 TwitterAPI、TikHub 等内容采集提供商。

### Details

首次实现仅按界面里已有的“供应商”字样，把信源采集 API 提供商搬进了模型管理，混淆了两个不同领域。正确边界是：OpenAI Codex 等 LLM 提供商及其授权方式属于模型管理；TwitterAPI、TikHub、YouTube Data API 和 RSS 等仍属于信源管理。

### Suggested Action

涉及“提供商”时先结合页面领域和实际调用链确认语义。模型管理绑定分析模型网关与模型凭据；信源管理绑定采集适配器与采集 API 凭据。

### Metadata

- Source: user_feedback
- Related Files: apps/web/src/features/model-management-page.tsx, apps/web/src/features/sources-page.tsx, apps/service/src/single-table-service.ts
- Tags: model-provider, source-provider, domain-boundary
- Pattern-Key: frontend.provider_term_requires_domain_context
- Recurrence-Count: 1
- First-Seen: 2026-09-20
- Last-Seen: 2026-09-20

### Resolution

- **Resolved**: 2026-09-20T08:52:00+08:00
- **Notes**: 模型管理改为 OpenAI Codex 大模型提供商及本机 OAuth 授权配置；采集 API 提供商恢复到信源管理，并完成开发版浏览器验证。

---

## [LRN-20261111-002] correction

**Logged**: 2026-11-11T10:05:00+08:00
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
检查本机正式服务接口时必须绕过代理，否则会把代理返回的空响应误判为服务故障。

### Details
当前终端设置了 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY`，但没有 `NO_PROXY`。直接请求 `127.0.0.1:43120` 时请求经过代理并出现 `Empty reply from server`；使用 `curl --noproxy '*'` 后，正式服务正常返回 HTTP 200 和模型配置。此前据此判断“正式服务接口坏了”是错误的。

### Suggested Action
所有 localhost、127.0.0.1 和局域网正式服务检查都显式使用 `--noproxy '*'`，并在判断接口故障前先用 `curl -v` 确认实际连接目标。

### Metadata
- Source: error
- Related Files: /Users/qiushui/.qiushui-airadar/service/logs/service.log
- Tags: proxy, localhost, production-service, curl, diagnosis
- Pattern-Key: infra.local_service_bypass_proxy
- Recurrence-Count: 1
- First-Seen: 2026-11-11
- Last-Seen: 2026-11-11

---

## [LRN-20260918-001] correction

**Logged**: 2026-09-18T14:27:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary

单条 YouTube 视频取不到字幕，不等于此前实现的字幕获取能力整体失效。

### Details

用户指出 YouTube 字幕此前已成功获取。排查时应使用同一代码、同一凭据对照已知有字幕的视频，并检查供应商原始响应。本次旧视频可取得字幕，新视频的 TikHub 响应为无可用字幕；YouTube Data API 的 `contentDetails.caption=false` 对两条视频都成立，不能凭这个标记判断自动字幕是否存在。

### Suggested Action

遇到单条视频缺字幕时，先做同源对照并区分供应商返回空、解析失败与独立转写缺失；不要把视频简介当作字幕。

### Metadata

- Source: user_feedback
- Related Files: packages/source-adapters/src/index.ts, apps/service/src/single-table-provider.ts
- Tags: youtube, captions, diagnosis
- Pattern-Key: backend.youtube_caption_missing_is_not_global_failure
- Recurrence-Count: 1
- First-Seen: 2026-09-18
- Last-Seen: 2026-09-18

---

## [LRN-20260915-001] correction

**Logged**: 2026-09-15T14:42:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary

内容页头部除搜索框外，应统一使用 shadcn DropdownMenu，并以 ButtonGroup 呈现触发器。

### Details

首版将类型和推荐做成 Tabs、平台做成 Select、日期和更多筛选做成 Popover。用户进一步明确：搜索保留 Input，其余头部筛选统一使用 DropdownMenu；触发器采用 ButtonGroup 的连续按钮效果，不使用 Select 输入框外观；日期使用周、月、三个月、半年和自定义范围。后续头部排列应统一靠右，并按“关键词、类型、推荐、评分、平台、日期”排列；平台是内容来源类型，应覆盖系统当前支持的全部类型（X、YouTube、RSS、抖音、视频号、小红书），不能把具体博主当作平台，也不能擅自缩减平台集合。

### Suggested Action

修改内容页头部时，先确认筛选语义和固定顺序，再选择 shadcn 组件；平台选项必须绑定 `source.type`，不能绑定 `source.name`。

### Metadata

- Source: user_feedback
- Related Files: apps/web/src/features/content-workspace.tsx, apps/web/src/lib/content-filters.ts
- Tags: shadcn, dropdown-menu, content-filters
- Pattern-Key: frontend.content_header_component_contract
- Recurrence-Count: 4
- First-Seen: 2026-09-15
- Last-Seen: 2026-09-15

### Resolution

- **Resolved**: 2026-09-15T14:42:00+08:00
- **Notes**: 本次改造中统一组件并补充日期范围过滤。

---

## [LRN-20260917-001] correction

**Logged**: 2026-09-17T21:41:00+08:00
**Priority**: high
**Status**: pending
**Area**: tests

### Summary

仅在修改采集规则时才考虑清空旧测试数据并重跑真实信源，且每次删除前必须取得用户明确批准。

### Details

先前把“每次修改后测试”理解成所有代码变更都自动清空测试目录，并在未单独确认删除范围的情况下重建了独立测试库。用户纠正：只有采集规则等变更需要这样做；重跑时 YouTube、X、RSS 各选一个信源、各取前 10 条；删除之前数据并重新执行必须事先获得用户明确批准。正式数据与独立测试数据都不能因这句话被默认为可删除。

### Suggested Action

测试前先判断改动是否涉及采集规则。若需要清空，明确列出待删数据目录或范围与重跑内容，等待用户批准；未批准时只做不删除数据的验证。

### Metadata

- Source: user_feedback
- Related Files: scripts/accept-three-source-fresh.ts
- Tags: destructive-action, source-acceptance, approval
- Pattern-Key: tests.collection_reset_requires_approval
- Recurrence-Count: 1
- First-Seen: 2026-09-17
- Last-Seen: 2026-09-17

---

## [LRN-20260915-002] correction

**Logged**: 2026-09-15T20:27:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary

内容卡片外围应保持轻量，不使用阴影或粗描边。

### Details

用户明确要求内容列表卡片周边不要有阴影和粗线；选中与悬停状态应通过浅色背景和轻微边框颜色变化表达。

### Suggested Action

修改内容卡片时保留淡色 1px 边框，避免 `shadow-*`、额外 `ring-*` 和明显位移动画。

### Metadata

- Source: user_feedback
- Related Files: apps/web/src/features/content-workspace.tsx
- Tags: card, border, shadow, visual-style
- Pattern-Key: frontend.content_card_lightweight_surface
- Recurrence-Count: 1
- First-Seen: 2026-09-15
- Last-Seen: 2026-09-15

### Resolution

- **Resolved**: 2026-09-15T20:27:00+08:00
- **Notes**: 已移除卡片阴影、粗描边和悬停位移，选中状态改为浅色背景。

---

## [LRN-20260918-001] correction

**Logged**: 2026-09-18T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: docs

### Summary

AI Radar 单表方案的内容处理必须按信源串行且抓取接口不分页，英文内容先分析评分再决定是否意译。

### Details

先前方案把英文内容默认视为有中文文件，并把翻译放在分析前；用户纠正为：短帖不单独总结，英文短帖的 summary 初始为原文，达标意译后才改成中文；低分或垃圾英文内容没有中文正文；AI 生成的总结和分析结果均为中文。日志必须保留脱敏后的 request/response，内容文件属性要镜像表中关键字段。

### Suggested Action

实现内容流水线时逐分支核对短帖、长内容、英文翻译门槛、文件是否存在及 Front matter 同步；验收覆盖两个信源的串行与单页抓取。

### Metadata

- Source: user_feedback
- Related Files: docs/architecture/2026-09-17-single-table-markdown-storage-development-plan.md
- Tags: content-pipeline, translation, storage-design
- Pattern-Key: airadar.content_pipeline_user_contract
- Recurrence-Count: 1
- First-Seen: 2026-09-18
- Last-Seen: 2026-09-18

### Resolution

- **Resolved**: 2026-09-18T00:00:00+08:00
- **Notes**: 已更新开发方案的流程、字段、文件契约与验收要求。

---
## [LRN-20261111-001] correction

**Logged**: 2026-11-11T09:20:00+08:00
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
核对正式版“调用日志”时，必须先按 endpoint 和阶段区分采集请求与模型请求，不能只看成功数量或 SQLite 汇总字段。

### Details
用户指出当天调用日志已有大量成功记录。进一步核对发现，`collection-runs/*-requests.jsonl` 中的成功记录是 TwitterAPI.io、TikHub 和 RSS 等采集接口，并非 Ollama；真正的模型阶段要结合 `collection-run.json` 的 `phase`、Ollama `11434` 连接、当天内容 `执行日志.md` 的 `classify/score/translate` 结果及 SQLite 分析字段判断。此前仅查询 SQLite 也不足以判断当前正在进行但尚未返回的模型调用。

### Suggested Action
以后回答“当前调用哪个模型、成功多少”时，先检查日志 endpoint 和运行阶段；分别统计采集接口成功、模型连接中、模型阶段成功/失败。数据库字段与逐条执行日志用于确认已完成结果，网络连接用于确认正在进行的调用。

### Metadata
- Source: user_feedback
- Related Files: production-data/collection-run.json, production-data/collection-runs/*-requests.jsonl, production-data/contents/YYYYMMDD/**/执行日志.md
- Tags: production, collection-calls, model-calls, logs, sqlite

---
