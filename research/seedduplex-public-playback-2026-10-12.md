# SeedDuplex 公网播报验证

日期：2026-10-12（Asia/Shanghai）

环境：Chrome，`https://codex.cokeagent.com/dots-demo/`
范围：公网 SeedDuplex 输出音频到浏览器 Web Audio 播放链路；不覆盖麦克风识别、Pi 任务或物理扬声器录音。

## 操作

1. 在已登录的 Chrome 中重新载入 Dots 页面。
2. 点击「拨打 Dot」，等待状态变为「正在聆听」。公网 `/api/voice/provider` 返回 `provider=volcengine`、`configured=true`、`model=doubao-seedduplex-3.0`。
3. 在通话已建立后，通过 Chrome DevTools 向当前通话 WebSocket 发送一条中文 `speak` 消息，要求 SeedDuplex 朗读固定短句。此步骤走真实公网服务和真实 SeedDuplex，不调用 Pi、不创建任务。
4. 在页面内观察实际 WebSocket 音频帧与 `AudioBufferSourceNode` 的播放完成事件。

## 结果

- 页面 JS：`index-COayIfjo.js`，SHA-256 `1b172450fc42083694ca98b8d26e9fece7046321c3c32f7554b8e71e750b1a27`，与 Mac demo app 的 `dist` 资源一致。
- 收到 17 个音频帧，格式标记均为 `2`（Float32 PCM），共 635,277 字节、158,815 个样本。
- 音频采样率为 24 kHz，总时长 6.617 秒；服务端 PCM 的 RMS 为 0.0800、峰值 0.3415、相邻样本相关值 0.9324。
- 浏览器为 17 帧各创建一个音频源；17 个源均触发 `ended`，采样率均为 24 kHz，合计播放时长 6.617 秒。浏览器缓冲区 RMS 均值为 0.0758，峰值 0.3415。
- 这次在刷新后的公网页面没有复现 Float32 被解释成 Int16 后产生的宽带沙沙声；实际物理扬声器声音没有通过回录设备采集，因此这里只能证明浏览器音频图收到了有效语音波形并完成播放调度。

## 诊断与边界

旧链路将 SeedDuplex 返回的归一化 Float32 PCM 按 Int16 解码，导致静电噪声和人声失真。当前协议通过首字节标记格式（`2` 表示 Float32），前端移除标记后按 Float32/24 kHz 解码。文本转语音使用 `speech_text_buffer.commit`。

本次是已登录 Chrome 的人工点击式公网验证，不是专用测试租户的 Playwright 公网 E2E。它隔离并验证了 SeedDuplex 合成与浏览器播放，不证明真实麦克风 ASR、Pi Agent 云电脑任务和语音播报的完整闭环；完整自动化测试仍需专用 Google 测试账号的受限存储态。
