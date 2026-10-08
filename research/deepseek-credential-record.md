# DeepSeek model credential record

Originally configured on 2026-10-07 through the `可乐可乐 workspace · owner` profile. The Coke Dots shared-default migration promotes that existing profile to the local service's shared Model API configuration so other Google accounts can reuse it.

| Field | Recorded value |
| --- | --- |
| Provider | DeepSeek |
| API base URL | `https://api.deepseek.com` |
| Model | `deepseek-flash` |
| Credential storage | One instance-wide application Keychain entry reused by Model API, Pi, and DeepSeek Harness; the secret value is intentionally not copied into this repository or this record. |
| Verification | Submitted a real task through the workspace; it completed and returned the requested Chinese confirmation. |

To rotate the shared credential, the instance model manager updates the API key under **Profile → Model API**. The change applies to all Google accounts on this Coke Dots instance. The application stores the key separately from task data and reveals only whether a key is saved.

## Local development verification

On 2026-10-07, the local development database (`./data/dots.db`) was configured for its bootstrap `legacy` workspace with the same DeepSeek endpoint and model. The API key remains only in the macOS Keychain; it is intentionally absent from this file, shell output, task data, and source control.

The saved Keychain configuration was tested with `npm run test:live-model -- --keychain`, which uses the production model adapter and sends one small live request. Result: `status=done`, unique marker present, about 1.17 seconds. The check prints neither the key nor the model response body.

The Chrome-to-worker path was then verified with `npm run test:e2e:live-model`: a disposable account signed in through the local page, submitted a task by clicking the composer, and saw its real result in Activity. The worker returned `status=done` with the unique marker in about 2.17 seconds. Test account and task data were held in a temporary database and removed. Screenshot evidence: `artifacts/e2e/live-model-2026-10-07T13-04-28-700Z/live-model-task-completed.png`.
