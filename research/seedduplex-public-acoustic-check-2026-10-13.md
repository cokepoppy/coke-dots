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

## Post-fix public-call input calibration (2026-10-13)

- Confirmed the public page currently serves `index-DIC2wYRp.js` (SHA-256 `327f410007f9ed3d4fa79686869c427b093889999433a294f3ad81be2690defd`). The Mac demo server process started at 07:21 China time, after the PCM alignment fix; the deployed runtime source sets both SeedDuplex output format fields to `pcm`.
- `system_profiler` showed MacBook Air microphone and MacBook Air speakers as the current default input/output. A generated Chinese calibration phrase played through the speakers was captured on the Mac microphone with RMS 0.04073 and peak 0.27164, against a 0.00445 baseline RMS.
- Opened a new signed-in public Chrome Call at 07:37 China time. The page connected to SeedDuplex and showed “正在聆听”. A short generated Chinese instruction was played through the Mac speakers while the built-in mic recorded. In the capture, the speech interval measured RMS 0.02448 and peak 0.33838; the page showed no recognized transcript and created no Agent task.
- This confirms the synthetic input reached the physical microphone, but not why SeedDuplex did not transcribe it. Browser echo cancellation or the synthetic-speaker input path may be involved; neither is proven. No assistant reply was generated, so this run does not test assistant playback and does not explain the reported static noise.
- The call was ended, the SQLite database reported zero open calls and `quick_check=ok`, and the temporary synthetic audio and microphone recording were deleted. System audio defaults were left unchanged.

## Public speaker-path follow-up (2026-10-13)

- The public domain served `/dots-demo/assets/index-DIC2wYRp.js` with SHA-256 `327f410007f9ed3d4fa79686869c427b093889999433a294f3ad81be2690defd`. This matched the local demo `dist` asset. The server on port 14318 was running from `/Users/shangguan/Library/Application Support/Coke Dots Demo/app`; its SeedDuplex source and gateway files matched this feature worktree byte-for-byte. The current source requests `pcm` in both `session.audio.output.format.type` and `session.extension.tts.audio_config.format`; the browser strips marker 2 and decodes little-endian float32 at 24 kHz.
- The official Volcengine O-version protocol docs distinguish `pcm` (24 kHz, 32-bit little-endian) from `pcm_s16le` (16-bit little-endian). A mismatch between the requested format and decoder explains the earlier broadband static defect. The fix aligns the two session fields and the browser decoder.
- In a signed-in public Chrome Call, generated Chinese microphone input created a Pi task on the tenant computer. Pi opened example.com, example.org, and example.net read-only and returned a Chinese result. That result is sent back to the same SeedDuplex session as speech text; SeedDuplex generates the audio frames and the browser schedules them to the output device.
- The Mac's built-in microphone recorded 24.15 seconds at 48 kHz while the response played through MacBook Air speakers. Active response windows had RMS around 0.014–0.053; the final quiet windows were around 0.004. This confirms acoustic output reached the physical microphone. It does not prove that the words were intelligible or that the user-perceived sound contained no static: on-device speech recognition was not authorized, and the capture was not retained.
- System Sound settings were restored and `system_profiler` confirmed MacBook Air microphone and MacBook Air speakers as the defaults. The prior format defect is fixed in the current public source/assets, but the user's latest static-noise report remained unconfirmed at the intelligibility level until the fresh playback check below.

## Current branch verification (2026-10-13)

- `npm test`: 133 unit tests passed.
- `npm run build:demo`: passed and produced `index-DIC2wYRp.js`, matching the currently served public bundle.
- `npm run test:e2e`: 53 local Chrome click-through steps and 8 cloud-computer checks passed. The voice path in this suite uses test doubles; this is not the signed-in public SeedDuplex test.
- The dedicated authenticated public storage state was not present. The signed-in public Chrome manual round trip is recorded above, but the automated public acoustic test and independent speech intelligibility check remain outstanding.

## Fresh public acoustic replay (2026-10-13)

- Repeated a new call in signed-in Chrome on `https://codex.cokeagent.com/dots-demo/`, with Pi selected. A generated Mandarin request was routed through BlackHole only as deterministic microphone input. The system output was switched back to MacBook Air speakers before the Pi response; the built-in microphone recorded the room output using AVFoundation.
- SeedDuplex recognized a request to read-only compare `example.com`, `example.org`, and `example.net`. Pi opened all three sites in the tenant cloud computer and returned a Chinese result saying all titles were `Example Domain`. The call ended through the visible UI control.
- A 19-second mono 48 kHz WAV of the captured speaker response is saved locally at `artifacts/voice-public-acoustic/assistant-reply-20261013.wav` (SHA-256 `8ed826071982765a45148f43745d9a1950f8208a61f8b9ad29c55cb39aa13681`). Its RMS is `0.03849`, peak `0.4013`, zero-crossing rate `0.0623`, and lag-one correlation `0.9498`; the quiet-room RMS baseline was `0.00411`. This is a strong signal-level indication that the speaker produced voice-like audio rather than broadband white noise.
- The capture was not independently speech-transcribed, so it does not prove word-level intelligibility or exclude residual hiss mixed with speech. The raw provider PCM was not retained, so sample-for-sample acoustic correlation remains outstanding. The accompanying local manifest records the exact request, task result, file hash, and evidence limits.
- System Sound defaults were restored to MacBook Air microphone and MacBook Air speakers; both Dots databases pass `PRAGMA quick_check`. The browser call was ended.

## SeedDuplex ASR replay of the captured reply (2026-10-13)

- Replayed the saved 19-second speaker capture into a fresh signed-in public Chrome Call using BlackHole as the temporary audio route. This puts the captured response back through the live SeedDuplex input/ASR path; it does not rely on offline speech recognition.
- SeedDuplex transcribed the reply as a comparison of `example.net`, `example.com`, and `example.org`, with all three titles equal to “Example Domain.” The transcript matched the Chinese Pi result and the response audio's spoken content. Pi then completed the resulting task in the tenant cloud computer.
- This confirms the captured response carried intelligible speech and was not only static. It cannot rule out a smaller amount of hiss mixed with the voice. The earlier format mismatch remains the confirmed root cause for the broadband-static defect: SeedDuplex output was requested as 32-bit float PCM, but the browser path had interpreted it as 16-bit PCM. The current VPS asset and session configuration use matching float32 PCM; the capture was made after this fix.
- Ended the public call and restored MacBook Air speakers and microphone as the default output and input. `system_profiler` confirmed both defaults.
