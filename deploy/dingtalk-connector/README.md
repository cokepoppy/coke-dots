# Coke Dots DingTalk connector gateway

This is an isolated DWS connector service. It is not the tenant cloud-computer Agent runtime and it does not replace the DingTalk Stream robot gateway. Pi/DSH remain in each tenant's Debian cloud computer. A Pi/DSH tool bridge for the document operations described below is a later feature; Agents must call scoped connector operations rather than read DWS profile files.

## Credential and identity boundary

- The Coke Dots server authenticates the signed-in user, then sends a short-lived HMAC principal ticket plus a separate service token to this internal service.
- The ticket binds one Dots tenant and one Dots user. The browser never receives either gateway credential.
- DWS profiles are stored as AES-256-GCM encrypted archives on the gateway PVC. `DINGTALK_CONNECTOR_ENCRYPTION_KEY` must be a base64-encoded random 32-byte key from a Kubernetes Secret, separate from the PVC. Per-user archive encryption keys are derived from that master key and the tenant/user identity hash.
- DWS plaintext profiles and temporary archives use only `/run/dws`, which must be mounted as a bounded memory-backed `emptyDir`. No DWS data is written to the desktop Agent workspace or Coke Dots SQLite database.
- The gateway exposes read-only group search, a per-user, per-group personal IM event stream, and separate scoped document search/read/create/update operations. The Dots API supervises only groups that the signed-in user explicitly selected and enabled; it converts normalized events into tenant-scoped, read-only Pi investigation tasks. Document writes require an explicit `confirmed: true` and a stable request ID. The gateway does not subscribe to every chat, send chat messages, create a robot, or access the tenant Agent workspace.
- Document writes use a durable per-tenant/user idempotency journal on the connector PVC. It stores request fingerprints, operation state, and receipts, but not document contents. If a write has an ambiguous outcome, the same request ID is blocked and the caller must inspect the document before starting a new operation.
- Removing an account deletes Coke Dots' encrypted local profile. It does not claim to revoke DingTalk's server-side OAuth grant.

## Build and run

Build from the repository root so `COPY` paths resolve. The Dockerfile pins DWS v1.0.64 archives by official release SHA-256 and the runtime verifies the extracted binary SHA-256. Build separately for each target architecture; do not load an ARM64 image into the amd64 VPS or vice versa.

Required runtime settings:

- `DINGTALK_CONNECTOR_SERVICE_TOKEN`: random service-to-service bearer token.
- `DINGTALK_CONNECTOR_TICKET_SECRET`: independent random HMAC key for short-lived tenant/user tickets.
- `DINGTALK_CONNECTOR_ENCRYPTION_KEY`: independent base64-encoded 32-byte profile encryption key.
- `DINGTALK_CONNECTOR_STORAGE_ROOT`: PVC mount, default `/var/lib/dws/profiles`.
- `DINGTALK_CONNECTOR_TMP_ROOT`: memory-backed temporary mount, default `/run/dws`.

Install `deployment.yaml` only in an explicitly prepared cluster after creating the named Kubernetes Secret. The manifest creates a distinct Deployment, Service, and PVC; it does not alter the cloud-computer image, Stream gateway, model Secret, Router, or Keycloak. The Dots API needs server-only `DINGTALK_CONNECTOR_GATEWAY_URL`, `DINGTALK_CONNECTOR_SERVICE_TOKEN`, and `DINGTALK_CONNECTOR_TICKET_SECRET` values to call it.

## Local macOS demo (no container)

The gateway can run as a separate native macOS process for local development. This mode is opt-in with `DINGTALK_CONNECTOR_ALLOW_MACOS_RUNTIME=1`; the default Linux/Kubernetes mode is unchanged. It binds to `127.0.0.1` and rejects non-loopback binds. It uses a separate local-demo profile directory under `~/Library/Application Support/Coke Dots DWS Local Demo`, not the public demo's connector data. Temporary DWS data is placed under the current user's OS temp directory. DWS Keychain integration is disabled so profiles stay isolated per Dots principal.

The local mode uses `~/Library/Application Support/Coke Dots Demo/tools/dws/bin/dws` by default; override it with `DINGTALK_CONNECTOR_DWS_BINARY` if needed. The runtime verifies its binary SHA-256 against the official v1.0.64 release pin before use. Run `npm run dws:local` to start the standalone gateway. On first start it generates separate random service, ticket, and profile-encryption keys and saves them in a mode-0600 file under `~/Library/Application Support/Coke Dots DWS Local Demo`; it never reuses Kubernetes secrets or public-runtime profile data. The local gateway is independent of VPS/K3D; the public Dots API will continue using its configured VPS connector until a separate, tested endpoint switch is made.

## User-visible contract

`dws auth login --device --no-browser --format json` runs with a per-user isolated DWS HOME. Only the official `https://login.dingtalk.com` verification URL and its user-entered code are returned to the authenticated user. Access tokens, device codes, raw stderr, and CLI config never enter UI responses or logs. A connected identity means DWS identity readback succeeded; it does not by itself prove that IM search, group monitoring, or document permissions work. The selected-group listener uses the personal IM event stream and can receive ordinary messages without an @mention. This is separate from the instance-wide DingTalk Stream robot callback client, which only receives messages addressed to the robot. Disconnecting the DWS identity stops its selected-group listeners; it does not alter the shared robot Stream credentials.

The signed-in Dots API currently provides `POST /api/dingtalk/docs/search`, `/fetch`, `/create`, and `/update`. Search and fetch are read-only. Create and update require `confirmed: true`; the connector checks the DWS operation receipt and durably records the request ID to prevent duplicate writes after retries or gateway restarts. A lost or partial write receipt is not automatically retried. This is a server-side connector capability only: the tenant Agent has no document tools yet, and this phase has no user-facing document workflow or public-release claim.
