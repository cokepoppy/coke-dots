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
| [John Aspinall hands-on](https://www.youtube.com/watch?v=Q9tF0R8d_Co), 04:42–04:50 | The video switches to the Dot's own browser desktop. “Roger has control” and “Take over” change to “You have control” and “Return control” while that desktop remains visible. | Computer inspection and control are shown on a dedicated computer surface. The live desktop is not shown as a persistent chat-side mini-panel in this sequence. |
| [John Aspinall hands-on](https://www.youtube.com/watch?v=Q9tF0R8d_Co), 05:40 | The main pane is the Dot conversation. The right context pane shows Dot identity, Call/Slack, Computers, Recent activity, and Outputs. No live desktop image is visible in that right pane. | Supports a right-side Dot context panel, not a right-side live desktop preview. The recording is compressed and cannot provide reliable CSS-pixel measurements. |
| [Futurepedia hands-on](https://www.youtube.com/watch?v=V_1Vn2WfpEY), 09:28 | Generated thumbnail outputs appear in the conversation, and the user requests a visual revision; a revised thumbnail then appears in the conversation. | Supports returning reviewable artifacts directly in the conversation and iterating there. The video does not show an HTML game or prove a specific file-opening interaction. |
| [Futurepedia hands-on](https://www.youtube.com/watch?v=V_1Vn2WfpEY), 05:07 | A Scratchpad page is shown in a split view with conversation, page navigation, and document content. | This is a document/Pages view. It is not evidence that the cloud computer is permanently docked beside every conversation. |

These are direct observations from the retained Chrome-visible samples documented in `john-aspinall-v2-observations.md` and `futurepedia-v1-observations.md`. Video composites are evidence of structure and interaction only; source viewport and CSS dimensions are unknown, so no pixel-parity claim is made from them.

## Decision

Keep the conversation in the center and the Dot details panel on the right. The right panel continues to show the connected computer entry, activity, and outputs. Keep the full cloud-computer view behind the Computers entry; use Take over and Return control to communicate ownership explicitly. The references do not support keeping a live computer image docked to the chat at all times.

Put task files next to the completed task in the conversation. For the first previewable HTML file, open a sandboxed interactive preview automatically when the completed task is selected. List all outputs with their names and sizes, and retain explicit Preview/Collapse, Download, and “在云电脑中打开” actions. The cloud action opens the same tenant-scoped file in that tenant's remote browser; it does not claim the file exists in the user's local Chrome or publish a permanent URL.

For an HTML game such as Tetris, the shortest path is: select the completed task (or open it from Recent/Outputs) → see and play the inline preview → optionally open the same file in the cloud computer to inspect the browser or take over. The user's previous file-manager path search and manual drag into Chrome should not be necessary.

## Verification contract

The Chrome click-through must create an HTML file with a relative JavaScript asset, select its completed task, and verify the game text appears without clicking Preview. It then checks collapse/reopen, Download availability, one-click open in the tenant's cloud browser, return-control behavior, and 404 isolation for another tenant's list/content/preview/open requests. This proves Coke Dots behavior in the local browser suite; public signed-in Chrome must be reported separately and must identify the bundle/revision it actually served.

## Public baseline check

On 2026-10-14, signed-in Chrome at `https://codex.cokeagent.com/dots-demo/` showed the completed Tetris response and a filesystem path, but no generated-file card or inline preview. A read-only request to `/dots-demo/api/tasks/{taskId}/artifacts` returned `{"error":"Not found"}`, so the artifact API from this feature branch is not present in the public runtime. The public root `/api/health` identifies `coke-openrouter`; Dots API requests must stay under `/dots-demo/api`.

The installed demo source does not match this feature branch and does not contain `src/web/TaskArtifacts.tsx`. A whole-app sync from this branch would replace later live functionality. The branch now builds with the `/dots-demo/` asset base and routes browser API calls and preview URLs through that prefix, but public feature E2E remains pending integration into the live runtime baseline and deployment of the matching cloud-worker artifact endpoints.
