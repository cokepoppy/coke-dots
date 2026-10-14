# Coke Dots contributor instructions

These instructions apply to every change in this repository. Read the Coke Dots task group in `/Users/shangguan/.codex/memories/MEMORY.md` and the linked incident note before changing branches, cloud-computer behavior, voice/call UI, model settings, or the public demo. Recheck the live repository and runtime state; memory is a guide, not proof that a remembered deployment or branch is still current.

## Branch and integration workflow

- `origin/main` is the only canonical base. Fetch before starting work; on this Mac, use the command-scoped Git proxy `git -c http.proxy=http://127.0.0.1:7890 ...`. Never change global proxy settings.
- Inspect `git status`, the current branch and its upstream, `origin/main`, and ancestry before editing. Create one feature branch from the latest `origin/main` for each feature. Do not build a new feature on an old feature branch.
- Preserve unrelated changes and untracked files. Stage only files for the intended feature. Do not silently reset or overwrite the worktree.
- After a feature is complete and its relevant checks pass, promptly push the feature and fast-forward `main` to the verified commit. Confirm remote `main` with `git ls-remote`; then return the checkout to `main` before starting another feature. A feature branch push alone is not integration.

## Verification and runtime boundaries

- Keep local tests, anonymous public smoke tests, and signed-in Chrome tests against `https://codex.cokeagent.com/dots-demo/` distinct in reports. Public behavior claims require the signed-in browser flow and the relevant authenticated state; do not infer success from a build or HTTP 200.
- The public demo is a separate installed runtime at `/Users/shangguan/Library/Application Support/Coke Dots Demo/app`. Before a release, inspect its source/build/database and active work, back up the release state, deploy only the tested delta, and verify served asset hashes and the real Chrome flow. Do not overwrite the whole runtime from an older checkout or disturb unrelated VPS services.
- For cloud-computer incidents, trace the actual tenant and deployed runtime through API response, worker/image, Pod, browser readiness, proxy egress, model dispatch, and rendered UI. `Pod Ready` or a generic health endpoint alone does not establish root cause.
- The Agent kernel runs inside each tenant's Debian cloud computer. Preserve tenant boundaries for runtime, workspace, task, and session data; shared model configuration is instance-wide.
- Before editing call UI, inspect the current deployed compact floating-call experience and its asset/version. Do not reintroduce an older full-screen call modal from a stale branch.

## Memory and incident follow-through

- For each resolved incident, add a concise local memory note with the visible symptom, verified cause, component/version boundary, fix, actual tests, commit, and whether `main` and public Chrome were checked. Never put API keys, passwords, OAuth codes, or session tokens in memory or Git.
- If a new observation resolves an older pending note, record which note it supersedes. Preserve historical records, but do not report stale pending state as current.
- Before finishing, report the current branch and `main` commit, integration state, exact test scope, and remaining unverified behavior.
