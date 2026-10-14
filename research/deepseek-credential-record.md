# DeepSeek model credential record

Originally configured on 2026-10-07 through the `可乐可乐 workspace · owner` profile. The Coke Dots shared-default profile is reused by every Google account and workspace on the instance.

| Field | Recorded value |
| --- | --- |
| Provider | DeepSeek |
| API base URL | `https://api.deepseek.com` |
| Model | `deepseek-flash` |
| Credential storage | One instance-wide Kubernetes Secret in the local K3D cluster, reused by Model API, Pi, and DeepSeek Harness; the secret value is intentionally not copied into this repository or this record. |
| Verification | The credential has previously completed real Chinese task requests. Re-run the live verification after migrating it to the K3D Secret. |

To rotate the shared credential, the instance model manager updates the API key under **Profile → Model API**. The application writes it to the instance Secret in the `coke-dots-system` namespace. The setting applies to every Google account on this Coke Dots instance. The endpoint and model name remain ordinary instance metadata; the API key is not stored in ConfigMap, task data, or the shared PVC.

## Local development verification

The live model check reads the current K3D Secret and sends one small real request through the production model adapter:

```sh
npm run test:live-model -- --k3d-secret
```

The command prints status and timing only; it does not print the key or model response. `npm run test:live-model` can also take `DOTS_LIVE_MODEL_API_KEY`, or `--stdin-key` reads a key without terminal echo; those modes do not persist it.

The Chrome-to-worker path is verified separately with `npm run test:e2e:live-model`: a disposable account signs in through the local page, submits a task by clicking the composer, and sees its result in Activity. The test uses a temporary Secret backend and database, then removes both.
