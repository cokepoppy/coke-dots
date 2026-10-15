# Coke Dots 钉钉渠道与主动排障方案

日期：2026-10-15
基线：`origin/main` / `aff75474242b76a1278c2e1477f55b120b809f8a`
实施分支：`codex/dingtalk-stream-event-ingestion`

## 结论

在 Dot 资料侧栏现有 Slack 入口旁增加“钉钉”，沿用侧栏连接器弹窗的交互框架；账号连接、群机器人接入、群消息监控是三项独立配置，不能用一次“OAuth 成功”冒充全部已打通。

群消息采用两条互补路径：

1. **Stream 推送**：用户在群里 @机器人，钉钉将消息经长连接推给网关；适合低延迟触发。官方 Stream SDK 说明机器人在群聊接收消息需要被 @。
2. **定时补查**：DWS CLI 在用户已授权、已选中的会话范围内读取最近消息；适合用户要求监控但群消息不会 @机器人的情形。当前 CLI 命令索引说明支持按会话拉取近期消息及按时间范围检索，但能否稳定增量读取、具体权限和限流仍须用专用测试组织实测。它不是实时事件推送。

因此 UI 要明确显示每条监控规则实际使用的是“@机器人实时触发”还是“定时读取”，展示检查间隔、最近检查时间、授权状态和可能的权限限制。仅把机器人加入群，不自动开启监控。

第一期演示闭环建议是：**告警消息 → 查日志与 Trace → 云电脑内隔离工作区修复 → 测试 → 草稿 PR → 钉钉文档报告并私信用户**。Agent 内核仍运行在各租户自己的 Debian 云电脑中；钉钉事件网关只负责验签/去重/入队/授权路由，不执行 Agent 工作。

## 证据与当前实现

### Phase 1 实施状态（2026-10-15）

- 已在 Slack 旁加入钉钉入口和中文连接弹窗：展示 DWS 设备授权码/官方授权链接、账号身份、群名搜索、手动群选择、断开和授权失效状态。
- 已接入 DWS CLI v1.0.64。官方群搜索输出使用 `result.chats[]`、`openConversationId` 和 `name`；下一页使用 `hasMore` / `nextCursor`。适配器只返回群 ID、名称和分页信息，不传递原始 CLI 输出。
- DWS 网关独立运行，DWS profile 以 tenant + user 分区，用独立 K8s Secret 提供 AES-256-GCM 包装密钥；明文 profile 和临时归档限定在 memory-backed `/run/dws`。Dot Agent 不读取该目录。
- 已完成的自动化证据仅包括本地假 DWS CLI、加密持久化/重启恢复、租户隔离测试和模拟授权的 Chrome E2E。真实组织授权、IM 权限、Stream 事件、群消息读取及公网版本尚未验证；弹窗选择群不会启用监听或发送。

### Phase 2 实施状态（2026-10-15）

