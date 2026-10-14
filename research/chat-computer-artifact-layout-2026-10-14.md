# Chat, cloud-computer, and generated-file layout decision

Reviewed: 2026-10-14. This note records the evidence and UX decision for `feature/chat-computer-workspace-layout`.

## Product evidence

| Source | Observation | What it supports | Limit |
| --- | --- | --- | --- |
| [OpenAI: Meet dots](https://learn.chatgpt.com/docs/dots) | A Dot has its own cloud computer and browser. The user can keep talking to the Dot while work continues. The Dot profile exposes Computers, recent Activity, and task outputs; opening the computer and taking over are separate actions. | Keep the conversation as the primary surface, with the Dot context panel showing computer entry and task state. The computer is an explicit view with a separate ownership state. | Product prose does not specify exact dimensions, whether a live thumbnail exists in every version, or responsive behavior. |
| [OpenAI: Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory) | Users can switch tasks, change priorities, continue talking while agents work, and inspect task progress, files, results, or requests for input from Activity. | Keep task results reachable from the conversation and task context; do not require navigating the remote file manager to find an output. | Does not specify that every completed task must automatically open a preview. |
| [OpenAI: Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps) | The cloud computer has its own files and browser. Users open it, inspect the current screen, then explicitly take over and return control. | Keep “open in cloud computer” distinct from an in-chat file preview. The computer action can hand control to the user. | Does not promise that files in the cloud workspace have a public or local-machine URL. |
| [OpenAI: Work with files](https://learn.chatgpt.com/docs/artifacts-viewer?surface=app) | The ChatGPT app can preview generated files alongside chat. When available, HTML/HTM can open as an interactive preview; the user can also inspect source and download. | Use an in-chat interactive preview for HTML, with download and a separate cloud-computer action. | General file guidance, not a promise that every Dots surface previews every format. |

## Video evidence

| Video and time | Visible state | Interpretation |
| --- | --- | --- |
| [John Aspinall hands-on](https://www.youtube.com/watch?v=Q9tF0R8d_Co), 04:42–04:50 | Chrome recheck at 04:42 shows a separate browser desktop with “Roger has control” and “Take over”. By about 04:50, the desktop remains visible and ownership reads “You have control” with “Return control”. | Computer inspection and control are shown on a dedicated computer surface. The live desktop is not shown as a persistent chat-side panel in this sequence. |
| [John Aspinall hands-on](https://www.youtube.com/watch?v=Q9tF0R8d_Co), 05:40 | The main pane is the Dot conversation. The right context pane shows Dot identity, Call/Slack, Computers, Recent activity, and Outputs. No live desktop image is visible in that right pane. | Supports a right-side Dot context panel, not a right-side live desktop preview. The recording is compressed and cannot provide reliable CSS-pixel measurements. |
| [Futurepedia hands-on](https://www.youtube.com/watch?v=V_1Vn2WfpEY), 09:28 | Generated thumbnail outputs appear in the conversation, and the user requests a visual revision; a revised thumbnail then appears in the conversation. | Supports returning reviewable artifacts directly in the conversation and iterating there. The video does not show an HTML game or prove a specific file-opening interaction. |
| [Futurepedia hands-on](https://www.youtube.com/watch?v=V_1Vn2WfpEY), 05:07 | A Scratchpad page is shown in a split view with conversation, page navigation, and document content. | This is a document/Pages view. It is not evidence that the cloud computer is permanently docked beside every conversation. |

These are direct observations from the retained Chrome-visible samples documented in `john-aspinall-v2-observations.md` and `futurepedia-v1-observations.md`. Video composites are evidence of structure and interaction only; source viewport and CSS dimensions are unknown, so no pixel-parity claim is made from them.

## Decision

Keep the conversation in the center and the Dot details panel on the right. The right panel continues to show the connected computer entry, activity, and outputs. Keep the full cloud-computer view behind the Computers entry; use Take over and Return control to communicate ownership explicitly. The references do not support keeping a live computer image docked to the chat at all times.

Put task files next to the completed task in the conversation. For the first previewable HTML file, open a sandboxed interactive preview automatically when the completed task is selected. List all outputs with their names and sizes. Keep Preview/Collapse and Download actions, and add “在新标签页打开” for HTML so the user can inspect an interactive result at full size in the browser. On click, request a fresh short-lived preview ticket bound to that tenant and task; serve the page and relative assets through the sandboxed preview route. This does not expose a workspace filesystem path or publish a permanent public URL. Keep “在云电脑中打开” as a separate action for inspecting the actual remote browser or taking over its controls.

For an HTML game such as Tetris, the shortest path is: select the completed task (or open it from Recent/Outputs) → see and play the inline preview → optionally open the same file in the cloud computer to inspect the browser or take over. The user's previous file-manager path search and manual drag into Chrome should not be necessary.

## Verification contract

The Chrome click-through must create an HTML file with a relative JavaScript asset, select its completed task, and verify the game text appears without clicking Preview. It then checks collapse/reopen, opens the same game in a new authenticated browser tab and verifies the relative script loaded, downloads it, opens it in the tenant's cloud browser, returns control, and confirms another tenant receives 404 for list/content/file/preview/open requests. This proves Coke Dots behavior in the local browser suite; public signed-in Chrome must be reported separately and must identify the bundle/revision it actually served.

## Public baseline check

On 2026-10-14, signed-in Chrome at `https://codex.cokeagent.com/dots-demo/` showed the completed Tetris response and a filesystem path, but no generated-file card or inline preview. A read-only request to `/dots-demo/api/tasks/{taskId}/artifacts` returned `{"error":"Not found"}`, so the artifact API from this feature branch is not present in the public runtime. The public root `/api/health` identifies `coke-openrouter`; Dots API requests must stay under `/dots-demo/api`.

The installed demo source does not match this feature branch and does not contain `src/web/TaskArtifacts.tsx`. A whole-app sync from this branch would replace later live functionality. The branch now builds with the `/dots-demo/` asset base and routes browser API calls and preview URLs through that prefix, but public feature E2E remains pending integration into the live runtime baseline and deployment of the matching cloud-worker artifact endpoints.

## Implementation and verification

- The selected completed task lists its tenant-scoped files inline. A previewable HTML output opens automatically in a sandboxed preview; the card also supports Download, “在新标签页打开”, and “在云电脑中打开”. The new-tab action obtains a fresh short-lived task preview ticket so relative assets work in the sandboxed document. The cloud action opens the same file in the tenant's remote browser.
- The first Chrome click run caught a direct-file-link issue: Chrome blocked the relative JavaScript request (`ERR_BLOCKED_BY_ORB`) from the sandboxed full-tab document. Using the signed preview route fixed the loading state; the retest rendered the Chinese game text in the new tab.
- `npm test`: 72/72 passed.
- `npm run test:e2e`: build passed; 38 Chrome UI steps and the cloud-computer browser flow passed against the disposable local app and test adapters. The targeted cloud-computer rerun reported all 13 checks passed, including the new-tab preview and cross-tenant denial. The second-tenant DSH task exceeded the original 20-second E2E wait once; increasing that wait to 30 seconds produced a passing rerun. These checks are not public-site evidence.
- `npm run test:e2e:k3d`: self-contained image build/import and real K3D run passed on `tp1121-sandbox-dev` with image `sha-c87accfc61ca4e473172579b06a2349ea76d06cc`. A temporary Debian 13 desktop and fake Agent adapter exercised worker-token authorization, task-scoped HTML listing/read, chat preview, download, opening the file in remote Chrome, returning control, browser navigation/click/type, and workspace persistence after Pod recreation. This test did not call a paid model. The temporary namespace and PVC were removed.
- `npm run test:e2e:public-demo`: six anonymous Chrome checks passed for public routing, asset prefix, Google OAuth wiring, and existing routes. This does not verify the signed-in feature flow.
- The feature is not deployed. Signed-in public artifact E2E remains pending a release; no public result is inferred from local or K3D success.
