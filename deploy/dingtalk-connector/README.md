# Coke Dots DingTalk connector gateway

This is an isolated DWS connector service. It is not the tenant cloud-computer Agent runtime and it does not replace the DingTalk Stream robot gateway. Pi/DSH remain in each tenant's Debian cloud computer; that Agent integration is a later feature which must call scoped connector operations rather than read DWS profile files.

## Credential and identity boundary

- The Coke Dots server authenticates the signed-in user, then sends a short-lived HMAC principal ticket plus a separate service token to this internal service.
- The ticket binds one Dots tenant and one Dots user. The browser never receives either gateway credential.
- DWS profiles are stored as AES-256-GCM encrypted archives on the gateway PVC. `DINGTALK_CONNECTOR_ENCRYPTION_KEY` must be a base64-encoded random 32-byte key from a Kubernetes Secret, separate from the PVC. Per-user archive encryption keys are derived from that master key and the tenant/user identity hash.
- DWS plaintext profiles and temporary archives use only `/run/dws`, which must be mounted as a bounded memory-backed `emptyDir`. No DWS data is written to the desktop Agent workspace or Coke Dots SQLite database.
- The gateway exposes read-only group search. It does not start monitoring, subscribe every chat, send messages, create a robot, write a document, or trigger an Agent task.
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

## User-visible contract

`dws auth login --device --no-browser --format json` runs with a per-user isolated DWS HOME. Only the official `https://login.dingtalk.com` verification URL and its user-entered code are returned to the authenticated user. Access tokens, device codes, raw stderr, and CLI config never enter UI responses or logs. A connected identity means DWS identity readback succeeded; it does not imply that IM search, group monitoring, or document permissions are enabled.
