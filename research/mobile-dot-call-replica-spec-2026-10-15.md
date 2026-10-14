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
3. 点对话标题栏的 `Call` 后，请求浏览器麦克风权限并创建用户归属的通话记录；SeedDuplex 就绪后显示 Dot 的中文问候并开始发送麦克风音频。
4. 活跃通话占满手机视口，顶部显示“聊天”返回操作、Dot 身份与连接状态、计时器；底部依次放扬声器、红色挂断、静音。
5. 点“聊天”返回同一 Dot 对话，通话以紧凑浮窗继续；用户可继续打字，再点浮窗回到通话界面。
6. 点红色挂断后结束语音流、写入结束时间并关闭通话界面。

## 自动化验收

`tests/e2e/base-path-auth.e2e.ts` 通过手机尺寸与触控模式的 Chrome 执行完整流程：

- 真实点击本地 Google OAuth 模拟器，验证 state cookie、PKCE、回调与登录态。
- 检查登录和对话页在手机尺寸无水平溢出；检查通话视图为 390×844 全屏且控制区顺序正确。
- 使用 Chrome fake media stream 与本地 SeedDuplex WebSocket 模拟器，确认浏览器送出非静音 PCM、收到并调度 24 kHz 返回音频、Dot 中文问候经过 TTS 事件发出。
- 验证返回聊天时通话不结束，挂断后数据库通话记录有结束时间，语音会话已关闭。

此路径验证前端、基础路径代理、登录态、WebSocket 升级、麦克风捕获和调用控制。模拟服务不验证真实 Google 账号、真实手机硬件、蜂窝/公网网络或火山生产语音质量；真实公网验收需另行使用已登录 Chrome 和真实服务。

## 参考

- [OpenAI: Meet dots](https://learn.chatgpt.com/docs/dots)
- [OpenAI: Create your dot in the ChatGPT mobile app](https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026)
- [John Aspinall: I Tried ChatGPT Dots: Setup, Voice Calls & Real Tasks](https://www.youtube.com/watch?v=Q9tF0R8d_Co)
- [视频章节索引与简介](https://madewithdots.com/projects/youtube-Q9tF0R8d_Co)
