# TikHub：抖音、小红书、视频号的视频文字与媒体获取途径（2026-09-16）

范围：核对 TikHub 官方公开文档、本项目源代码和本机现有验收数据（只读）；未调用计费接口，也未下载或转写真实媒体。此文中的“文案/描述”指发布者写的文字，不等于视频里说话的逐字字幕。

## 一句话结论

公开文档中，YouTube 有专门的字幕接口；**未查到 TikHub 针对抖音、小红书、视频号的独立字幕/语音转写接口**。但三个平台都有获取视频播放媒体的途径；要得到视频里的讲话文字，可能需要另行下载视频、提取声音、做语音识别。这是技术方案推断，不代表已经在本项目实测成功。YouTube 字幕接口也只取视频已有字幕，不负责 AI 转写。[YouTube 视频字幕官方文档](https://docs.tikhub.io/431829301e0)

| 平台 | 发布文案/描述 | 视频媒体 | 单独音频/讲话字幕 |
| --- | --- | --- | --- |
| 抖音 | 搜索结果明确含 `desc` | 作品详情/搜索结果含播放地址；另有最高画质接口 | 官方公开资料未确认独立音频或讲话字幕接口；`music.play_url` 是背景音乐，不是讲话录音 |
| 小红书 | 笔记详情含文字数据（字段路径须用真实响应确认） | App V2 视频笔记详情明确返回视频播放地址 | 官方公开资料未确认独立音频或讲话字幕接口 |
| 视频号 | 作品详情有描述等数据 | V2 作品详情明确返回媒体 URL、Token、解密密钥 | 官方公开资料未确认独立音频或讲话字幕接口；视频可能加密，不能把 HTTP 200 当成可直接转写 |

## 抖音

1. 已有 `aweme_id`：`GET /api/v1/douyin/app/v3/fetch_one_video?aweme_id=...` 可取单个作品（视频/图文）详情；如果 App 返回空，官方提示可尝试 Web 版 `GET /api/v1/douyin/web/fetch_one_video?aweme_id=...`。空响应也可能是版权、删除、私密、部分可见等原因，需查 `$.data.filter_list[0].reason`，不是一律重试。[App V3 单作品详情](https://docs.tikhub.io/186826219e0)、[Web 单作品详情](https://docs.tikhub.io/186826141e0)
2. 官方综合搜索响应说明了 `desc`（作品描述文字）、`video.play_addr.url_list`（视频播放地址）、`video.download_addr.url_list`（带水印下载地址），另有 `music.play_url.url_list`（背景音乐播放地址）。**背景音乐不等于整条视频的人声**。[抖音综合搜索 V1](https://docs.tikhub.io/370212773e0)
3. 如常规地址不可用，官方还有 `GET /api/v1/douyin/app/v3/fetch_video_high_quality_play_url?aweme_id=...`，返回 `original_video_url` 等信息；文档标价 **US$0.005/次**，不宜未经成本评估批量调用。[最高画质播放链接](https://docs.tikhub.io/312096107e0)

## 小红书

1. 先分辨图文笔记与视频笔记。`GET /api/v1/xiaohongshu/app_v2/get_image_note_detail` 可取两种类型，但视频笔记在此接口中**只有封面，没有视频播放链接**。若类型为 `video`，再用相同 `note_id` 调用 `GET /api/v1/xiaohongshu/app_v2/get_video_note_detail?note_id=...`；也可用分享文本 `share_text`，二者同时存在时优先 `note_id`。该接口文档明确写返回视频播放地址、封面、作者和互动数据。[视频笔记详情官方文档](https://docs.tikhub.io/420136392e0)
2. 官方页面的公开成功示例 `data` 为 `null`，因此它**没有承诺视频播放地址的精确 JSON 路径**。落地前要用一条脱敏真实响应确认路径、地址可访问性及有效期，不能凭猜测写死字段。[视频笔记详情官方文档](https://docs.tikhub.io/420136392e0)
3. 官方提醒：错误/不存在的笔记 ID 仍可能得到正常外层响应，内层 `data` 才是上游“服务异常”，且**仍计费**。因此不能把 HTTP 200 视为成功。[视频笔记详情官方文档](https://docs.tikhub.io/420136392e0)

## 视频号

1. 已有作品 `object_id`、搜索结果 `exportId` 或分享链接时，用 `POST /api/v1/wechat_channels/v2/fetch_video_detail`。请求字段分别是 `object_id`、`export_id`、`share_url`，优先级 `object_id > export_id > share_url`；搜索产生的 `export_id` 会过期，要尽快转成作品详情/稳定 ID。[视频号作品详情官方文档](https://docs.tikhub.io/472974842e0)
2. `raw=false` 的媒体字段：`$.data.media.url`（CDN 地址）、`$.data.media.url_token`（Token）、`$.data.media.full_url`（完整媒体 URL）、`$.data.media.decode_key`（视频解密密钥）。官方明确提示：链接 HTTP 200 **不等于视频能播放**；MP4 可能加密，必须用与下载文件来自**同一次 API 响应**的 `decode_key` 解密，因为每次请求会给新的链接和密钥。[视频号作品详情官方文档](https://docs.tikhub.io/472974842e0)
3. 因此视频号的可行路径是“取详情 → 同次响应保存媒体 URL 和解密密钥 → 下载 → 必要时解密 → 提取声音 → 语音识别”。这是基于官方媒体说明的**待验证实现路径**，不能描述为现有项目已打通。[视频号作品详情官方文档](https://docs.tikhub.io/472974842e0)

## 需要真实验证的边界

- 这三个平台的公开接口目录及上述详情页未确认可直接返回视频里讲话的字幕；这只能表述为**未找到/未证实**，不能断言 TikHub 所有产品永远没有该能力。
- 视频 URL 的真实可访问性、有效期、下载/解密成功率、是否含可用人声，需要逐平台各选一条当前项目内容进行脱敏最小验证；本次没有调用计费接口。
- 若后续要做语音识别，需另行选择转写服务/本地模型，并评估平台内容使用权限、费用、视频大小与失败重试。TikHub 的播放地址本身不是逐字文字。

## 本项目代码与当前数据：为什么现在仍为空

以下是本项目实现与 **2026-09-16 本机验收数据** 的核对结果，不代表 TikHub 接口本身不可用。现有数据为历史快照；状态、条数与媒体地址都可能变化。

1. **YouTube：有字幕接口，但自动采集流程没有走到它。** [源适配器](../../packages/source-adapters/src/index.ts)已有 `createTikHubYouTubeTranscriptProvider()`，会先用 `/api/v1/youtube/web_v2/get_video_captions` 查询字幕语言，再按语言取 `txt` 正文；[补全函数](../../packages/pipeline/src/index.ts) `enrichYouTubeContent()` 也能保存取回的字幕。然而，同一文件中的 `runPlatformDiscovery()` 在发现视频时，若未随发现结果自带字幕且自动转写关闭，就直接标成 `waiting-manual-transcription`；它只给 `pending` 内容建立补全任务。这使 [后台的 YouTube 字幕调用分支](../../apps/service/src/index.ts)无法在正常自动流程中触发。当前 29 条 YouTube 内容有 28 条正文为空并处于待人工转写；这**不能推断** TikHub 已查询并确认这些视频没有字幕。另一个缺口是：官方要求对大视频返回的异步 `job_id` 调用 `/get_video_captions_result`，当前字幕适配器只返回 `processing`，没有实现该结果查询。[TikHub 字幕文档](https://docs.tikhub.io/431829301e0)
2. **抖音、视频号：代码能记录媒体地址，但不会把简介冒充字幕。** [中文平台适配器](../../packages/source-adapters/src/chinese-platforms.ts)读取抖音 `play_addr`/`download_addr`，以及视频号 `media.full_url`/`media.url`；同时将发布文案放在 `sourceText`，将字幕标为 `missing`。在当前数据里，可见抖音和视频号样本已保存视频地址，但正文仍为空，因自动转写默认关闭而处于待人工转写。保存的 CDN 地址不等于长期可访问的视频文件；视频号还可能需要同次响应的 `decode_key`，当前适配器未保存或执行解密。[TikHub 视频号详情](https://docs.tikhub.io/472974842e0)
3. **小红书：当前视频地址提取链路不完整。** [小红书适配器](../../packages/source-adapters/src/chinese-platforms.ts)从用户笔记列表读取视频信息，并尝试在 `video_info_v2` 的几个字段中找 URL，但没有调用官方专门的 `get_video_note_detail`。该官方接口明确可返回视频播放地址，但公开文档未承诺精确字段路径；需要脱敏真实响应校验。当前检查的一条小红书视频，只有标题和文案，未保存媒体 URL。[TikHub 视频笔记详情](https://docs.tikhub.io/420136392e0)
4. **语音转写并未自动开启。** [后台配置](../../apps/service/src/index.ts)允许通过 `QIUSHUI_AIRADAR_TRANSCRIBER_URL` 接入转写服务，抖音另有 Get笔记转写路径；但本机验收数据的任务参数里 `transcription.auto=false`。即使取得视频 URL，也还需要可用的转写服务、有效媒体文件和实际任务调度，才能生成逐字正文。

本机接口复核的空正文数量：YouTube **28/29**、抖音 **28/29**、视频号 **12/13**、小红书 **5/6**（其中 4 条视频待转写，另 1 条图文处理失败）。这里没有改动已有内容或触发收费接口。
