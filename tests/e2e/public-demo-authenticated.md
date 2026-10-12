# Authenticated public Dots E2E

Use a dedicated Google test account and save its Dots session outside this checkout. The setup opens a visible Chrome window and pauses while you complete Google's normal sign-in. It never reads or stores the Google password.

```sh
DOTS_PUBLIC_DEMO_STORAGE_STATE="$HOME/.local/state/coke-dots/public-e2e-state.json" npm run test:e2e:public-demo:auth-setup
DOTS_PUBLIC_DEMO_STORAGE_STATE="$HOME/.local/state/coke-dots/public-e2e-state.json" npm run test:e2e:public-demo:authenticated
```

The setup writes only the `coke_dots_session` cookie for the Dots origin, with file mode `0600`. It excludes Google cookies, OAuth state, and other-origin storage. Keep the file private and remove it when the test account is no longer needed.

The authenticated run clicks into the cloud-computer view and opens the desktop once if it is not ready. It checks the rendered desktop image, authenticated computer state, screenshot response, and visible errors. It does not create an Agent task, take over the desktop, or repeat a failed open request. Run it against a dedicated test account or tenant because desktop provisioning changes that tenant's cloud-computer state.
