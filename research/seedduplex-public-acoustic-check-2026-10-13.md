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
