# SeedDuplex audio playback: root cause and verification

Updated: 2026-10-13 (Asia/Shanghai)

## Expected path

Pi produces the agent's task result as text. The browser sends that text to the active SeedDuplex session through the tenant's voice WebSocket. SeedDuplex returns synthesized speech audio, and the browser plays those frames through Web Audio. This is the configured Volcengine path; the older browser fallback uses browser speech recognition and `speechSynthesis` instead.

## Confirmed static-noise defect

SeedDuplex `response.output_audio.delta` frames contain normalized float32 PCM at 24 kHz. The earlier gateway labeled those bytes as int16 PCM, and the browser decoded them with `Int16Array`. That treats the two halves of every float sample as unrelated signed integers, which destroys the waveform and produces broadband static and distorted speech.

Commit `313efb0` fixes the boundary in both directions: the gateway validates float32 frame length and normalized samples, sends format marker `2`, and the browser removes that marker and decodes with `Float32Array` at 24 kHz. The code is in `src/server/volcengine-duplex-voice-gateway.ts` and `src/web/VoiceCall.tsx`.

## Evidence

- An earlier signed-in public probe used `index-COayIfjo.js` (SHA-256 `1b172450fc42083694ca98b8d26e9fece7046321c3c32f7554b8e71e750b1a27`). A fresh public GET on 2026-10-13 served `index-BFKMmF3z.js` (SHA-256 `a98829f54aa92954c5a4c50aa49de270daf54c3e62448c539aa3068d36d6419f`), which contains the Float32 decoder and playback call. An anonymous request to `/dots-demo/api/voice/provider` returns 401 because the endpoint requires a Dots session.
- The [signed-in public Chrome probe](seedduplex-public-playback-2026-10-12.md) received 17 real SeedDuplex frames marked float32: 635,277 bytes, 158,815 samples and 6.617 seconds of 24 kHz audio. All 17 browser audio sources connected to the output destination and ended. Waveform RMS was 0.0800, peak 0.3415, and lag-one correlation 0.9324. This probe sent text directly to SeedDuplex; it did not invoke Pi or capture physical speaker output.
- Local verification on 2026-10-12: `npm test` passed 130 tests; `npm run build` passed; `npm run test:e2e` passed 53 Chrome click-through steps and 8 cloud-computer checks. The voice step sends a Chinese transcript through a disposable mock task worker, sends the Agent's resulting text to a mock SeedDuplex service, and checks format marker, sample rate, energy, speaker-destination connection, and playback completion. Its mock is a generated dual tone, not recorded human speech.
- The public full-flow test is `npm run test:e2e:public-demo:voice-agent`. It synthesizes a Chinese microphone input, submits one task to the signed-in tenant's Pi cloud computer, verifies the completed result, captures the real SeedDuplex response, and checks the waveform before saving `assistant-reply.wav`. It requires a dedicated Google test account's mode-0600 storage state. No such state was configured during this verification, so the live microphone-to-Pi-to-SeedDuplex test and physical acoustic playback were not claimed as passed.

## Local and public version boundary

The main checkout's `src/web/VoiceCall.tsx` still uses browser `SpeechRecognition` and `speechSynthesis`; it does not contain the SeedDuplex audio-stream implementation. A local run from that checkout therefore does not use the Volcengine voice path. The deployed public bundle checked above does contain the SeedDuplex float32 decoder. Confirm the page URL and loaded asset when diagnosing a repeat report; a passing browser audio graph check does not prove what the Mac's physical speaker emitted.

## Decoder regression guard added on 2026-10-13

- The playback conversion is now a small shared function, `decodeVolcengineFloat32Pcm`, with a unit test for exact little-endian float32 values, clipping, invalid values, and malformed frame length. The browser copies those decoded samples directly into each 24 kHz Web Audio buffer.
- The authenticated public Chrome voice E2E now captures each returned float32 frame and compares every sample with the corresponding `AudioBuffer` immediately before playback. It fails if a frame is dropped, decoded as int16, altered beyond `1e-6`, not connected to the Web Audio destination, or not fully played. This specifically guards against a recurrence of the broadband-static decoder bug.
- The manifest names this evidence `webAudioPlaybackVerified`; it proves Chrome decoded and scheduled the provider samples through its audio destination. It does not claim a physical speaker or intelligibility check.
- Opt-in macOS verification with `DOTS_PUBLIC_VOICE_ACOUSTIC_CAPTURE=1` starts ffmpeg on the Mac's built-in microphone when Chrome begins a SeedDuplex reply, then compares the microphone recording's 20 ms loudness envelope with the provider PCM. The dedicated `test:e2e:public-demo:voice-agent-acoustic` command requires the same dedicated mode-0600 test-account state as the authenticated suite and writes both WAVs with mode 0600. This checks actual speaker-to-room-to-microphone output without requiring a virtual microphone; it is a physical playback check, while transcript correctness still comes from the asserted Pi task result and generated voice text.
- Local verification after this change: `npm test` passed 131 tests; `npm run build:demo` passed; the public E2E TypeScript file type-checked. The signed-in live Playwright run was not repeated because no dedicated mode-0600 test-account storage state was available. The user-facing Chrome acoustic evidence and its limits are in [the public check](seedduplex-public-acoustic-check-2026-10-13.md).
- The public HTML and its current script were fetched again on 2026-10-13. They served `index-BFKMmF3z.js`, SHA-256 `a98829f54aa92954c5a4c50aa49de270daf54c3e62448c539aa3068d36d6419f`; inspection found the float32 decode function and its Web Audio playback call. This verifies the public static bundle only; it does not prove which asset an already-open tab holds, which frames a particular live call received, or what reached the physical speaker. Hard-reload the page before the next acoustic run.
- Follow-up from the user: the Mac microphone recognizes and submits input, while the spoken response currently sounds like static. This is a user-reported symptom, not yet reproduced in a new controlled public call. The opt-in `test:e2e:public-demo:voice-agent-acoustic` path records the Mac's built-in microphone during SeedDuplex reply playback and compares its loudness envelope with the provider PCM. It uses generated browser input and needs a dedicated signed-in test-account storage state; the file was not present on this host during this implementation turn, so physical speaker output remains unverified.