- 在专用分支 `codex/dingtalk-stream-event-ingestion`（基于最新 `origin/main` `aff7547`）接入官方 `dingtalk-stream` SDK，注册 `/v1.0/im/bot/messages/get` 的 Stream CALLBACK。Dots 控制平面运行自己的 Stream 客户端；服务使用出站长连接，不开放机器人公网入站 Webhook。
- 已加入“实时告警监听”区域。必须先保存群，再由用户逐群开启；仅接收被 @机器人的群文本回调。界面显示 Stream 连接、组织不匹配、Pi/共享模型未就绪和 E2E 模拟状态，不把 DWS 用户 OAuth 伪装成机器人连接。
- 已将 DWS 验证的钉钉组织 ID 保存在群选择记录；回调中的机器人组织 ID须与租户已保存的组织及会话匹配。共享机器人 AppKey/AppSecret 只从 Dots API 进程环境读取，不能返回给浏览器。进程只需要 `DOTS_DINGTALK_STREAM_CLIENT_ID` 和 `DOTS_DINGTALK_STREAM_CLIENT_SECRET`；可选 `DOTS_DINGTALK_STREAM_CORP_ID` 是部署级固定组织限制，不是必需配置。当前 Mac Dots 外部环境尚未配置这两个 Stream 变量，因此真实连接和回调仍未验证。
- 事件仅在对应 Dots 用户已选并启用该群的租户中入队，按 `(tenant_id, provider_message_id)` 去重；仅在数据库提交后 ACK。正式任务固定使用 `pi`，由现有 Worker 分发到该租户 Debian 云电脑。回调正文作为不可信数据；当前任务限只读排查，不写代码、不创建 PR、不发群消息。
- 官方 Stream 协议允许同一应用建立多个连接，但采用随机选择一个 Stream 通道投递，不是广播。因此迁移期间不能让旧 Coke Codex 网关与 Dots 同时作为消费者，否则部分告警会送到旧网关。用户已确认当前不使用 Coke Codex App；Dots 实际连接并验证就绪后，应把旧网关缩容到 0 保留回滚，而不是删除。旧 Deployment 当前仍为 1/1，尚未修改。[Stream 多连接投递说明](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/protocol/)
- 自动化证据：Store 覆盖组织/用户/租户隔离、组织匹配、Pi 入队和重复事件；Chrome E2E 点击模拟授权、保存群、开启监听、注入测试告警、验证任务完成、重复投递与第二租户隔离。该浏览器测试使用 E2E 专用 HTTP 模型桩，不证明真实 Stream 在线、Pi 云电脑执行或公网版本可用。完整 Chrome 主 E2E 的 45 个步骤通过；后续 cloud-computer 子套件在整套命令中遇到 Beta DSH 超时，单独重跑通过。真实钉钉回调仍待专用测试机器人验证。

### Dots 渠道体验

