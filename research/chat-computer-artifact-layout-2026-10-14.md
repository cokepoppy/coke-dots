# Chat, cloud-computer, and generated-file layout decision

Reviewed: 2026-10-14. This note records the evidence and UX decision implemented on `feature/chat-artifact-live-runtime`.

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
| [John Aspinall hands-on](https://www.youtube.com/watch?v=Q9tF0R8d_Co), 04:42–04:50 | Chrome recheck at 04:42 shows a separate browser desktop with “Roger has control” and a “Take over” control. By about 04:50, the desktop remains visible and ownership reads “You have control” with “Return control.” | Computer inspection and control are shown on a dedicated computer surface. The live desktop is not shown as a persistent chat-side panel in this sequence. |
| [John Aspinall hands-on](https://www.youtube.com/watch?v=Q9tF0R8d_Co), 05:40 | The main pane is the Dot conversation. The right context pane shows Dot identity, Call/Slack, Computers, Recent activity, and Outputs. No live desktop image is visible in that right pane. | Supports a right-side Dot context panel, not a right-side live desktop preview. The recording is compressed and cannot provide reliable CSS-pixel measurements. |
| [Futurepedia hands-on](https://www.youtube.com/watch?v=V_1Vn2WfpEY), 05:07 | A Scratchpad page is shown in a split view with conversation, page navigation, and document content. | This is a document/Pages view. It is not evidence that the cloud computer is permanently docked beside every conversation. |
| [Futurepedia hands-on](https://www.youtube.com/watch?v=V_1Vn2WfpEY), 09:28 | A generated visual output appears in the conversation; the user asks for a revision and a revised output follows. | Supports making outputs reviewable from the conversation. It does not show an HTML game or the exact cloud-file open action. |

These are direct observations from the retained Chrome-visible samples documented in `john-aspinall-v2-observations.md` and `futurepedia-v1-observations.md`. Video composites are evidence of structure and interaction only; source viewport and CSS dimensions are unknown, so no pixel-parity claim is made from them.

## Decision

Keep the conversation in the center and the Dot details panel on the right. The right panel continues to show the connected computer entry, activity, and outputs. Keep the full cloud-computer view behind the Computers entry; use Take over and Return control to communicate ownership explicitly. The references do not support keeping a live computer image docked to the chat at all times.

Put task files next to the completed task in the conversation. For the first previewable HTML file, open a sandboxed interactive preview automatically when the completed task is selected. List all outputs with their names and sizes, and retain explicit Preview/Collapse, Download, and “在云电脑中打开” actions. The cloud action opens the same tenant-scoped file in that tenant's remote browser; it does not claim the file exists in the user's local Chrome or publish a permanent URL.

For an HTML game such as Tetris, the shortest path is: select the completed task (or open it from Recent/Outputs) → see and play the inline preview → optionally open the same file in the cloud computer to inspect the browser or take over. The user's previous file-manager path search and manual drag into Chrome should not be necessary.

## Verification contract

The Chrome click-through must create an HTML file with a relative JavaScript asset, select its completed task, and verify the game text appears without clicking Preview. It then checks collapse/reopen, Download availability, one-click open in the tenant's cloud browser, return-control behavior, and 404 isolation for another tenant's list/content/preview/open requests. This proves Coke Dots behavior in the local browser suite; public signed-in Chrome must be reported separately and must identify the bundle/revision it actually served.

## Public baseline check

On 2026-10-14, signed-in Chrome at `https://codex.cokeagent.com/dots-demo/` showed the completed Tetris response and a filesystem path, but no generated-file card or inline preview. A read-only request to `/dots-demo/api/tasks/{taskId}/artifacts` returned `{"error":"Not found"}`. The public page served `/dots-demo/assets/index-C10z0l4c.js` (SHA-256 `462693bd5b4967cc3b4df77bd5142fac59db8619a955e2f099a4b4d3f8b52cc8`), matching the installed demo runtime's `app/dist`; neither includes this feature. The public root `/api/health` identifies `coke-openrouter`; Dots API requests must stay under `/dots-demo/api`.

The feature branch was rebased onto the source baseline matching the installed runtime (including the later Gmail and Teams functionality). Its build uses `/dots-demo/` for static assets, API calls, and preview URLs. The public feature remains unreleased, so the signed-in public flow is not yet verified with this branch.

## Implementation and verification

- The selected completed task now lists its tenant-scoped files inline. Selecting an HTML output opens a sandboxed preview automatically; users can collapse/reopen it, download the file, or open that exact file in the tenant's cloud computer.
- `npm test`: 117/117 passed.
- `npm run test:e2e`: 54 Chrome UI steps passed against a disposable local app and mock computer service. This is local evidence, not public-site evidence.
- `npm run test:e2e:demo-path`: passed for the `/dots-demo/` browser route.
- `npm run test:e2e:k3d`: passed against a real local K3D Debian desktop using a fake Agent adapter (no paid model call). It checked artifact endpoint authorization, HTML listing/content and preview headers, browser open/navigation/control flow, and workspace persistence after desktop Pod recreation. Test namespace was removed afterward. The image revision label matched commit `668d746b5b36b212f706d89c913eb7cd811a5e4c`.
- Public deployment was not changed. The signed-in public artifact flow remains to be run after release; no claim of pixel-perfect parity is based on compressed YouTube footage.
