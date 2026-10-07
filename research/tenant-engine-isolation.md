# Tenant boundary for host-level agent kernels

## Why this boundary exists

Pi and DeepSeek Harness are started by the Coke Dots server process. Their current local adapters read credentials or configuration profiles from that host process. A Google sign-in creates a tenant identity; it does not mean the new user owns the Mac's already-authenticated CLI accounts. Exposing those engines to every tenant would let unrelated personal workspaces spend or inspect the host owner's runtime identity.

## Current policy

- Local Pi and DeepSeek Harness adapters are visible to a Google-authenticated tenant only when its owner/admin has saved that workspace's Model API credential. The key is read from the tenant's Keychain entry and must not fall back to test or host environment values.
- Claude Code is deferred: it is hidden from the engine picker and new task/delegation requests are rejected, even if a host `claude` binary is installed. The engine identifier remains only for rendering and failing any historical persisted Claude task clearly.
- The API rejects a task against an unavailable adapter. The worker checks availability again before dispatch; the adapters independently require explicit workspace settings for non-bootstrap tenants.
- Every tenant retains its own OpenAI-compatible Model API endpoint and key. The key remains tenant-scoped in Keychain; only workspace owners/admins can change shared Model API settings.
- Members inside one shared workspace use that tenant's runtime and Model API key. Per-member credentials inside a shared workspace are not supported.
- Pi receives a workspace-specific OpenAI-compatible model registration and a runtime-only API key through an in-memory Pi `AuthStorage`. Its agent settings directory is isolated under `data/tenants/<tenant>/agent-runtime/pi`; native task sessions remain in the task workspace.
- DeepSeek Harness receives the workspace model, endpoint, and API key in a child environment assembled from a small allowlist. Its `HOME`, `DSH_HOME`, and XDG directories point to `data/tenants/<tenant>/agent-runtime/dsh`, never the host home. The SDK replaces the child environment when `launch.env` is supplied, and upstream credential resolution gives that launch snapshot precedence over the invoking workspace `.env`; this keeps a project file from redirecting the workspace's selected provider key. The deployment selects a DSH profile explicitly. Every profiled task receives a mode-`0600`, task-local Cordis patch that disables built-in shell, filesystem, web, subagent, and workflow tools. A task with public-page research also gets a short-lived plugin that reaches only the active tenant's existing read-only browser capability through a token-authenticated loopback bridge. Temporary files are removed after the run. Remote Debian desktop kernels retain their separate per-tenant runtime provisioning path. See the [SDK environment contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md) and [Harness launch environment rules](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/launch-environment/README.md).
- Members in one shared workspace use that workspace's shared model credential and runtime profile. Owners/admins manage the credential; per-member model credentials are not supported.

This is Coke Dots' security policy, not a claim about OpenAI Dots. User-managed login/profile setup for Pi and DeepSeek Harness is not provided; each authenticated workspace instead supplies its own Model API credential while runtime state is isolated by tenant. See the [Pi config path implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/config.ts) and [DeepSeek Harness SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md).

## Verification

- Unit coverage checks that process-wide test credentials cannot enable a local engine for another tenant, Pi receives a runtime-only workspace credential, DeepSeek Harness does not inherit unrelated host secrets, and tenant runtime directories reject cross-tenant symlinks.
- Chrome E2E saves a runtime credential through the owner UI, verifies Pi and DeepSeek Harness become available in that workspace and remain unavailable in another tenant, and confirms a shared-workspace member inherits availability without gaining permission to replace the key. Claude Code remains unavailable and delegation to it is rejected.
- Chrome E2E also accepts Beta into a separate shared workspace and verifies tenant separation. A regular member cannot change the workspace's model credential in the UI or through the API.
- `npm test` uses a dedicated Keychain service namespace, and the browser E2E gives its temporary server a random namespace so tests cannot read or modify a real workspace credential.
