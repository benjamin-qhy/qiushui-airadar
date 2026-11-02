# 正式版 X 信源初筛（2026-10-28）

> 只读核查；**未修改正式信源**。本报告给出可审阅候选，不把一次抓取的模型分数当作账号质量定论。

## 范围与口径

- 正式配置共有 **155 个 X 账号，全部启用**。近两天（北京时间 10 月 27–28 日）这些账号入库 **2111 条**，其中 **139 个账号有样本**；另有 16 个账号没有这两天的样本。另有已从配置删除的 `x_dotey` 历史记录 39 条，故数据库中该窗口 X 内容合计 2,150 条。
- “高信号”仅指已完成处理、未被判垃圾、当前评分 ≥60 的记录，是辅助指标；平台公告、短帖和原帖引用常被打低分，人工复核优先。最近两天包含首次抓取回填，不能当作稳定日均量。
- 表中“用途”按当前信源分类映射：企业=企业决策者账号；爱好者=技巧、资源、开源项目或创业账号；技术=本人学习。一个账号可能覆盖多个用途。表中“样本”从近期非垃圾已处理内容中选一个高分题目，仅用于定位，**不是**该账号整体代表作。
- “重点保留”表示主题贴合且目前有独特来源或高质量样本；“观察”表示需要更长窗口或人工抽样；“停用候选”表示目前噪音/重复/偏题迹象明显，需用户确认后再改配置。无样本者一律不据猜测停用。

## 直接值得看的发现

- **企业决策者**：Aaron Levie 有企业 AI 评测、部署层、部门 FDE、AI 预算和衡量体系等原帖；LangChain 有 Box/Snyk 的企业 Agent 案例；Dion Hinchcliffe 有行业深耕、基础设施采购与供应商风险内容。企业账号的最终稿应回溯原始报告或公司公告验证数字。
- **爱好者与资源**：Akshay Pachaar 的近期样本集中在 Agent 记忆、MCP Apps 框架、开源后端、知识图谱；mem0、Dify、n8n.io、Langflow 的实际产品和工程内容更可用于做可操作教程。
- **技术学习**：Sebastian Raschka 的从零推理、RLVR、蒸馏系列连续且有技术深度；DeepLearning.AI 给出课程/研究解读，LangChain/LlamaIndex 可跟踪 Agent 工程。
- **重复转发**：当前配置账号的 2,111 行 X 记录只有 2,067 个唯一原帖 URL，额外 44 行来自跨账号重复。EP/vas 重合 6 条，Machina/vas 4 条，Garry Tan/Y Combinator、Harrison Chase/LangChain 各 3 条。纯转发集中账号优先人工复核。
- **明显噪音样例**：AI Breakfast 近期 14 条已完成内容均被系统判垃圾，包含单个短链接、泛泛感叹；AgentOps 20 条中 16 条判垃圾，很多是反复的“本周 Agent 新闻汇总”；Kyle Balmer 19 条已完成内容中 18 条判垃圾，近期多为零散评论。模型垃圾判断不能单独定案，但这些样本值得优先停用审查。
- **候选规模**：20 个停用候选在本次窗口贡献 352 条入库记录，其中 186 条被判垃圾，只有 3 条达到上述“高信号”条件。这是优先复核顺序，不能据此推算日常节省金额。

## 全部 155 个账号

列：`入库/完成/高信号/垃圾` 为 10 月 27–28 日记录数。`0/0/0/0` 代表本次窗口无样本，不代表账号没有发帖。

