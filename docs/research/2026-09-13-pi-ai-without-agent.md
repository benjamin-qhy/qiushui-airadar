# Pi 仅用于多模型接入的可行性调研

> 日期：2026-09-13
>
> 目标：确认 qiushui-airadar 能否只使用 Pi 的统一多模型能力，而不引入 Pi Agent 或 Skill 运行时。

## 结论

**可以，而且适合 qiushui-airadar 当前阶段。**

只安装和使用 `@earendil-works/pi-ai` 即可统一调用多家模型；不需要安装 `@earendil-works/pi-agent-core`，也不需要启动 Agent 循环或加载 Skill。Pi 官方仓库本身把两者发布为独立包：`pi-ai` 是统一多供应商 LLM 接口，`pi-agent-core` 是建立在 `pi-ai` 之上的 Agent 运行时。

推荐把项目中的“Pi”精确定义为：**使用 `@earendil-works/pi-ai` 作为模型接入层，不使用 Pi Agent 与 Skill。**

## 一手证据

### 1. `pi-ai` 是可以单独安装的独立包

Pi 官方 README 将 `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core` 列为两个不同包；前者负责统一多模型接口，后者才负责 Agent 状态和工具循环。[Pi 官方仓库包说明](https://github.com/earendil-works/pi#all-packages)

`pi-ai` 自己拥有独立的包入口、版本和依赖，官方安装命令是：

```bash
npm install @earendil-works/pi-ai
```

证据：[pi-ai package.json](https://github.com/earendil-works/pi/blob/main/packages/ai/package.json)；[pi-ai README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#installation)

反方向的依赖关系也很清楚：`pi-agent-core` 把 `pi-ai` 列为依赖，而 `pi-ai` 不依赖 `pi-agent-core`。因此 Agent 是可选的上层能力，不是模型调用的必需部分。[pi-agent-core package.json](https://github.com/earendil-works/pi/blob/main/packages/agent/package.json)

### 2. 不用 Agent 也能直接调用模型

`pi-ai` 提供 `createModels()`、`models.stream()`、`models.complete()` 和简化版 `completeSimple()`。应用自行选定供应商和模型后，可以直接完成一次请求，不需要创建 Agent。[官方 Quick Start](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#quick-start)；[统一调用接口](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#unified-interface-streamsimplecompletesimple)

这与 qiushui-airadar 的高频任务吻合：程序固定传入一条内容和一个版本化任务说明，模型返回结果，TypeScript 校验并保存。

### 3. 已覆盖大量供应商，也支持兼容接口

官方当前内置 OpenAI、Anthropic、Google、DeepSeek、Mistral、Groq、xAI、OpenRouter、Amazon Bedrock、Moonshot/Kimi、MiniMax、ZAI、Qwen、Xiaomi MiMo 等供应商，还支持任何 OpenAI-compatible 接口，例如 Ollama、vLLM 和 LM Studio。[官方供应商列表](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#supported-providers)

对没有内置名称、但兼容 OpenAI 或 Anthropic 协议的厂商，可以用 `createProvider()` 配置身份、地址、认证和模型表，不必从头实现完整协议。[官方自定义供应商说明](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#createprovider)

需要注意：Pi 能大幅减少接入工作，但不能保证世界上每一家厂商都零配置可用。采用独有协议、与标准兼容性较差的厂商，仍可能需要一个小型适配器和兼容性测试。

### 4. 认证、模型目录、Token 和费用已统一

每个 Pi provider 负责自己的模型目录和认证解析；应用可以注入 `CredentialStore` 保存凭证，也可以通过环境变量或调用参数提供密钥。[Provider 与模型](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#providers-and-models)；[Credential Store](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#credential-store)

返回消息包含统一的输入、输出 Token 和费用数据，可直接用于 qiushui-airadar 的调用审计、每日预算和供应商对比。[Quick Start 中的 usage/cost](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#quick-start)

### 5. 结构化结果不需要 Agent

`pi-ai` 支持 TypeBox 工具参数 schema，并提供 `validateToolCall()` 做运行时校验。[工具定义](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#defining-tools)；[参数校验](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#validating-tool-arguments)

qiushui-airadar 可以把“提交分析结果”定义成一个**不执行外部动作**的结构化输出工具，让模型一次返回分类、摘要、分项分和理由；程序只读取并校验参数，不进入 Agent 工具循环。也可以要求模型输出 JSON 后再用项目 schema 校验，但前一种方式对不同供应商更统一。

## 推荐接入方式

```text
qiushui-airadar Worker
      |
      v
ModelGateway（项目自己的小接口）
      |
      v
@earendil-works/pi-ai
      |
      +--> OpenAI
      +--> Anthropic
      +--> Google
      +--> DeepSeek
      +--> 国内兼容供应商
      +--> OpenRouter / 本地模型
```

项目只让一个深模块接触 `pi-ai`：

- 上层 AI 任务只提交任务类型、内容、Prompt/画像版本和模型策略；
- 模块内部负责选择 provider/model、认证、超时、失败切换、统一用量、响应解析和审计；
- 业务代码不直接导入各厂商 SDK，也不读取厂商专有响应结构；
- 测试使用 `pi-ai` 官方的 faux provider，不产生真实费用。[Faux Provider](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#faux-provider-for-tests)

## 不使用 Agent 后失去什么

不使用 `pi-agent-core` 后，不会自动获得：

- 多轮自主推理和工具选择；
- Agent 会话状态管理；
- Skill 加载；
- 模型自行决定下一步行动。

这些能力当前都不是 qiushui-airadar 的需要。系统处理步骤、重试、去重、状态变化和副作用已经明确应由 TypeScript 控制，因此去掉 Agent 反而更简单、更快、更省 Token。

## `pi-ai` 也不会替项目完成什么

以下仍由 qiushui-airadar 自己负责：

- 持久化任务队列、幂等、跨进程恢复和业务重试；
- 按项目规则进行多模型排序、故障切换和预算熔断；
- Prompt、画像、任务 schema 和结果版本化；
- 对模型结果做业务校验并写入数据库；
- Web 可视化配置、密钥保护和审计查询。

`pi-ai` 解决的是“不同模型怎样统一调用”，不是整个内容处理系统。

## 风险与控制

1. `pi-ai` 当前只收录支持 tool/function calling 的模型；本项目选型时应过滤掉不支持结构化工具调用的模型。
2. Pi 迭代较快，应锁定精确版本，升级前运行所有 provider 契约测试；本次核验的官方 `main` 包版本为 `0.85.1`。[pi-ai package.json](https://github.com/earendil-works/pi/blob/main/packages/ai/package.json)
3. 只注册实际启用的 provider factory，不导入 `providers/all`，可减少启动和打包负担。官方说明各供应商实现会延迟到首次调用时加载。[Provider Factories](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#provider-factories)
4. Pi 的费用字段依赖模型目录中的价格信息；系统应同时保留供应商原始 usage，不能把估算费用当成最终账单。

## 最终建议

qiushui-airadar 本期采用：

- **使用**：`@earendil-works/pi-ai`；
- **不使用**：`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、运行时 Skill；
- **项目自建**：一个很薄的 `ModelGateway` 接口和较深的实现，统一封装模型选择、结构化输出、故障切换、用量、审计与测试；
- **保留未来入口**：只有以后出现真正需要多轮工具推理的功能，再单独评估 Agent，不提前引入。
