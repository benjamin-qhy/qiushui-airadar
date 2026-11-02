# Twitter/X 采集接口与增量优化调研

## 实际调用补查：此前 $0.38025 不是本轮全部接口费用

再次检查09:59—10:59新入库263条的执行日志：独立enrich调用中记录3次TwitterAPI.io `/twitter/article`（HTTP 200），以及8次TikHub `/api/v1/youtube/web_v2/get_video_captions`（7次HTTP 200，1次未获得HTTP响应）。另在发现证据中找到TikHub备用 `/api/v1/twitter/web/fetch_user_post_tweet` 的请求，说明“所有2,349条都由TwitterAPI.io返回”的原计算仅是假设，不能当账单。

按[TwitterAPI.io价格](https://twitterapi.io/pricing/details)，3次文章接口标价$0.003；按[TikHub字幕接口文档](https://docs.tikhub.io/431829301e0)，字幕请求每次$0.008，无字幕HTTP 200也计费，7次成功HTTP响应按标价估算$0.056。将这两项加到此前基础估算$0.38025，得到粗估$0.43925（约$0.44），不含AI。此数不是完整实际账单，也不是经证明的费用下限。

精确核算的障碍：请求/响应载荷超过32KiB会被截断，本次解析发现267个相关响应片段无法完整JSON解析；发现证据按内容重复保存，全部已有内容的信源可能不留下本轮内容日志；扫描量经过mapXTweets归一化/去重，不等于供应商原始计费返回数；备用调用价格与折扣、失败重试扣费未核实。TwitterAPI.io内置浏览器后台连续两次30秒超时；TikHub用户每日用量API与端点价格元数据请求返回HTTP403。因此此前基础数及本次$0.44均须明确标为估算，完整本轮实际扣费尚未确认。

## 今日实际数量下的三方案费用复算

按已完成运行北京时间2026-11-02 09:59—10:59统计：155个X账号、返回2,349条X帖子；新增入库263条，分布在78个X信源，另外77个信源无新增入库。以公开美元标价计算，非实际账单核销。

- 当前方式：`2349 × 0.00015 + 155 × 0.00018 = $0.38025`。
- 方案一（已缓存ID、时间线取帖）：`2349 × 0.00015 = $0.35235`；相同规模每日一次30天为`$10.57050`。首次初始化ID、正文补取、额外分页和重试未计。
- 方案二的条件算例：假设时间搜索恰好返回与今日新增入库相同的263条，78个账号有结果，77个账号空结果，每账号一次请求，无额外重叠/补查，则`263 × 0.00015 + 77 × 0.00015 = $0.05100`。它不是已执行搜索的实际费用，新增入库也不等于按发布时间搜索必然返回的数量。加上每月4次、每次规模等于今日2,349条的时间线核查，则30天为`0.051 × 30 + 0.35235 × 4 = $2.93940`，日均`$0.09798`。核查当天为`$0.40335`。核查分页、重叠与重试另计，最新页核查不能保证完整补回所有历史漏帖。
- 方案三：155账号Stream套餐为`$309/月`；按30天摊销`$10.30/天`。只用一天仍需购买月套餐，不能按日支付；REST补查另计。

方案二含上述核查的月算例相对方案一节省约72.2%；单次普通增量算例相对方案一约节省85.5%。这些节省幅度依赖查询返回与本文假设一致，不能作为生产承诺。所有方案均未包含AI、外链正文、字幕/转写及税费。

## 费用比较补充与用户决策状态

用户要求先综合接口能力与费用，再决定采集范围，尚未选定“只取当天”或“上次成功位置之后”。

今日完成轮次中，155 个 X 信源扫描 2,349 条，另 19 条是 RSS。按公开标价，若这些 X 返回条目全部由首选 TwitterAPI.io 计费，时间线费用约 $0.35235，155 次账号信息查询约 $0.0279，合计约 $0.38025。这是运行计数估算，不是账单；额外详情、备用供应商、失败请求及折扣未计入。

假设某轮时间窗搜索恰好返回 263 条、155 个账号各一次成功请求且无需翻页，按帖子数收费并给空结果补最低费，费用约 $0.03945—$0.06270。263 是本轮新入库量，仅用于情景比较，并不等于时间过滤必然返回的数量；重叠补漏、分页、失败重试和对账会增加费用，不能将此区间视为上线费用承诺。

两方案均另有正文补全及 AI 分析/翻译费用。增量扫描主要减少重复接口费用；已有内容已去重跳过，不应据扫描量下降比例推算 AI 费用也同比下降。最终选择还需小范围对照搜索覆盖完整性与真实扣费。

核查日期：2026-11-02。范围为只读代码、正式安装包和公开官方文档；没有调用付费数据接口，没有更改正式配置。以下价格为公开美元标价，不是账户实际扣费核对。

## 现状与证据

- 正式配置 `~/.qiushui-airadar/production-data/config/providers.yaml` 的 `routes.x_list` 是 `twitterapi.io` 优先、`tikhub-x` 备用。`apps/service/src/single-table-provider.ts:142-181` 顺序尝试供应商。
- 每次扫描一个账号，先请求 `GET /twitter/user/info?userName=...` 查用户 ID，再请求 `GET /twitter/user/tweet_timeline?userId=...`。见 `packages/source-adapters/src/index.ts:1019-1069`。
- 虽然适配器支持 `cursor`，正式单表入口只传信源与 `limit`，没有传上次位置；返回值也丢弃 `nextCursor`。见 `apps/service/src/single-table-provider.ts:162-173,254-259`。
- `last_seen_content_id` 与 `last_collected_at` 处理后被保存，但没有用于当前发现请求。见 `apps/service/src/collect-single-table.ts:150,324-334`。因此当前做法是重新扫描最新一页，再按数据库已有身份去重；不是供应商端按上次时间增量。
- 正式安装包 `~/.qiushui-airadar/program/lib/node_modules/@qiushui-airadar/cli/dist/cli.js:41400-41460,42760-42795,42865-42872,43440` 抽查一致，不只是本地未发布代码的判断。

## 一次取 5 条是否比 10 条便宜

TwitterAPI.io 当前公开计费：timeline 和 advanced search 均按供应商实际返回的帖子数收费，每条 15 credits，即 $0.00015；每次调用最低 15 credits，空结果也收费。5 条 $0.00075，10 条 $0.0015，20 条 $0.003。用户信息查询另收每次 18 credits，即 $0.00018。来源：[官方按接口价格明细](https://twitterapi.io/pricing/details)。

但当前 timeline 官方只提供 `userId`、`includeReplies`、`includeParentTweet`、`cursor`，最多 20 条一页，没有文档化 `count/limit` 或时间过滤参数，默认不包含回复。内容顺序与 X 用户主页一致。来源：[官方 timeline 文档](https://docs.twitterapi.io/api-reference/endpoint/get_user_timeline)。

本项目的 `limit` 是响应收到后执行 `limitItems(...)` 截断（`packages/source-adapters/src/index.ts:1060-1063`），因此把本地条数改成 5，不能让已返回 20 条的调用按 5 条收费，还可能漏掉本应处理的新内容。不能把减少本地处理条数等同于减少接口账单。

## 能否只取今天或上次之后

高级搜索 `GET /twitter/tweet/advanced_search` 支持 `query=from:账号 since_time:起始Unix秒 until_time:结束Unix秒`，配 `queryType=Latest`，并用 cursor 翻页；每页最多 20 条。官方当前明确不支持旧的 `since:日期_时间_UTC`/`until:日期_时间_UTC` 写法。来源：[官方高级搜索文档](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search)。

建议设计：按账号保存“已完整发现并可靠入库的时间窗口”，本轮开始固定结束时间，从上轮成功窗口稍前开始查询；全部页成功保存后才推进窗口。重复重叠通过帖子身份去重。发现与正文补全、翻译、AI 分析分开，后续失败进入独立重试，不能让一条分析失败阻止采集进度，也不能在数据未保存时推进。

不能直接拿当前 `last_collected_at`（全部处理结束时间）作下轮起点：扫描结束到处理结束之间可能又有新帖，直接跳到处理结束时间会漏掉。只取“今天”也会漏掉停机期间和跨日未扫描内容。按上次可靠窗口补齐更适合持续雷达。

搜索方案仍需与 timeline 小范围对照：索引延迟、删除/私密、转发与回复口径、置顶及分页边界均可能影响覆盖，不能保证搜索绝对无漏抓。建议保留重叠窗口与周期性对账；窗口大小由验证决定。cursor 是分页工具，不能直接把旧时间线游标当作“从此之后”的实时增量位置。

## 优化顺序与限制

### 今日正式运行证据

正式 `collection-run.json` 中运行 `3fc280d1-ca91-4791-9847-b417ae8ae23d`，开始 `2026-11-02T01:59:21.430Z`、结束 `2026-11-02T02:59:10.763Z`，即北京时间 09:59—10:59，耗时 3,589.333 秒（59.82 分钟）。配置按 `platform` 核实为 155 个 X 信源、1 个 RSS 信源。扫描 2,368 条，其中本轮新处理成功 209、已有完成 1,575、失败 53、跳过 531。SQLite 同运行时间范围按 `first_inflow_at` 统计新增入库 263 条，全为 X 内容。“新增入库”“扫描”“新处理成功”是不同指标，不能相互替代。

主线代理按 `runtime-log-summaries.jsonl` 同时间段提供的阶段汇总：classify 224 次共 712.19 秒；score 196 次共 894.67 秒；translate 成功 142 次共 1,198.09 秒，失败 15 次共 75.01 秒。合计 2,879.96 秒，约 48 分钟，相当于总耗时 80%。另外有 28 条等待手工转写，以及 15 次翻译 JSON 解析失败。剩余约 11.82 分钟包含列表接口、正文补全、重试和本地 IO，不能全归因于 Twitter 接口慢。这是日志累计时长归因，未增加生产探针；后续仍应增加独立阶段计时。

因此优先级应同时覆盖增量扫描与串行 AI 处理；“200 条几分钟完成入库”与“200 条全部翻译、分析结束”是不同验收目标。并发 3—5 只是可验证的起点，不是实测完成时间或 SLA。

1. 先补永久运行明细：记录扫描请求耗时、返回条数、新增数、翻译/分析耗时、重试次数，才能分别衡量接口效率与完整处理效率。
2. 缓存账号 user ID，避免每轮重复查资料；改为文档支持的 `last_tweets?userName=...` 也能省前置查询，但仍会返回旧内容且不支持时间参数，需要验证语义。来源：[官方 last_tweets 文档](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets)。
3. 试验时间窗高级搜索，补齐分页和可靠进度，减少重复返回计费；不得只改本地 `limit` 为 5。
4. `collectSourcesSerially` 的信源循环与逐条处理均串行（`packages/pipeline/src/single-table-collector.ts:133-162`）。受控并发与发现/处理解耦可缩短等待，但并发数量需结合模型和供应商限流验证；仅凭条数无法承诺几分钟完成翻译分析。

备用 TikHub 路径为 `/api/v1/twitter/web/fetch_user_post_tweet`，代码传 `screen_name` 和可选 `cursor`（`packages/source-adapters/src/index.ts:1387-1423`）。官方目录能找到[获取用户发帖](https://docs.tikhub.io/191321711e0)，但本次详情抓取超时，未确认其 count、时间过滤和端点当前价格；不得套用 TwitterAPI.io 的单价给 TikHub 估账。

## 补充：Stream 与规则推送、订阅与充值（截至 2026-11-02）

### 两种推送机制不能混算

**Twitter Stream 账号监控**使用 `/oapi/x_user_stream/add_user_to_monitor_tweet` 添加账号，覆盖原创、转发、引用、回复。按账号包月，Stream FAQ 明确不按送达帖子另收费。155 个账号按公开 Enterprise 档 150 个/$299，加 5 个×$2，合计 **$309/月**；$1/账号/月的宣传价对应 500 账号/$499 的 Enterprise Plus，不是155个账号的报价。两种送达方式为 Webhook 或 WebSocket。官方说明初始化通常20分钟，部分账号先走普通通道；不能把宣传延迟当成每条保证。来源：[Stream产品与套餐](https://twitterapi.io/twitter-stream)、[添加监控账号接口](https://docs.twitterapi.io/api-reference/endpoint/add_user_to_monitor_tweet)。

**Tweet Filter Rule 规则推送**使用 `/oapi/tweet_filter/add_rule` 与 `update_rule`。供应商按 `interval_seconds` 运行搜索，匹配结果通过 Webhook/WebSocket 推送；按匹配返回的帖子收费，每次规则检查最低 $0.00015。它与账号包月 Stream 可同时使用，并非同一计费产品。`value`最长255字符，可用 `from:a OR from:b`；新增默认不启用，需要 update 激活。来源：[添加规则端点](https://docs.twitterapi.io/api-reference/endpoint/add_webhook_rule)、[更新规则端点](https://docs.twitterapi.io/api-reference/endpoint/update_webhook_rule)、[官方规则计费说明](https://twitterapi.io/blog/twitter-monitoring)。

按正式155个账号当前 handle，脚本仅拼接 `from:handle OR ...`、每组最多255字符，得到12组（字符串长度依次255、250、245、244、241、232、247、250、238、255、241、138；尚未加括号或过滤词）。不能把155个账号全部按“一条规则每分钟检查=$6.48/月”计算。加过滤词后可能需要更多组。这里只算能否装进字符上限，未调用付费接口验证全部查询可用性。

### 155账号、每天约200条新帖的扫描费比较

以下为30天、美元公开标价，仅算取帖；不含正文/字幕补取、AI、服务器、税费、补扫、重叠去重及重试。模型假设本月供应商实际返回6,000条新帖；若重复返回也会计费。每次计费为 `max(1,返回帖子数) × $0.00015`，最低费不是在每条费用上再固定叠加一次。

| 方式 | 无结果时的检查费下限/月 | 200条/天的估算或说明 |
| --- | ---: | --- |
| 每账号每日一次时间窗 REST，155账号 | $0.6975 | 返回6,000条为$0.90，叠加空调用后理论约$0.90—$1.60；额外分页、重叠和回补另计 |
| 12组规则，每5分钟检查 | $15.552 | 理论约$15.55—$16.45；仍需核实忙时分页及重试覆盖 |
| 12组规则，每60秒检查 | $77.76 | 理论约$77.76—$78.66 |
| 155账号 Twitter Stream | 不按检查次数计 | $309/月账号包月；其余REST补查另计 |

规则端点允许最大86,400秒，但**不能仅凭可设置24小时就认为它会完整回补一天全部帖子**：规则的回看窗口、最大匹配数、分页/漏投后重放尚未核实。不把理论12组每日一次的$0.054最低费当成可用方案报价。用户只要求每日一次时，优先可由本系统明确控制时间窗口和分页的REST，推送没有必要的时效收益。

### 按量充值与API订阅不是Stream套餐

[当前充值页](https://twitterapi.io/payment) 最低公开展示档位是 $10/100万credits；这是充值预付款，不是每月最低消费。[价格页](https://twitterapi.io/pricing) 写无月度最低消费、付费充值本金不失效。免费赠送最高$1但有资格限制、31天失效。

[API credits订阅页](https://twitterapi.io/subscribe) 为 Starter $29、Builder $99、Pro $199、Scale $499、Business $1499/月，提供credits和奖励，与Stream按账号套餐不同。对每日一次、预计每月少量美元采集费用，按量充值更匹配，无需为提高到20QPS买月包：[官方限流页](https://docs.twitterapi.io/rate-limits) 明确从未充值账号0.2QPS，任意充值过的账号20QPS，Scale50、Business500。实际账户曾否充值与有效限流仍需账户侧验证，本报告没有访问账单。

### 已发现官方资料差异及未核实项

- 新增规则文档最小间隔0.05秒，更新规则文档却写0.1秒；两者均最大86,400秒。保守实现不依赖低于0.1秒，且本任务无需亚秒轮询。
- `/payment` 的旧 $99月包写1000万基础credits+5%，`/subscribe` 新 Builder $99却为990万基础+14%。不能混用奖励计算，购买前按实际结账确认。
- [官方analytics文章](https://twitterapi.io/blog/twitter-analytics-free-api-guide) 举$5充值例子，但当前支付页最低展示$10；本次未确认是否存在$5自定义充值。
- 规则相关营销文章有“每次检查最低费加每条费”的简化表述；按明细页与官方按有/无结果分开演算的[监控教程](https://twitterapi.io/blog/how-to-monitor-twitter-accounts-for-new-tweets-in-real-time)，应按每次最低费模型估算，实际账单复核。
- 规则文档新增/更新页未完整说明每次检查最大返回量、积压分页、送达确认与持久重试；[官方Discord教程](https://twitterapi.io/blog/twitter-to-discord-bot)称Webhook超时1秒且不重试。适用当前账户/产品范围未实测，必须保留REST对账回补，不能把Webhook推送视作可靠入库。
- WebSocket连接规则页本次抓取失败，未验证连接数量、重连、离线补发保证。任何推送方案还需持续运行的接收服务；当前只每日采集的桌面使用方式不能自动等同于全天在线。

## 补充：主线核查的REST方法全表与三个方案

本表合并主线代理同期核查结果。以[官方价格明细](https://twitterapi.io/pricing/details)、[机器价格JSON](https://twitterapi.io/pricing.json)和各端点参数文档为依据；同一账号新旧帖子只要再次返回仍可能再次收费。

| 获取方式 | 请求方式与关键限制 | 公开计费/适用性 |
| --- | --- | --- |
| 用户时间线 | `/twitter/user/tweet_timeline`，userId、includeReplies、includeParentTweet、cursor；每页最多20，无时间过滤 | $0.00015/返回帖；最低$0.00015/请求；需本地去重、按可靠边界补页 |
| 最近帖子 | `/twitter/user/last_tweets`，userId或userName、includeReplies、cursor；最多20/页，按created_at排序，无时间过滤 | 同上；username可省一次profile查询，缓存ID更稳定 |
| 时间窗搜索 | `/twitter/tweet/advanced_search`，query内from+since_time/until_time、queryType=Latest、cursor；最多20/页 | 同上；适合按上次可靠窗口增量，需重叠和对账 |
| X列表时间线 | `/twitter/list/tweets_timeline`，listId、cursor，无时间参数 | 取帖按返回帖计价；需创建维护X名单并验证成员覆盖与帖子语义；不能把列表成员管理接口的固定价混用于取帖 |
| 指定帖子ID详情 | `/twitter/tweets`，tweet_ids，最多50 IDs/次 | pricing.json特别说明按请求的ID数量计费；不能将已删/无返回的ID当作免费。适合已知ID补取，不负责发现新帖 |
| X Article正文 | `/twitter/article`，tweet_id | $0.001/次，与取帖费分别计算 |
| Bulk advanced search | 价格JSON列`/twitter/tweet/bulk_advanced_search`，但本次llms索引和OpenAPI未提供清楚可用契约 | 子查询各自有最低费，没有已证实的省钱机制，不建议作为首选实现依赖 |

参数来源：[timeline](https://docs.twitterapi.io/api-reference/endpoint/get_user_timeline)、[last tweets](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets)、[advanced search](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search)、[list timeline](https://docs.twitterapi.io/api-reference/endpoint/list_timeline)、[tweet IDs](https://docs.twitterapi.io/api-reference/endpoint/get_tweet_by_ids)、[article](https://docs.twitterapi.io/api-reference/endpoint/get_article)。

timeline文档另说明X大约只提供用户最近3,200条，不能无限翻页还原全部历史。该页引导搜索时沿用`since:/until:`，与搜索端点文档当前建议`since_time:/until_time:`有差异；实现以具体搜索端点文档为准并验证。

三方案估算统一用30天、155博主，主线从今日扫描分出X返回2,349条、新增入库263条作示例；这是单日外推场景，不是未来月账单预测。价格不含AI、翻译、正文/字幕、税费、服务器和供应商回退。

| 方案 | 做法 | 示例月度取帖费 | 优缺点 |
| --- | --- | ---: | --- |
| A 缓存ID、时间线取帖 | 缓存ID省资料查询，仍按每账号时间线发现，补齐分页 | 2,349×$0.00015×30＝$10.57；额外分页另计 | 接口语义变化小，但仍为旧帖付费；不能只取5条截断 |
| B 时间窗增量＋周期核查（推荐） | 每账号从上次可靠窗口取新帖，设重叠，分页可靠保存，每周用时间线对账回补 | 每天返回263条场景$1.18—$1.88/月；4次全量当前页核查约$1.41，合计$2.59—$3.29；给重叠和补漏预留后可暂预算$3—5/月，未经实测 | 最匹配每日采集，低费用；搜索覆盖与转发、延迟索引仍须验证，增量可靠进度改造工作较多 |
| C 账号包月实时Stream | 155账号持续推送，另配离线对账回补 | 公开账号套餐$309/月，REST补查另计 | 秒级时效、无需反复轮询；对每日一次需求成本高，接收端需全天在线 |

B的$1.18—$1.88为263×30×$0.00015=$1.1835，再给每账号每日一次最多4,650个空调用预留$0.6975的保守上界；不是最低费和所有成功调用重复叠加。核查每次2,349×$0.00015=$0.35235，4次$1.4094；若核查加翻页或返回更多内容，还会增加。A/B均需同步解决AI各阶段串行处理，才能缩短用户看到“全部完成”的等待时间。单独替换Twitter接口不会自动消除约48分钟的AI阶段耗时。
