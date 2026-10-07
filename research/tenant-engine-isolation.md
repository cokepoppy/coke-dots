# Tenant boundary for host-level agent kernels

## Why this boundary exists

Pi and DeepSeek Harness are started by the Coke Dots server process. Their current local adapters read credentials or configuration profiles from that host process. A Google sign-in creates a tenant identity; it does not mean the new user owns the Mac's already-authenticated CLI accounts. Exposing those engines to every tenant would let unrelated personal workspaces spend or inspect the host owner's runtime identity.

## Current policy

- Local host-level Pi and DeepSeek Harness adapters are visible and invokable only for the bootstrap tenant `legacy`.
- Claude Code is deferred: it is hidden from the engine picker and new task/delegation requests are rejected, even if a host `claude` binary is installed. The engine identifier remains only for rendering and failing any historical persisted Claude task clearly.
- The API rejects an attempt to create a task against one of those local adapters from another tenant. The worker also checks adapter availability before dispatch, and each adapter rejects direct non-bootstrap calls.
- Every tenant retains its own OpenAI-compatible Model API endpoint and key. The key remains tenant-scoped in Keychain; only workspace owners/admins can change shared Model API settings.
- Members inside one shared workspace use that tenant's runtime and Model API key. Per-member credentials inside a shared workspace are not supported.
- In the local UI, non-bootstrap tenants can configure their own Model API key instead of inheriting a host CLI login. Remote Debian desktop kernels follow their separate per-tenant runtime provisioning path.

This is Coke Dots' security policy, not a claim about OpenAI Dots. Per-tenant CLI profile setup is a follow-up: Pi exposes its agent config directory through an environment override, and the DeepSeek Harness Python SDK requires an explicit Harness home; the current product does not yet provide user-managed login/profile setup for those runtimes. See the [Pi config path implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/config.ts) and [DeepSeek Harness SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md).

## Verification

- Unit coverage checks that Claude Code remains unavailable even if a host binary is configured, and rejects Claude delegation.
- Chrome E2E checks that personal and shared tenants cannot select or invoke Claude Code and that a rejected task request creates no task.
- Chrome E2E also accepts Beta into a separate shared workspace and verifies tenant separation. A regular member cannot change the workspace's model credential in the UI or through the API.
- `npm test` uses a dedicated Keychain service namespace, and the browser E2E gives its temporary server a random namespace so tests cannot read or modify a real workspace credential.
