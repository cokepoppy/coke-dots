# SeedDuplex public Chrome acoustic check

Date: 2026-10-13 (Asia/Shanghai)

## Environment and confirmed state

- Public app: `https://codex.cokeagent.com/dots-demo/` in the user's already signed-in Chrome session.
- Read-only provider endpoint: `/dots-demo/api/voice/provider` returned `{"provider":"volcengine","configured":true,"model":"doubao-seedduplex-3.0"}`.
- The public page was hard-reloaded. The currently served script remains `index-COayIfjo.js`, SHA-256 `1b172450fc42083694ca98b8d26e9fece7046321c3c32f7554b8e71e750b1a27`, which contains the Float32 playback fix.
- Clicking the call button established the live Volcengine call. Chrome showed microphone recording and the page advanced from “正在连接火山实时语音…” to “正在聆听”.

## Acoustic input attempt

While the call was open, macOS Chinese speech (`say -v Eddy`) spoke two short Chinese test requests through the Mac speakers. The second attempt began after the page showed “正在聆听”. Neither attempt produced a visible transcript or a Pi task. The call was ended through the page control afterward.

This establishes that the public provider is configured and the call can connect. It does **not** establish that the synthesized Mac speaker audio reached Chrome's microphone, that SeedDuplex transcribed it, or that a Pi result was spoken through the physical speakers. The reason the synthetic speaker-to-microphone input was not transcribed is unknown; echo cancellation or audio routing are possibilities, not confirmed causes.

## Verification boundary and next test

The existing signed-in public Playwright flow, `npm run test:e2e:public-demo:voice-agent`, injects a synthetic WAV into Chromium and validates the real Pi task result and real SeedDuplex Float32 response. It requires `DOTS_PUBLIC_DEMO_STORAGE_STATE` pointing to a mode-0600 signed-in test state. The documented state file was absent during this check, so that automation was not run and no user Chrome session token was copied into a test artifact.

The earlier signed-in browser probe verified valid Float32 frames and completed Web Audio playback scheduling, but did not capture physical speaker output. A complete acoustic claim still requires a controlled microphone input that reaches the public page and a local loopback or microphone capture of the resulting speaker audio.

## Follow-up with controlled microphone routing

- Temporarily selected the already-installed BlackHole 2ch as the Mac's default input, kept MacBook Air speakers as the output, and started another public Chrome call. The page connected to SeedDuplex and entered “正在聆听”.
- Generated two short Mandarin inputs with the built-in `Eddy (中文（中国大陆）)` system voice and routed them to BlackHole. Chrome transcribed the input, but inaccurately: “请用中文回答，语音播报赛事进程中不要用中” and then “请回答赛事程中”. This differs from the source audio and demonstrates an ASR/input-fixture limit; it does not establish a SeedDuplex playback defect.
- The first utterance created one Pi task, which correctly waited for clarification. While the call remained open, a typed clarification completed that same task with the result “语音播报测试成功”. No web or computer tool was requested or used.
- The MacBook Air microphone recorded locally while the browser call was open. The recording was not retained and was not speech-transcribed, so it is not evidence that the physical playback was intelligible or that the user heard the right words.
- Ended the call and restored the default input to MacBook Air microphone. `system_profiler` confirmed MacBook Air microphone as default input and MacBook Air speakers as default output.

The live test now proves microphone injection through BlackHole can reach the public call and start a real Pi task. The remaining gap is an intelligibility check of the physical speaker output. Do not describe this as a complete microphone-to-Pi-to-audible-response pass.
