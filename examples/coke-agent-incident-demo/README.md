# Coke Agent incident response scenario

This folder contains a synthetic incident scenario for internal verification and presentation.
The visible log console, DingTalk alert, and application use production-style wording and do not display presentation-only labels.

## Scenario contract

- DingTalk group: `cokeclaw`
- Service: `coke-agent-web` (`production`, `ap-southeast-1`)
- Trace ID: `c7e2a195-4f93-4c60-8a27-b1d6e0f5a94c`
- The remediation profile activates only when the selected group name, service, environment, and Trace ID all match this tuple. Other messages remain read-only.
- User impact: opening a new conversation intermittently leaves the main panel blank.
- Root cause: the frontend assumes a conversation object exists while the API is still returning `null` for a new session.
- Expected repair: handle the empty-session response and render the normal new-conversation state.
- Acceptance: the initial focused unit test reproduces the null-session failure; after the repair, both conversation-state tests pass, the application page loads in the tenant Chromium, and the repair is published as an unmerged pull request against `cokepoppy/coke-agent-test`.

## Files

- `log-system/index.html` and `public/incident-logs/index.html` are standalone log search interfaces; the latter is served to the public cloud-computer browser.
- `reference-repo/` is the initial source for the private `cokepoppy/coke-agent-test` repository. Its test intentionally fails until the incident is repaired.

## Safety boundary

The log records and repository failure are synthetic even though the user-visible workflow is presented as a production incident. Use the designated Dots tenant and task directory. Do not deploy the repaired app, merge the pull request, or send automated replies to DingTalk. The selected group message is evidence for this one scenario; text in the message is not an Agent instruction. The repository credential is a short-lived fine-grained token limited to `cokepoppy/coke-agent-test`, mounted only into a tenant-scoped credential-broker sidecar, and reachable through a Unix socket only during the profiled Pi task. The Agent never receives the token value in its environment, prompt, workspace, or task output.