官方 Dots 文档说明：Slack 可通过私聊或在指定频道提及 Dot；默认只对用户本人回应；用户需要明确指定要检查的频道、关注事项和通知时机，加入频道本身不会创建监控任务。跨渠道共享 Dot 的相关记忆，但各渠道消息各自显示；向其他群成员分享私人对话前要取得用户许可。[Dots 渠道文档](https://learn.chatgpt.com/docs/dots/channels)

据此，本产品需把“连接钉钉”“选择群”“建立监控规则”“允许向群里回消息”分成不同步骤。任务进展留在 Dots 聊天/Activity，最终可按用户配置把摘要发给本人；群内公开回复单独授权。

### 钉钉消息接入方式

- 钉钉官方 Stream SDK 支持事件推送、机器人收消息和卡片回调，采用客户端建立长连接；Node SDK有异步处理并发上限、事件 ACK 和断线取消信号等能力，网关不能在回调里等待完整 Agent 任务。[官方 Node.js Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)
- 钉钉 Stream 协议说明连接端先获取连接凭证，再使用 WebSocket；群聊机器人消息 Topic `/v1.0/im/bot/messages/get` 对群消息要求 @机器人。Stream 无需开放公网入站 Webhook。[Stream 协议与消息类型](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/protocol/) · [Stream 入门](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/overview/)
- 官方 DWS CLI 使用 OAuth device-flow 登录，组织可能需要管理员启用 CLI 访问。官方 CLI 具备 IM 会话搜索/近期消息读取、文档读写、日历读等命令；相关授权仍受组织授予的 API 权限约束。[DWS 官方仓库与安全说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) · [DWS 命令索引](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/docs/command-index.md)

**实现判断**：事件优先采用 Stream，不用持续短间隔轮询替代它；用户要监控未 @机器人的普通群消息时，再用 DWS 定时补查，并在完成权限、游标/去重、限流验证后才承诺覆盖。若 DWS 没有可靠的增量游标，则按明确时间窗读取并用消息 ID 去重，不能宣称实时。

### 可复用实现

从 `/Users/shangguan/Documents/home2026/coke-codex-app` 选择性复用设计和经过验证的模块，不合并整条历史分支：

- `docs/dingtalk-personal-connector-phase1.md`：连接器状态、弹窗、账号/项目隔离、过期和撤销时失败关闭等 UI 契约。
- `scripts/connectors/dws-runtime.mjs`、`dws-authorization-manager.mjs`、`dws-documents.mjs` 与 Phase 2 文档：DWS 独立 HOME/profile、身份校验、并发锁、参数数组执行、有限输出、权限和文档写后回执。
- `src/cloud/dingtalkGateway.ts` 与 `scripts/dingtalk-channel-gateway.mjs`：Stream 事件规范化、机器人接收和 Cloud task 委派的已有模式。移植前对照当前官方 Node SDK；旧代码使用的包名/锁定 DWS `1.0.61` 都不能直接视为当前适用版本。
- `docs/dingtalk-channel-v2-foundation.md`：会话绑定和越权负向测试要求。该历史 V2 运行开关默认关闭；配置过凭据不等于授权启动。

当前 Coke Dots 可复用 `DotContextPanel` 的 Slack 邻接位置、`SlackSetupModal` 的弹窗状态/关闭模式、`SlackService` 的一次性 OAuth state 与 callback 设计，以及现有任务、Activity、Scheduled、产物卡片和云电脑运行接口。仅复用交互和通用任务能力，不能复用 Slack Token、Slack 安装记录或 Slack OAuth client。

## 身份、授权和租户边界

这项功能至少有四类彼此独立的凭据/身份：

| 边界 | 作用 | 处理原则 |
|---|---|---|
| Coke Dots Google 登录 | 识别当前 Dots 用户和租户 | 继续使用当前登录会话，不将钉钉登录当作 Dots 登录替代 |
| DWS 用户授权 | 代表用户读其可访问的群、文档、日历 | 使用官方 DWS device-flow；明确当前组织和权限；凭据服务端加密隔离，不能进入 Agent prompt、日志、任务输出或共享 Secret |
| Stream 机器人应用 | 接收被授权群的机器人消息、发送机器人消息 | AppKey/AppSecret 独立存放 Secret；事件必须映射到已绑定 Dots tenant + DingTalk tenant + conversation |
| GitHub / 日志系统 | 读取指定仓库和追踪告警 | 按 Dots tenant 配置、最小仓库/系统范围的连接器凭据；Agent 使用短时、工具级授权 |

DWS CLI 官方 device-flow 和 Stream 机器人并非一个 OAuth 连接。登录成功不能表示机器人已经进群，机器人在群中也不能表示用户授予了文档、IM 全量读取或日历权限。每次调用按租户与用户身份重新校验授权。

群工作区标识使用 `{provider, dingtalkTenantId, conversationId}`，必要时附加真实稳定的 Thread ID。`messageId` 仅用于单次事件去重和运行记录，不能作为项目、云电脑、PVC 或会话所有权。多租户请求必须由服务端验证群绑定、触发用户、Agent 租户和目标云电脑，不信任客户端提交的 userId 或群 ID。

## UI 与交互流程

### 1. 侧栏入口

在聊天页右侧 Dot 信息区的 `Slack` 旁新增 `钉钉` 按钮；保持现有 Call、Slack、Teams 的卡片尺寸与响应式规则。打开钉钉弹窗时不卸载聊天输入框，保留草稿和附件。

### 2. 连接钉钉弹窗

弹窗按步骤呈现连接状态，不用一个含糊的“登录成功”标记：

1. **连接钉钉账号**：显示 DWS 授权用途和当前 Dots 账号；开始 DWS device-flow，按 CLI 实际返回展示授权链接与验证码（若官方流程提供二维码再显示二维码）；可取消、过期后重试。成功后显示钉钉昵称/组织供用户确认。若组织尚未开放 CLI 访问，显示“需要组织管理员启用”，不伪装成网络错误。
2. **群聊选择**：展示用户可访问的群、搜索、机器人是否已加入、已连接状态和权限提示。用户只选择要接入的群；不默认订阅全部群。
3. **告警监控**：配置规则名称、关注关键词/系统编号/错误级别、去重窗口、监控来源和通知方式。模式选项明确标为：
   - “有人 @Dot 时实时处理（Stream）”；
   - “每 N 分钟检查所选群消息（需验证 DWS 消息读取权限）”。
   如果机器人尚未进群，展示管理员添加机器人步骤；不要未经确认直接把机器人添加到群。
4. **排障范围**：选择日志系统/环境、允许查询的系统编号范围、GitHub 仓库白名单、测试环境，以及是否允许自动创建分支和草稿 PR。缺少日志/GitHub连接时允许先保存监控规则，但不能显示“端到端排障已就绪”。
5. **结果发送**：默认把任务进展放在 Dots；完成后可生成钉钉文档并私信用户。向原告警群或其他群公开结果必须单独选择并确认；默认不转发私聊上下文。

弹窗底部显示授权摘要、群范围、读取频率、允许的写入动作、私信/群发送范围。保存后在右栏展示 `Connected`、监控规则数量和最近事件，不展示凭据。

### 3. 主动排障任务展示

告警进入 Dots 后，聊天流生成一张可展开的 Incident task 卡片，显示来源群/时间/告警摘要及去重状态，并按以下阶段实时更新：

`已接收 → 正在查日志 → 已定位错误 → 正在修复 → 测试中 → 等待审查/已创建草稿 PR → 报告已写入钉钉`

每个阶段显示可验证证据：日志查询范围和 Trace ID、命中的错误摘要、GitHub 仓库/分支/提交、测试命令与结果、PR 链接、钉钉 Doc 链接。敏感日志正文默认折叠并按策略脱敏。任务失败显示失败边界和重试按钮；重复消息跳转到已有事件，不再创建另一份工作区。

Activity 保留事件时间线和停止/暂停；待用户决定的项目（不确定的根因、危险写入、发布/合并、对群回复）进入“等待你”状态。结束后在会话里出现报告卡片，并提供打开文档、查看 PR、查看测试结果。

### 4. 日历准备（后续阶段）

DWS 授权后可单独开启“会议准备”：用户选择日历、准备提前时间、过滤会议类型和收件方式。任务在会前创建，生成议题/参会人相关背景/待确认问题的 Brief，先在 Dots 展示；经用户启用后再写入钉钉文档或私信。日历访问不应随群监控默认开启。

## 主动排障执行链路

1. Stream 网关收到消息后，仅做传输来源与应用/租户绑定校验、规范化、持久化事件、幂等去重并快速 ACK；DWS polling 工作也写入相同事件入口。
2. 调度器按群绑定解析租户及授权用户，把事件投递给该租户云电脑中的 Agent runner。Agent kernel、浏览器、仓库副本和产物继续留在该租户 Debian 云电脑与工作区内。
3. Agent 首先用只读日志工具按 systemId、environment、traceId 查询；保留查询时间、响应摘要和关联 trace，不把无关租户数据带进上下文。
4. 在用户允许的 repo allowlist 内创建 `incident/<id>-<slug>` 分支，在独立工作目录分析/修复；运行预先批准的单元、集成和测试环境 E2E。云电脑文件写入限于其租户工作区。
5. 默认可自动提交本地变更并创建**草稿 PR**（用户在连接设置中明确开启后）；PR body 带诊断、修复和测试证据。合并、生产部署和向群公开回复默认进入审批，后续可按仓库保护规则单独配置，不随“监控群”授权自动打开。
6. 通过 DWS 创建事故报告 Doc，创建后回读/校验 URL 与内容。先在 Dots 私密通知已绑定用户；若要通过 DWS/机器人在钉钉私信发送链接，须先验证发送身份和权限，再让用户单独开启。向原群发送摘要必须由用户在该群的策略中明确允许。使用已有的文档 adapter，不自行实现另一套钉钉文档 API。
7. 全流程事件写入 Dots Activity，保存可追溯引用和去重键，不记录访问令牌、Secret 或完整敏感消息。

## 分期建议

### Phase 0：可行性与合同验证

- 对照 Coke Codex 现存 DWS / Stream 代码、DWS 当前版本和官方 Node Stream SDK；制作依赖清单和可移植边界。
- 用专用测试组织、测试机器人和独立 DWS profile 验证：组织授权、群查询、近期消息读取、是否有可靠游标、未 @ 群消息权限、Stream ACK/重连/重复投递。
- 不连接真实告警群，不写真实文档，不启用历史 V2 网关，不触碰 VPS 服务。

### Phase 1：钉钉账号 + 群管理 UI

- 右侧新增入口和弹窗；接 DWS 授权状态、身份确认、群只读列表、添加/撤销、错误与权限提示。
- 接一套假数据 Chrome E2E 与多租户隔离合同测试；正式功能开关默认关闭。

### Phase 2：消息监听与主动任务

- 独立 Stream listener + 持久事件队列 + ACK/重试/去重；一个群会话稳定复用同一个 Dots workspace。
- 首先做“@机器人实时触发”；完成增量游标/权限证明后，再加 DWS 轮询监控模式。
- E2E 证明重启恢复、重复事件只执行一次、群/租户隔离、暂停与恢复、查询失败的状态呈现。

### Phase 3：只读排障工具

- 每租户配置一个受限日志源和 GitHub 仓库；只读查询、告警解析、生成修复计划。
- 缺少 Trace、仓库或日志权限时，明确显示哪个连接器尚未配置。

### Phase 4：云电脑修复、测试与报告

- 使用租户云电脑 Agent 在隔离分支修复并运行测试；根据用户规则生成草稿 PR。
- 复用 DWS 文档工具写报告并回读；按私信策略发给用户；完成审批 UI 与回滚/重试审计。

### Phase 5：会议准备

- 使用 DWS 日历读取和 Dot Scheduled/Activity；实现按会前时间触发、Brief 预览、文档输出与通知策略。

## 验收要求

- **UI**：桌面和移动 Chrome 点击测试；连接、授权取消/超时、账号确认、群选择、监控设置、保存、状态恢复、权限缺失、暂停/恢复、结果链接均可操作。测试本地 bundle 与 VPS 公网登录流分开报告。
- **身份**：两个 Dots 租户连接同一个/不同钉钉组织时，账号、群、任务、DWS profile、仓库、日志和文档都不能串；`messageId` 不参与工作区归属。
- **事件**：Stream 断线重连、ACK、重复推送、网关重启后恢复、事件乱序、模型长任务和取消都要覆盖。Stream 回调不能同步等待 Agent 完成。
- **主动逻辑**：只有指定群和启用规则触发；普通消息不会无差别触发排障；DWS 轮询的覆盖范围/间隔/失败都可见；同一 alert 不重复创建 PR 或文档。
- **工具链**：云电脑实际完成日志 Trace 查询、repo 分支隔离、修复、测试环境 E2E；草稿 PR 中测试证据可查；钉钉 Doc 写后回读通过。
- **权限**：默认不合并、不部署、不公开回复；审批通过/拒绝后分别验证。所有凭据、device code、OAuth code、Session 和 Secret 不进入仓库或日志。

## 尚待实证的点

1. DWS 当前 CLI 版本和旧项目 vendored `1.0.61` 的兼容差异；需要在测试前重新锁定官方版本和校验值。
2. DWS 对目标组织的群列表、指定群增量消息读取 API、游标、查询时间范围和限流；官方命令索引证明存在查询命令，不代表用户当前组织已授权或具备无限期实时订阅。
3. Stream 机器人由谁创建/安装、应用可见范围和用户的组织管理员许可；钉钉 OAuth 用户连接本身不能创建或启动机器人。
4. 日志系统种类/API、测试环境及 GitHub 仓库/权限尚未指定。不能从示例中的“系统编号 + Trace ID”推断出某个现成日志连接器。
5. 草稿 PR 自动创建与合并边界需在实现前定成产品设置；本方案默认自动准备草稿 PR、合并需审批。

## 参考链接

- [OpenAI Dots：Slack 与 Teams 渠道](https://learn.chatgpt.com/docs/dots/channels)
- [钉钉 Stream 协议](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/protocol/)
- [钉钉 Stream 概述](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/overview/)
- [钉钉官方 Node.js Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)
- [钉钉 DWS CLI 官方仓库](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)
- [DWS 命令索引](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/docs/command-index.md)
- [DWS 文档写入指引](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/multi/dingtalk-doc/references/doc/doc-update.md)
