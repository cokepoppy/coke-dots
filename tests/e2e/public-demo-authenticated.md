# Authenticated public Dots E2E

Use a dedicated Google test account and save its Dots session outside this checkout. The setup opens a visible Chrome window and pauses while you complete Google's normal sign-in. It never reads or stores the Google password.

```sh
DOTS_PUBLIC_DEMO_STORAGE_STATE="$HOME/.local/state/coke-dots/public-e2e-state.json" npm run test:e2e:public-demo:auth-setup
DOTS_PUBLIC_DEMO_STORAGE_STATE="$HOME/.local/state/coke-dots/public-e2e-state.json" npm run test:e2e:public-demo:authenticated
```

The setup writes only the `coke_dots_session` cookie for the Dots origin, with file mode `0600`. It excludes Google cookies, OAuth state, and other-origin storage. Keep the file private and remove it when the test account is no longer needed.

The authenticated run clicks into the cloud-computer view, waits for its first real `/api/computer` response, and opens the desktop once only when that response says it is not ready. It checks the rendered desktop image, authenticated computer state, screenshot response, browser errors, failed HTTP responses, and—after a full reload—persisted state when an optional task run is enabled. It never repeats a failed open or task submission.

The default authenticated run is read-mostly, except that it may click **打开电脑** once if the dedicated test tenant has no running desktop. To test the real deployed model and chat path too, explicitly opt in:

```sh
DOTS_PUBLIC_DEMO_STORAGE_STATE="$HOME/.local/state/coke-dots/public-e2e-state.json" DOTS_E2E_PUBLIC_MODEL_TASK=1 npm run test:e2e:public-demo:authenticated
```

That option creates exactly one uniquely marked Chinese task through the page composer, waits up to three minutes for a completed result, and checks its conversation after reload. It calls the configured live model and leaves the task in the dedicated test account's history. Do not enable it for a personal workspace. If it fails or times out, inspect the saved task and public Activity before deciding whether to retry; the test itself never retries.

The anonymous script `npm run test:e2e:public-demo` checks the deployed public page, static assets, and OAuth redirect wiring only. Local `npm run test:e2e` uses a disposable app and mock model/runtime. Those two results do not prove the authenticated VPS task flow. The authenticated script above is the only one in this suite that verifies the deployed signed-in computer; its optional task switch also verifies the real public model and persisted chat path. Neither public test currently sends speech to a realtime voice model.
