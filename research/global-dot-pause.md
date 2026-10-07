# Global Dot pause: evidence and implementation

Research date: 2026-10-07.

## Product evidence

OpenAI's [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) describes a Dot as an always-on agent that can continue work between conversations. It says to open the Dot profile's `•••` menu and select **Pause** to stop it until ready to resume; the resume label is **Paused • Tap to resume**. The article also places Activity and the Dot computer in the profile, and describes scheduled and proactive work.

The product source establishes the entry point and visible action labels. The reviewed hands-on YouTube videos do not show this menu being opened or the pause flow. The article does not define task cancellation/restart semantics, the effect on in-flight requests, workspace roles, or the menu's exact visual dimensions. Those details remain implementation choices pending direct product access or new evidence.

## Coke Dots behavior

- Pause state is persisted for the active tenant, so other personal tenants and shared workspaces remain independent.
- The profile `•••` menu exposes Pause and the documented resume label. In a shared workspace, only an owner or admin can change the setting; both the button and API enforce this boundary.
- New work remains queued while paused. An active supported engine request is aborted and its task becomes paused. Resume returns those tasks to queued or scheduled state and allows the worker to pick them up again.
- A scheduled page-monitor check in flight is aborted. Its watch remains active and checks again on its next interval. Other tenants' monitors continue.
- The UI reflects the pause state from the server snapshot. The state is included in tenant-scoped persistence.

These are local product decisions; they do not claim to reproduce unseen OpenAI runtime details.

## Verification

- `npm test`: 48 tests passed, including tenant persistence/isolation, worker queue gating and resume, and active monitor interruption.
- `npm run test:e2e`: passed. The Chrome flow pauses a running task through the profile menu, confirms the late response is not committed, checks the shared-workspace member's 403 response and disabled control, confirms another tenant remains active, then resumes and verifies the task completes once.
- The same E2E command also passed the existing Linux cloud-computer browser flow.
- Run artifacts: `artifacts/e2e/2026-10-07T05-17-00-072Z` and `artifacts/e2e/linux-cloud-computer-2026-10-07T05-18-50-062Z` (ignored local output).

The screenshots and click path verify Coke Dots' behavior. They are not Dots reference frames, so they do not establish pixel parity for the profile menu.