| 账号 | 用途 | 建议 | 入库/完成/高信号/垃圾 | 一个近期样本 |
|---|---|---|---:|---|
| [OpenAI](https://x.com/OpenAI) | 企业/爱好者 | 重点保留 | 16/13/1/2 | 认识 GPT-6.1 Terra |
| [Anthropic](https://x.com/AnthropicAI) | 企业/爱好者 | 重点保留 | 16/16/3/1 | 重新设计Anthropic的源代码控制系统 |
| [Andrej Karpathy](https://x.com/karpathy) | 技术 | 重点保留 | 2/2/1/0 | Dusting off this tweet from April … |
| [Ilya Sutskever](https://x.com/ilyasut) | 技术 | 观察 | 1/0/0/0 | I am starting a new company: We wi… |
| [Akshay Pachaar](https://x.com/akshay_pachaar) | 技术/爱好者 | 重点保留 | 13/9/7/1 | GitHub - sandbox-quantum/switch：在 … |
| [Shubham Saboo](https://x.com/Saboo_Shubham_) | 技术/爱好者 | 重点保留 | 16/8/2/5 | GitHub - Shubhamsaboo/awesome-llm-… |
| [LangChain](https://x.com/LangChain) | 技术/爱好者 | 重点保留 | 27/18/3/14 | 我们如何打造自己的设计智能体 |
| [LlamaIndex](https://x.com/llama_index) | 技术/爱好者 | 重点保留 | 13/8/3/2 | NVIDIA Nemotron 3.5 嵌入、重排与解析模型：以世界… |
| [Y Combinator](https://x.com/ycombinator) | 企业/爱好者 | 重点保留 | 46/24/1/21 | 创业点子征集 / Y Combinator |
| [Garry Tan](https://x.com/garrytan) | 爱好者/企业 | 观察 | 43/31/3/17 | Just spent the last 7 days on the … |
| [Aaron Levie](https://x.com/levie) | 企业 | 重点保留 | 20/20/3/6 | At Box, we've been testing Gemini … |
| [Amanda Askell](https://x.com/AmandaAskell) | 企业/技术 | 观察 | 3/3/0/2 | I really like the movie "don't loo… |
| [Peter G. Yang](https://x.com/petergyang) | 爱好者/企业 | 观察 | 22/19/0/15 | 首支专为视频打造的AI代理团队 |
| [Brian Cherny](https://x.com/bcherny) | 技术/爱好者 | 重点保留 | 14/8/1/6 | 如何更有野心：写给模型使用者的人类教程 |
| [Cat Wu](https://x.com/_catwu) | 爱好者/企业 | 观察 | 1/1/0/0 | Claude Duet｜你的个人 AI 助手 |
| [Greg Isenberg](https://x.com/gregisenberg) | 爱好者/企业 | 重点保留 | 12/10/0/7 | Yes, 99.9% of Duo apps look like t… |
| [Alex Lieberman](https://x.com/businessbarista) | 企业 | 观察 | 13/10/2/3 | Experian, a $35 billion business w… |
| [Jason Lemkin](https://x.com/jasonlk) | 企业 | 重点保留 | 20/18/2/5 | 两个AI代理删掉了关键数据：两次都是“计划外的副本”救了我们——你的… |
| [Dan Shipper](https://x.com/danshipper) | 企业 | 观察 | 13/11/1/8 | 自动化之后 |
| [Ethan Mollick](https://x.com/emollick) | 企业 | 观察·无样本 | 0/0/0/0 | — |
| [Allie K. Miller](https://x.com/alliekmiller) | 企业 | 观察 | 11/7/0/3 | Three of the best things to do rig… |
| [Claire Vo](https://x.com/clairevo) | 爱好者/企业 | 观察 | 18/15/1/11 | Most AI prototypes are convincing … |
| [Azeem Azhar](https://x.com/azeem) | 企业/爱好者 | 重点保留 | 20/18/0/7 | Anthropic's customer base has grow… |
| [Tomasz Tunguz](https://x.com/ttunguz) | 企业/爱好者 | 观察 | 20/15/0/7 | Anthropic S-1 分析：七项关键指标对比 |
| [Ben Bajarin](https://x.com/benbajarin) | 企业/爱好者 | 观察 | 20/15/0/8 | 高管访谈：Arm的Mohamed Awad谈智能体CPU |
| [Sarah Guo](https://x.com/saranormous) | 企业/爱好者 | 观察 | 13/10/0/6 | we remain in the autocomplete / ea… |
| [Erik Brynjolfsson](https://x.com/erikbryn) | 企业 | 观察·无样本 | 0/0/0/0 | — |
| [Antonio Grasso](https://x.com/antgrasso) | 企业 | 观察 | 14/9/0/4 | Two patients have the same diagnos… |
| [Dharmesh Shah](https://x.com/dharmesh) | 企业 | 观察 | 20/18/0/12 | I've finally invested in enough un… |
| [Bret Taylor](https://x.com/btaylor) | 企业 | 重点保留 | 16/14/2/6 | 认识 Dots |
| [Kieran Klaassen](https://x.com/kieranklaassen) | 企业 | 观察 | 18/15/1/11 | 复合工程 |
| [Jerry Liu](https://x.com/jerryjliu0) | 技术/爱好者 | 观察 | 16/11/0/11 | congrats kimi! (antonelli not k3.1… |
| [Harrison Chase](https://x.com/hwchase17) | 技术/爱好者 | 重点保留 | 19/15/3/11 | 面向 AI 智能体的上下文工程（智能体记忆）要从检索开始 |
| [Shawn Wang](https://x.com/swyx) | 技术/爱好者 | 重点保留 | 15/10/0/8 | One of the more under-appreciated … |
| [Shreya Shankar](https://x.com/sh_reya) | 技术/爱好者 | 重点保留 | 17/14/0/7 | GitHub - fsdatalab/quail：面向 SQL 中 … |
| [Elad Gil](https://x.com/eladgil) | 企业/爱好者 | 观察 | 18/13/1/9 | 弥合差距 #1——面向自我改进智能体的模拟 |
| [Ben Tossell](https://x.com/bentossell) | 爱好者 | 观察 | 15/11/1/8 | 我想看到我的待办事项 |
| [Aravind Srinivas](https://x.com/aravsrinivas) | 爱好者/企业 | 观察 | 18/12/1/11 | Perplexity 的 Computer 功能现可完全在 Mac … |
| [Amjad Masad](https://x.com/amasad) | 技术/爱好者 | 观察 | 20/16/1/10 | 自动驾驶公司的崛起 |
| [Guillermo Rauch](https://x.com/rauchg) | 技术/爱好者 | 观察 | 20/13/1/10 | ElevenLabs 登陆 AI Gateway |
| [Yohei Nakajima](https://x.com/yoheinakajima) | 技术/爱好者 | 观察 | 14/11/0/9 | X 用户如何回应 Anthropic 的 S-1 文件 |
| [Bindu Reddy](https://x.com/bindureddy) | 企业 | 观察·无样本 | 0/0/0/0 | — |
| [Mustafa Suleyman](https://x.com/mustafasuleyman) | 企业/爱好者 | 观察 | 13/8/0/5 | AI短期内不会抢走你的工作：十年内，人类的工作最多只有5%会被AI取… |
| [Thariq](https://x.com/trq212) | 技术/爱好者 | 重点保留 | 14/10/2/4 | Claude Code 团队如何做代码审查 |
| [Peter Steinberger](https://x.com/steipete) | 技术/爱好者 | 重点保留 | 20/19/0/16 | Artificial Analysis finally moves … |
| [Theo](https://x.com/theo) | 技术/爱好者 | 观察 | 15/14/0/12 | The Mac in this test cost $12,000.… |
| [Tae Kim](https://x.com/firstadopter) | 企业/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [Andrew Curran](https://x.com/andrewcurran_) | 企业/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [Matt Shumer](https://x.com/mattshumer_) | 爱好者 | 观察 | 20/20/0/16 | At some point in the next year, yo… |
| [Lauren](https://x.com/poteto) | 技术/爱好者 | 观察 | 18/12/0/11 | For the past 6 months openclaw has… |
| [Min Choi](https://x.com/minchoi) | 爱好者 | 观察 | 6/3/1/2 | Anthropic just flipped the AI agen… |
| [Santiago](https://x.com/svpino) | 技术/爱好者 | 观察 | 14/11/0/11 | AI is literally saving lives right… |
| [Logan Kilpatrick](https://x.com/officiallogank) | 技术/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [Alexandr Wang](https://x.com/alexandr_wang) | 企业/爱好者 | 观察 | 17/11/0/10 | THE SCALE MAFIA one of the most sp… |
| [Sam Altman](https://x.com/sama) | 企业/爱好者 | 重点保留 | 14/14/0/9 | I am very uncomfortable about peop… |
| [Greg Brockman](https://x.com/gdb) | 企业/爱好者 | 重点保留 | 16/16/0/13 | 迈向更安全的互联网 |
| [Demis Hassabis](https://x.com/demishassabis) | 技术 | 观察 | 19/10/1/7 | Gemini 4 Argon 智能体团队击败《我的世界》 |
| [Elvis Saravia](https://x.com/omarsar0) | 技术/爱好者 | 重点保留 | 16/10/3/4 | 重新思考智能体执行框架中的验证机制 |
| [Chubby](https://x.com/kimmonismus) | 企业/爱好者 | 观察 | 14/13/0/8 | Anthropic is now doing its own dru… |
| [David Ha](https://x.com/hardmaru) | 技术 | 观察 | 16/9/1/7 | 多智能体自我监督（MASS） |
| [Nathan Lambert](https://x.com/natolambert) | 技术 | 重点保留 | 12/11/0/2 | My first open model lecture, cover… |
| [Zvi Mowshowitz](https://x.com/thezvi) | 企业/技术 | 观察 | 15/14/1/5 | 大黑客时代 |
| [Gary Marcus](https://x.com/garymarcus) | 企业/技术 | 观察 | 18/16/0/9 | 我对Anthropic S-1文件的初步看法 |
| [Dean Ball](https://x.com/deanwball) | 企业/技术 | 观察 | 19/17/0/9 | NSF–DOE薇拉·C.鲁宾天文台在太阳系发现首个矮行星候选体 |
| [Matthew Berman](https://x.com/matthewberman) | 爱好者 | 观察 | 20/16/0/13 | I think I'm becoming T3-pilled. Ha… |
| [Robert Scoble](https://x.com/scobleizer) | 企业/爱好者 | 停用候选 | 19/9/0/4 | Judgment Labs — 发现并修正你的智能体出错的地方 |
| [Sebastian Raschka](https://x.com/rasbt) | 技术 | 重点保留 | 12/11/5/3 | 文本分类的语言模型：从词袋模型到 Jev |
| [Steven Cheng](https://x.com/stevencheng) | 技术 | 观察·无样本 | 0/0/0/0 | — |
| [Brendan Jowett](https://x.com/jowettbrendan) | 企业 | 观察 | 14/13/3/4 | GitHub - nateherkai/herk-edit-kit：… |
| [Mark Ajzenstadt](https://x.com/mardehaym) | 企业 | 观察·无样本 | 0/0/0/0 | — |
| [Nate Herk](https://x.com/nateherk) | 企业 | 观察 | 14/10/0/9 | 1/ I sat down with @mattpocockuk a… |
| [vas](https://x.com/vasuman) | 企业 | 停用候选 | 20/12/0/5 | Running a "cheaper" model in an ag… |
| [Dario Amodei](https://x.com/darioamodei) | 企业/爱好者 | 重点保留 | 9/8/0/0 | 达里奥·阿莫迪——我们必须控制前沿AI的发展节奏 |
| [GC Cooke](https://x.com/gccooke) | 企业/爱好者 | 停用候选 | 19/17/0/11 | The Bank of Canada just benchmarke… |
| [Naval](https://x.com/naval) | 企业/爱好者 | 停用候选 | 17/16/0/3 | Models are the last moat in softwa… |
| [Rowan Cheung](https://x.com/rowancheung) | 企业/爱好者 | 观察 | 11/9/2/3 | I'm GrokBot pilled. The recent upd… |
| [0x ROAS](https://x.com/0xroas) | 爱好者 | 观察 | 17/6/0/6 | here's how a 100% AI Video looks l… |
| [Aadit Sheth](https://x.com/aaditsh) | 爱好者 | 停用候选 | 19/19/0/13 | Quick tip for all social teams: On… |
| [Alex Prompter](https://x.com/alex_prompter) | 爱好者 | 观察 | 12/10/2/4 | 如何让 Claude 拥有设计师的品味，并搭建自己的落地页 |
| [Amelia hazel](https://x.com/ameliahazelai) | 爱好者 | 停用候选 | 16/8/0/8 | Teamily AI - The Human–Agent Platf… |
| [AmirMušić](https://x.com/amirmushich) | 爱好者 | 观察 | 10/2/1/1 | 如何用GPT-6 Astra和AI视频作为界面动画，将产品照片打造成… |
| [Abhishek](https://x.com/heyabhishek) | 爱好者 | 停用候选 | 9/2/0/2 | I never thought staring out of a t… |
| [Shruti](https://x.com/heyshrutimishra) | 爱好者 | 停用候选 | 12/5/0/5 | The best thing about Parallel's ne… |
| [NIJ Ruvos](https://x.com/nahidulislam404) | 爱好者 | 停用候选 | 20/10/0/7 | AI角色聊天与视频故事 / Elymi |
| [Stan Girard](https://x.com/_stangirard) | 爱好者/企业 | 停用候选 | 18/18/1/16 | Skillpack：面向 Claude Code 与 Codex 的… |
| [Damian Player](https://x.com/damianplayer) | 爱好者/企业 | 停用候选 | 18/18/0/14 | the best capitalized firms in vent… |
| [EP](https://x.com/eptwts) | 爱好者/企业 | 停用候选 | 19/8/0/3 | my process for achieving goals: > … |
| [Machina](https://x.com/exm7777) | 爱好者/企业 | 观察 | 18/12/0/9 | everyone should experience having … |
| [jack friks](https://x.com/jackfriks) | 爱好者/企业 | 观察 | 13/10/0/9 | my AI agent will never know whats … |
| [@levelsio](https://x.com/levelsio) | 爱好者/企业 | 重点保留 | 16/15/0/8 | Origami：经营你自己的自建创业公司 |
| [Marc Lou](https://x.com/marclou) | 爱好者/企业 | 观察 | 14/12/1/11 | MailCheap · 比beehiiv便宜83%运营你的新闻邮件 |
| [Riley Brown](https://x.com/rileybrown) | 爱好者/企业 | 观察 | 16/16/0/13 | Yes… Obviously! AI is an amplifier… |
| [Mubbu](https://x.com/wizofecom) | 爱好者/企业 | 观察 | 16/13/0/10 | How to choose the best content for… |
| [Zara Zhang](https://x.com/zarazhangrui) | 爱好者/企业 | 观察 | 14/8/0/6 | I think ambitious people should tr… |
| [Adam Silverman (Hiring!) 🖇️](https://x.com/adamsilverman) | 技术/爱好者 | 观察 | 5/4/0/4 | TIL that there is a guy named Marc… |
| [Ali Sufian](https://x.com/aliscodes) | 技术/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [Aurimas Griciūnas](https://x.com/aurimas_gr) | 技术/爱好者 | 重点保留 | 10/10/3/2 | Integrating 𝗔𝗴𝗲𝗻𝘁𝗶𝗰 𝗥𝗔𝗚 Systems vi… |
| [D-Coder](https://x.com/damn_coder) | 技术/爱好者 | 观察 | 13/5/0/4 | CapCut × ChatGPT：AI视频创作与编辑指南 |
| [Greg Kamradt](https://x.com/gregkamradt) | 技术/爱好者 | 观察 | 18/16/0/11 | Looking forward to giving a talk a… |
| [ℏεsam](https://x.com/hesamation) | 技术/爱好者 | 观察 | 16/14/0/6 | 陶哲轩：AI把优美数学变成“有毒废料” |
| [João Moura](https://x.com/joaomdmoura) | 技术/爱好者 | 观察 | 5/5/1/3 | 如何在运行时治理企业级智能体：CrewAI 智能体控制平面 |
| [klöss](https://x.com/kloss_xyz) | 技术/爱好者 | 停用候选 | 20/12/0/11 | Get cash Get a cooler Get 40 lbs o… |
| [Omar Khattab](https://x.com/lateinteraction) | 技术/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [Matt Pocock](https://x.com/mattpocockuk) | 技术/爱好者 | 观察 | 15/14/0/4 | Bend：通过证明阻止AI犯错的快速语言 |
| [Lance Martin](https://x.com/rlancemartin) | 技术/爱好者 | 重点保留 | 16/10/3/5 | 用 Claude 自动化评测设计与爬山式优化 |
| [Rahul](https://x.com/sairahul1) | 技术/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [Tibo](https://x.com/thsottiaux) | 技术/爱好者 | 观察 | 15/12/0/10 | Day 19/ Small updates. Calls conne… |
| [Yogesh](https://x.com/yogesharc) | 技术/爱好者 | 观察 | 14/3/0/3 | https://t.co/dz4vz5nN8Y |
| [Brett Adcock](https://x.com/adcock_brett) | 技术 | 观察 | 18/14/0/14 | We spent a lot of time making the … |
| [Andrew Ng](https://x.com/andrewyng) | 技术 | 观察·无样本 | 0/0/0/0 | — |
| [Fei-Fei Li](https://x.com/drfeifei) | 技术 | 重点保留 | 19/11/1/5 | 研究加速：OpenAI内部的视角 |
| [Cohere](https://x.com/cohere) | 企业 | 重点保留 | 11/7/2/2 | Octave 如何在 Amazon Bedrock 上构建安全的多租… |
| [SuperAGI](https://x.com/superagi_pilled) | 企业 | 观察 | 16/6/2/4 | 产品经理的 Claude Code 课程｜免费 PM 教程与课程 |
| [a16z](https://x.com/a16z) | 企业/爱好者 | 重点保留 | 14/7/2/2 | OpenAI's computer-using agents can… |
| [Google](https://x.com/google) | 企业/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [Google AI](https://x.com/googleai) | 企业/爱好者 | 重点保留 | 9/3/0/0 | 研究人员如何利用AI发现野火？ |
| [PAAL AI 🧠🤖](https://x.com/paalmind) | 企业/爱好者 | 观察 | 14/9/0/8 | 算法交易金库开启回购、全新 Paal LLM 1.5 集成 Poly… |
| [X](https://x.com/x) | 企业/爱好者 | 停用候选 | 17/15/0/15 | ty for 4 years of bangers to the l… |
| [eden](https://x.com/edendotso) | 爱好者/企业 | 观察 | 11/11/0/4 | Your first 20 sales conversations … |
| [AgentOps 🖇️](https://x.com/agentopsai) | 技术/爱好者 | 停用候选 | 20/18/1/16 | 为什么 Jev 对受监管行业具有革命性意义？ |
| [Browser Use](https://x.com/browser_use) | 技术/爱好者 | 重点保留 | 12/10/2/7 | GitHub - browser-use/rl-env-use：根据… |
| [Cognition](https://x.com/cognition) | 技术/爱好者 | 观察 | 7/6/0/3 | Devin 安全：发现并修复你最危险的漏洞 |
| [CopilotKit🪁](https://x.com/copilotkit) | 技术/爱好者 | 观察 | 16/9/2/7 | GitHub - CopilotKit/OpenBot：开源 AI … |
| [CrewAI](https://x.com/crewaiinc) | 技术/爱好者 | 观察 | 19/15/2/10 | 如何构建智能体系统：生产级AI智能体缺失的架构 |
| [Data Science Dojo](https://x.com/datasciencedojo) | 技术/爱好者 | 观察 | 5/3/0/3 | Agentic AI Conference 2026: free a… |
| [DeepLearning.AI](https://x.com/deeplearningai) | 技术/爱好者 | 重点保留 | 16/16/6/6 | OpenAI开发者大会、谷歌首款Gemini 4模型、黑森林实验室进… |
| [Dify](https://x.com/dify_ai) | 技术/爱好者 | 重点保留 | 20/13/4/8 | 信任即功能：Dify 如何治理不断壮大的插件生态 |
| [FlowiseAI](https://x.com/flowiseai) | 技术/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [GitHub](https://x.com/github) | 技术/爱好者 | 重点保留 | 18/13/0/7 | 通往智能体规模的 Git 基础设施之桥 |
| [H](https://x.com/hcompany_ai) | 技术/爱好者 | 观察·无样本 | 0/0/0/0 | — |
| [Hugging Face](https://x.com/huggingface) | 技术/爱好者 | 重点保留 | 19/10/0/4 | NVIDIA Nemotron 3.5 Bolt E4B 4GB 技… |
| [Langflow](https://x.com/langflow_ai) | 技术/爱好者 | 重点保留 | 15/10/4/3 | Langflow 1.11.0：借助 NextPlaid 迎来多向量… |
| [mem0](https://x.com/mem0ai) | 技术/爱好者 | 重点保留 | 13/10/6/1 | Jev-Mem：不靠大语言模型做记忆决策 |
| [n8n.io](https://x.com/n8n_io) | 技术/爱好者 | 重点保留 | 16/12/4/6 | 用 Veo 3.1、GPT-4o 和 Google NanoBana… |
| [OpenAI Developers](https://x.com/openaidevs) | 技术/爱好者 | 重点保留 | 10/1/0/1 | I built a low-poly graffiti playgr… |
| [OpenClaw🦞](https://x.com/openclaw) | 技术/爱好者 | 重点保留 | 14/9/0/4 | v2026.10.7 版本发布说明 |
| [Pi](https://x.com/pidotdev) | 技术/爱好者 | 观察 | 14/13/1/10 | Pi Durable 在 Cloudflare 上的应用 / Ear… |
| [Quivr (YC W24) 🧠](https://x.com/quivr_brain) | 技术/爱好者 | 观察 | 14/10/0/7 | YC Batch W24 - What're the AI tren… |
| [EleutherAI](https://x.com/aieleuther) | 技术 | 观察·无样本 | 0/0/0/0 | — |
| [DeepSeek](https://x.com/deepseek_ai) | 技术 | 重点保留 | 6/5/3/0 | 搜索与抓取 / DeepSeek API 文档 |
| [Figure](https://x.com/figure_robot) | 技术 | 观察 | 8/4/0/1 | Helix 2.5：零样本泛化到30个家庭 |
| [Flapping Airplanes](https://x.com/flappyairplanes) | 技术 | 观察 | 8/5/0/4 | I spent a bunch of time a year ago… |
| [AI Breakfast](https://x.com/aibreakfast) | 企业/爱好者 | 停用候选 | 18/14/0/14 | https://t.co/CYXc4zhuw8 |
| [The Deep View](https://x.com/thedeepview) | 企业/爱好者 | 停用候选 | 20/17/0/12 | Anthropic revenue is concentrated … |
| [Mr. Claude](https://x.com/claudeskills101) | 爱好者 | 观察 | 5/4/1/1 | A delivery orchestration platform … |
| [The AI Colony](https://x.com/theaicolony) | 爱好者 | 停用候选 | 18/7/0/5 | Unreal. Claude Mythos 5 tried to s… |
| [Dion Hinchcliffe](https://x.com/dhinchcliffe) | 企业 | 重点保留 | 20/18/3/5 | Anthropic的IPO文件：基础设施承诺成为AI供应商风险的核心… |
| [Giuliano Liguori](https://x.com/ingliguori) | 企业 | 观察 | 20/20/0/11 | AI growth is becoming an energy st… |
| [Pascal Bornet](https://x.com/pascal_bornet) | 企业 | 重点保留 | 11/8/0/4 | Most "AI agents" I get demoed are … |
| [Ruben Hassid](https://x.com/rubenhassid) | 爱好者 | 重点保留 | 15/6/3/0 | 如何把 Claude 打造成你的私人法务团队（只靠 Claude） |
| [Hasan Toor](https://x.com/hasantoxr) | 爱好者 | 观察 | 11/7/2/5 | GitHub - OpenBMB/MiniCPM-OCR：一款开源 … |
| [Kyle Balmer](https://x.com/iamkylebalmer) | 爱好者/企业 | 停用候选 | 19/19/0/18 | hey @BBCNews / @BBCTech this is no… |
| [Julian Goldie](https://x.com/juliangoldieseo) | 爱好者/企业 | 停用候选 | 14/8/1/4 | 每月328次到18036次谷歌点击：我的Grok机器人SEO系统（完… |
| [Claude（产品官方账号）](https://x.com/claudeai) | 爱好者 | 观察 | 6/3/1/0 | 完整的 Claude 平台现已登陆 Google Cloud |
| [ClaudeDevs（开发者官方账号）](https://x.com/claudedevs) | 技术/爱好者 | 观察 | 7/5/2/1 | 通过 MCP 将 Claude Code 连接到工具 - Claud… |

## 下一轮需要验证

1. 对重点保留与停用候选各抽最近 10–20 条**本人原创或有实质评论的帖子**，区分原创、纯转发、广告、教程、案例和可验证一手信息；当前数据库有转发内容且很多账号样本仅一次回填。
2. 连续观察至少 2–4 周的新增内容与实际 API/翻译费用，再把“账号成本 / 可发布选题 / 技术学习价值”放在同一表里比较。
3. 对企业决策者题材优先查原始案例和财报；对 Skill/MCP/开源项目先验证仓库活跃度、许可证、安装和安全边界，再推荐给读者。
4. 正式改动前先确认“停用”与“降频”策略，以及是否保留官方一手账号用于核实新闻。

## 数据来源

- 本机正式配置：`~/.qiushui-airadar/production-data/config/sources.yaml`（只读）。
- 本机正式内容库：`~/.qiushui-airadar/production-data/qiushui-airadar.sqlite`，`contents` 表（SQLite 只读方式查询，包含 WAL 中已提交记录）。
- 本地项目页面筛选逻辑：`apps/web/src/lib/content-filters.ts`。
