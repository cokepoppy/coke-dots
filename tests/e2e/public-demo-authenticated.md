# Authenticated public voice E2E

Use a dedicated Google test account. Save the Coke Dots session outside this checkout with file mode `0600`; never export the everyday Chrome profile.

```sh
DOTS_PUBLIC_DEMO_STORAGE_STATE="$HOME/.local/state/coke-dots/public-voice-state.json" npm run test:e2e:public-demo:auth-setup
DOTS_PUBLIC_DEMO_STORAGE_STATE="$HOME/.local/state/coke-dots/public-voice-state.json" npm run test:e2e:public-demo:voice
```

The setup opens a visible Chrome window for the normal Google sign-in and stores only the `coke_dots_session` cookie for the Dots host and `/dots-demo` path. It does not store Google cookies, passwords, OAuth state, or other-origin browser storage.

The voice test opens the deployed public page in Chrome, clicks **拨打 Dot**, connects to the real SeedDuplex service, and checks that returned Chinese speech is decoded, reaches the browser's audio output destination, and finishes playing. It sends synthesized text to the voice service without creating a Pi task. Set `DOTS_E2E_HEADFUL=1` to hear the response through the Mac's selected output device. The saved WAV and manifest let you inspect the actual response and its playback evidence.

To test spoken input through the real public SeedDuplex ASR and Pi Agent running in the tenant cloud computer, run:

```sh
DOTS_PUBLIC_DEMO_STORAGE_STATE="$HOME/.local/state/coke-dots/public-voice-state.json" npm run test:e2e:public-demo:voice-agent
```

This injects a deterministic Chinese request through Chrome's fake microphone, requires an already-running tenant cloud computer with Pi selected, submits one read-only `example.com` task, and checks the recognized request, completed Chinese Agent result, browser audio output, and saved assistant WAV. It does not start or restart the cloud computer. This makes real provider and model requests and leaves one task in the dedicated test account's history. Do not use a personal workspace for this variant.

The browser test confirms that Chrome's audio output graph completed playback. It does not independently record sound from a physical speaker; `DOTS_E2E_HEADFUL=1` makes the playback audible for a human listening check. Artifacts are written under `artifacts/e2e/` with restrictive file permissions. A missing or invalid dedicated-account state fails before Chrome or the voice service is opened.
