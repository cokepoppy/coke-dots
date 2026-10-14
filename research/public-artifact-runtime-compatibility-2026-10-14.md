# Public generated-file runtime compatibility check

Reviewed: 2026-10-14. This records a live failure reproduced in signed-in Chrome after the mobile web bundle update. The check was read-only apart from selecting an existing completed task in the UI.

## Observed failure

- The current `main` source and served `/dots-demo/` bundle include the chat `TaskArtifacts` component.
- In Chrome at `https://codex.cokeagent.com/dots-demo/`, selecting an existing completed HTML task caused the page to request `GET /dots-demo/api/tasks/:taskId/artifacts`.
- The actual authenticated browser request returned `404 Not Found`, and the rendered task card said `文件暂时无法读取`.
- The public UI also continued to receive HTTP 200 for `/api/auth/me`, `/api/auth/config`, `/api/voice-calls`, `/api/events`, and `/api/computer`. Those unrelated successes did not establish artifact support.

## Version boundary and cause

- The installed runtime source at `/Users/shangguan/Library/Application Support/Coke Dots Demo/app/src/server` has no artifact routes, `TaskArtifact` methods, or preview-ticket handler.
- The served frontend was built from current `main` (`index-BR0vTsX7.js`, `index-CQ1NhjWb.css`) and calls those missing routes. This frontend/control-plane skew is sufficient to explain the observed 404 before any worker request is made.
- The active legacy desktop Deployment used image tag `coke-dots-linux-desktop:sha-669852c`. That source revision predates the current worker `/v1/artifacts`, `/v1/artifact`, and `open-artifact` handlers. Updating only the installed API would therefore still leave the remote file operation unsupported. The other tenant desktop Deployments were also inspected; they had older image tags and no ready replicas in this snapshot.
- The repository already contains the corresponding control-plane and worker implementations, plus local worker-path, tenant-isolation, and Chrome E2E coverage. The release gap is that the installed demo runtime and tenant image were not updated together.

## Safe next verification

- Keep the supported UI and runtime versions aligned as a single release: frontend bundle, installed control-plane source, and tenant desktop/Agent image.
- Stage the control-plane delta on a copy of the installed runtime so Gmail/Teams and its other release-only code remain intact. Run its typecheck and focused artifact tests before replacing live source.
- Build an immutable worker image and pass the task-file Chrome/K3D flow in a disposable tenant. Preserve existing tenant PVCs.
- Before restarting or rolling out, recheck every tenant's running Agent task, desktop owner, desired/ready replicas, and PVC; this snapshot had three tenants, six waiting tasks, and no `working` task. Do not restart just to validate static UI.
- Final public acceptance must select an existing completed file task in authenticated Chrome, verify artifact-list and file-content responses, render the HTML preview, and verify the explicit cloud-browser action. A static asset hash or anonymous route check is insufficient.
