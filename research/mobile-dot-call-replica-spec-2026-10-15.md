# 手机 Chrome：Dot 登录与通话复刻规格

日期：2026-10-15

验证范围：手机 Chrome 网页适配，登录后发起 Dot 通话。这里的 OAuth 与语音服务在自动化验收中使用本地模拟服务，不连接真实 Google 或火山引擎账号。

## 官方行为证据

OpenAI 的 [Meet dots 文档](https://learn.chatgpt.com/docs/dots) 当前说明：Dots 可以在 ChatGPT 手机 App、桌面 App 或桌面浏览器中使用，**mobile web 不受支持**。用户在 Dot 对话中点电话按钮开始通话；通话时可以继续输入文字，已经交付给 Dot 的工作可在通话结束后继续。因而不存在可作为目标的 OpenAI 手机网页画面，Coke Dots 手机 Chrome 页面属于兼容性适配，不能称为对官方手机网页的逐像素复刻。

## 视频观察

参考 John Aspinall 的 [Dots 上手视频](https://www.youtube.com/watch?v=Q9tF0R8d_Co)：

| 时间码 | 视频内容 | 对复刻的意义 |
| --- | --- | --- |
| 4:30 | 打开 Dot 的云电脑 | 电脑属于 Dot 的工作上下文 |
| 5:40 | Calling my dot | 从 Dot 对话发起电话；画面仍以对话与右侧 Dot/Computer 上下文为主，通话控制出现在对话页中 |
| 13:09 | 第二次通话，询问正在做什么 | 通话用于查看进度和调整工作方向，不是独立的拨号任务 |

视频是桌面网页录制，没有手机网页或原生手机通话屏幕的可测画面。因此手机全屏电话 UI 依据手机使用习惯和本项目已有适配实现，视频本身不能证明其像素细节。

## 手机 Chrome 页面流程

1. 进入 `/dots-demo/`，登录页在 320–390 CSS px 宽屏幕内完整显示，Google 登录按钮至少 44 px 高。
2. OAuth 完成后显示登录用户的 Dot。底部 Dot 导航打开主对话，聊天区域不产生水平溢出。
3. 点对话标题栏的 `Call` 后，立刻在这次用户点击中创建并恢复 Web Audio 上下文，再请求浏览器麦克风权限并创建用户归属的通话记录；SeedDuplex 就绪后显示 Dot 的中文问候并开始发送麦克风音频。这样网络请求不会错过手机 Chrome 的用户手势音频解锁时机。
4. 活跃通话占满手机视口，顶部显示“聊天”返回操作、Dot 身份与连接状态、计时器；底部依次放扬声器、红色挂断、静音。
5. 点“聊天”返回同一 Dot 对话，通话以紧凑浮窗继续；用户可继续打字，再点浮窗回到通话界面。
6. 点红色挂断后结束语音流、写入结束时间并关闭通话界面。

## 自动化验收

`tests/e2e/base-path-auth.e2e.ts` 通过手机尺寸与触控模式的 Chrome 执行完整流程：

- 真实点击本地 Google OAuth 模拟器，验证 state cookie、PKCE、回调与登录态。
- 检查登录与对话页在 320×568 和 390×844 手机视口无水平溢出，Google 登录和拨号入口达到触控尺寸；检查通话视图在两种尺寸均铺满屏幕，挂断、静音和扬声器控制完整可见。
- 使用 Chrome fake media stream 与本地 SeedDuplex WebSocket 模拟器，确认浏览器送出非静音 PCM、收到并调度 24 kHz 返回音频、Dot 中文问候经过 TTS 事件发出。
- 通过点击事件记录验证 Web Audio 上下文在用户点击 `Call` 时同步创建并恢复，网络协商后同一个上下文用于麦克风采集；如果浏览器仍拒绝自动播放，通话页显示手动启用语音播放按钮。
- 验证返回聊天时通话不结束，挂断后数据库通话记录有结束时间，语音会话已关闭。

此路径验证前端、基础路径代理、登录态、WebSocket 升级、麦克风捕获和调用控制。模拟服务不验证真实 Google 账号、真实手机硬件、蜂窝/公网网络或火山生产语音质量；Playwright 手机视口也不等同于实体手机，Android Chrome 与 iOS Chrome 的硬件音频仍需真机验收。

## 公网 Chrome 手动验收（2026-10-15）

使用现有已登录 Chrome 打开 `https://codex.cokeagent.com/dots-demo/`，通过 Chrome 设备工具栏以 390×844 CSS px 模拟手机；这是**手动签入公网浏览器测试**，不是实体手机测试，也不是 dedicated-storage-state 自动化测试。

- 当前 `main` 与测试功能分支为 `d80672a7bf2a0b6f2e8a06588fec29355b5502a7`。公网 `index-BGpV3z0L.js` 与本地 `dist/assets/index-BGpV3z0L.js` 的 SHA-256 相同（`a7cc7ce98584d13e5b5071d5b55e4f8e25ef70ccd876fcfb085ac0b57d6fe3d3`）；CSS `index-DPp-EZ40.css` 也一致（`df6d85bfde2c9bc7ac5347848232ed8b40e991e18c912ba704753c244dcc4913`）。
- 在 Dot 对话页点击通话图标后，页面切到完整手机通话画面，显示 Dot、连接状态“正在聆听”、计时器，以及扬声器、红色挂断、静音控件。Chrome 显示麦克风正在使用。
- DevTools Network 记录到 `GET /api/voice/provider` 返回 `200`、`POST /api/voice-calls` 返回 `201`、`volcengine-stream` WebSocket 升级返回 `101`。点击红色挂断后通话画面关闭，通话列表刷新返回 `200`。
- 本次没有说出语音指令，也没有创建 Agent 任务；因此没有验证公网 ASR 识别内容、Pi 任务执行、任务结果播报的可听质量或实体手机麦克风表现。上一节的本地模拟 E2E 覆盖语音轮次与任务/结果流程，但不能替代这些公网边界。

## 参考

- [OpenAI: Meet dots](https://learn.chatgpt.com/docs/dots)
- [OpenAI: Create your dot in the ChatGPT mobile app](https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026)
- [John Aspinall: I Tried ChatGPT Dots: Setup, Voice Calls & Real Tasks](https://www.youtube.com/watch?v=Q9tF0R8d_Co)
- [视频章节索引与简介](https://madewithdots.com/projects/youtube-Q9tF0R8d_Co)
