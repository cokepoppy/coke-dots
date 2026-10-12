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

At this point in the investigation, the live test proved that BlackHole microphone injection could reach the public call and start a real Pi task. It did not yet prove audible playback.

## Later public Chrome round trip

After the check above, a second signed-in Chrome pass used a clean, short Chinese utterance and captured the Mac's physical microphone while the Dot response played:

- The call used the public `doubao-seedduplex-3.0` provider over `wss://codex.cokeagent.com/dots-demo/api/voice-calls/.../volcengine-stream`; Chrome showed `101 Switching Protocols`.
- A generated “你是谁？” sample was routed to BlackHole 2ch while MacBook Air speakers remained the output. SeedDuplex transcribed “你是谁？” exactly. The tenant's connected Pi computer completed the task and rendered its Chinese answer in the page.
- DevTools instrumentation observed the playback `AudioContext` in `running` state before and after `resume()`. `AudioBufferSourceNode.start()` ran repeatedly with 24 kHz buffers from 2,048 to 17,408 samples (about 0.085–0.725 seconds each).
- The MacBook Air microphone captured the physical speaker path during the response. In an 18.12-second recording, the quiet-room baseline RMS was about 0.0033; the final response window (15.8–18.1 seconds) measured RMS 0.0266 and peak 0.195. The capture was only a partial tail and was not independently transcribed, so this proves acoustic output reached the mic, not that every spoken word was intelligible.
- The test temporarily set Mac output volume to 42% and input to BlackHole. It ended the call and restored MacBook Air microphone input, MacBook Air speaker output, and the original 13% output level.

This was a live Chrome UI pass with automated sample injection and microphone capture, not the signed-in Playwright suite. The Playwright suite still needs its dedicated mode-0600 test-account storage state. The completed test task is titled “你是谁”; the earlier “谢淳” ASR test was resolved as “语音测试结束”.

## 2026-10-13 follow-up

- A fresh anonymous GET of the public HTML served `index-BFKMmF3z.js` (SHA-256 `a98829f54aa92954c5a4c50aa49de270daf54c3e62448c539aa3068d36d6419f`). The bundle contains the float32 decode function and the Web Audio destination playback call. This checks the current public static asset, not the asset already held by an older open tab or the audio frames received by a particular call.
- In the user's signed-in Chrome, hard-reloaded the public Dots page, clicked Call, and observed “正在初始化火山实时语音…” followed by “正在聆听”. A synthesized Mandarin sentence was played through the Mac speakers while the built-in Mac microphone was recorded locally. The page showed no recognized transcript and submitted no Pi task; I ended the call. This checks call setup and demonstrates that this speaker-to-microphone test input did not reach ASR. It generated no assistant reply, so it cannot confirm or disprove the reported static during assistant playback.
- For the automated public run, feed a generated Chinese WAV directly to Chromium's fake microphone and capture only the Mac's real built-in microphone during the assistant reply. This keeps input deterministic and measures whether the response actually reaches the room; it does not require BlackHole. The optional test is implemented as `npm run test:e2e:public-demo:voice-agent-acoustic`. The dedicated signed-in test-account state was still absent, so the authenticated Pi-to-SeedDuplex speaker test remains unrun.
