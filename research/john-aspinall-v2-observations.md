# John Aspinall V2 video observations

Source: [I Tried ChatGPT Dots: Setup, Voice Calls & Real Tasks](https://www.youtube.com/watch?v=Q9tF0R8d_Co), John Aspinall. Reviewed on 2026-10-05 in the user's local Chrome session. YouTube displayed a duration of 15:58 and the following chapters:

- 0:00 OpenAI DevDay and ChatGPT dots
- 0:44 Where your dot lives: Codex vs ChatGPT
- 1:25 Creating a dot
- 2:14 Customizing the avatar
- 4:30 Roger's cloud computer
- 5:40 Calling my dot
- 7:12 Renaming it Dolly
- 8:29 The dot guide and limits
- 9:14 Firing off tasks in parallel
- 11:55 Amazon blocks the dot
- 13:09 Second call: what are you working on?
- 13:58 Results and the DevDay infographic
- 14:25 10 automations it suggested
- 15:15 Verdict

## Evidence limits

- This is a third-party hands-on demonstration. It is evidence of the screens and actions shown in this recording, not an authoritative product contract. Spoken statements, chapter titles, and the video description are kept distinct from visible product UI.
- Chrome was navigated to chapter offsets and sampled at 02:14, 04:30, 05:40, 07:12, 08:29, 09:14, 11:55, 12:15, 12:38, 13:09, 13:58, and 14:25. The frames were inspected in the Chrome player but are not persisted as files. The detailed UI view is blurry/compressed and shares the video canvas with a presenter panel and captions.
- Source-video resolution and the product's original viewport, browser scale, and CSS-pixel dimensions are unknown. These player screenshots cannot establish pixel parity or trustworthy component measurements.
- The transcript side panel was not used as evidence. Text reported below was legible in the sampled frame or visibly captioned; uncertain small copy is intentionally not transcribed.

## Time-coded observations

| Time | Visible screen or interaction in Chrome | What it supports | Evidence level and boundary |
| --- | --- | --- | --- |
| 00:44 | Chapter label: “Where your dot lives: Codex vs ChatGPT.” Product surface not sampled at this exact moment. | A comparison is part of the walkthrough. | Chapter label only; no UI conclusion. |
| 01:25 | Chapter label: “Creating a dot.” | Creation is part of the setup walkthrough. | Chapter label only at this timestamp. |
| 02:14 | Conversation/onboarding view with a centered avatar and “Roger” identity. Visible copy introduces the dot, says it can keep things moving between conversations and check in, asks for a name, and includes “Customize your dot.” The presenter discusses animated eyes. | First-run introduction, naming, and a customization entry point are visible. | Frame and on-screen caption. The exact avatar editor controls, values, save action, and persistence are too small/unclear to specify. |
| 04:30 | A separate browser desktop appears inside a colored frame. The browser shows a welcome screen and a countdown; below it, status says “Roger has control” and a green “Take over” button is visible. | The computer has a distinct visual surface, current-control status, and a user takeover affordance. | Frame. This sample does not show clicking Take over or returning control. The “cloud” implementation details are not inferable from this frame. |
| 05:40 | The dot conversation is shown with a call in progress. The side panel identifies Roger and shows Call/Slack controls, “My computers” entries for “Roger's computer — Connected” and “Mac Mini 2024 — This computer,” plus “Recent activity.” Call controls are also visible near the conversation. | The conversation can be paired with computer and recent-activity context; a call is an available interaction. | Frame and captions. The full call lifecycle and exact status transitions are not shown. |
| 07:12 | “Set up Slack” modal overlays the conversation. It says “Your dot in [workspace selector],” asks which workspace to add Roger to Slack, and shows “Select a workspace.” | Slack setup starts with a workspace-selection gate. | Frame. No completed OAuth or successful Slack action is visible. |
| 08:29 | A browser welcome screen reads “Welcome back, Dolly” with a timer; the bottom status indicates the dot has control and “Take over” remains available. Conversation content includes the agent greeting, customization entry, the user's Roger naming message, a later “Dolly it is” message, and a call button. | The changed name is reflected in the computer welcome screen and the existing conversation; takeover remains an explicit choice. | Frame and caption. This sample does not establish rename settings or saved identity behavior after a fresh session. |
| 09:14 | A long conversation response describes areas the dot can help with. The presenter is discussing assigning multiple tasks and says the displayed usage is at 94%. | The demo frames task assignment as a multi-task workflow and shows a long-form assistant response in the conversation. | Frame, caption, and presenter speech. The 94% value is the presenter's report; this frame alone does not prove tasks execute independently or persist after closing the app. |
| 11:55–11:57 | The conversation displays tool/capability sections for email/calendar, connected computer, document/work apps, and research/creation. It says it is working on the DevDay infographic, electricity-history research, and a Times Square restaurant shortlist in parallel. Captions mention Amazon and searching in the dot's browser. | The demo visibly reports parallel work and its current work areas. | Frame and captions. Completion is not established here. The video chapter/description says Amazon blocks the dot, but no Amazon denial/error page is visible in this sampled frame. |
| 12:15–12:38 | The separate browser surface shows “Welcome back, Dolly,” a countdown, app shortcuts, the dot-control status, and a “Take over” button. | The distinct computer view and handoff affordance recur while the presenter discusses accessing the computer. | Frame and caption. The actual Amazon block remains unobserved in the sampled product viewport; retain it as the presenter's reported failure, not an independently verified UI state. |
| 13:09 | Conversation and side panel are visible during a second call. The side panel again includes computer connection and recent-activity context; the presenter asks what the dot is currently working on/connected to. | A follow-up call is used to ask for a status update. | Frame and captions. The video does not reveal whether status was proactively pushed before the call or retrieved in response. |
| 13:58 | A long research/result message appears in conversation. The right panel includes a “Generated image” output entry, the connected computer, and “Recent activity.” The presenter says the results are there and that he can call for a walkthrough. | Results can appear in chat while outputs and activity are also listed in the side panel. | Frame and presenter speech. The screen is compressed; exact artifact contents, file operations, and completion semantics are not measurable. |
| 14:00 (within the preceding chapter) | Captions show the presenter saying an output was already there but he did not get a notification. | Notification delivery is discussed as a gap in this run. | Presenter speech/caption only; no notification UI or delivery trace is shown. |
| 14:25 | A numbered list titled by the chapter “10 automations it suggested” fills the conversation, with time ranges and suggested activities. | The assistant has proposed a set of recurring/proactive ideas in response to this test. | Frame and chapter label. The presenter says he did not ask for the suggestions. No item is shown being activated, scheduled, or executed, so these are proposals rather than proven automations. |

## Replication implications

1. Preserve the separation between the dot conversation, its details/activity side panel, and the distinct computer viewport. In observed computer states, status text identifies who currently controls the computer and a “Take over” action is visible.
2. First-run and ongoing identity states should be researched separately: onboarding shows a customization affordance, while the later browser welcome screen reflects the renamed dot. The editor and persistence workflow still need a sharper source recording.
3. Represent task proposals, reported in-progress work, completed outputs, and user-visible notifications as different states. This video shows all four concepts being discussed or displayed, but it also includes a reported missed notification and does not independently establish a schedule run.
4. Keep Slack workspace selection as a distinct integration setup step. The sampled modal does not justify assuming authorization success or a connected Slack state.
5. Treat the Amazon failure as a required negative test lead because the chapter and presenter description call it out. Revisit the source footage frame-by-frame before implementing a specific error screen; that failure UI was not visible in the samples saved from this review.
6. Full Take over → user action → Return control, scheduled task creation/editing, notification delivery, and task resume after app restart remain open replay scenarios. Do not mark them evidenced by this video review.
7. Pixel-level comparison remains pending. Obtain a clean, stable source frame and known viewport before measuring or claiming visual parity.

## Direct Chrome re-check — 2026-10-05

- At 09:14, the Chrome video player showed the Dots conversation beside the presenter. The Dot had invited the user to share tasks; the user began requesting a polished infographic. This is a conversation-level request, not a demonstrated task-tree or delegation control.
- At 11:55, the player showed the conversation's “deep-work overview” answer. It reported three current work items: the DevDay infographic, electricity-history research, and a Times Square restaurant shortlist. The same answer said sending, sharing, purchasing, and sensitive-setting changes follow the user's permissions. This is direct evidence of a reported three-item parallel workload and stated action boundaries; it does not expose the scheduler, task records, or exact concurrency limit.
- The Chrome screenshot showed the dark conversation on the left, a presenter pane on the right, and captions across the lower video area. Those are video-composite bounds, not a clean Dots application viewport. No pixel measurements were taken. The screenshots were inspected live in Chrome but were not saved as source image files.
- Replication decision: Coke Dots now permits three active tasks per workspace, while retaining a four-task local-process cap. Treat that number as a tested implementation capacity chosen to cover the three-item workload shown in the video, not as a claim about OpenAI's hidden scheduler limit. The new Chrome E2E keeps all three test model calls pending simultaneously, verifies all three Activity cards show Working, then releases and verifies each result.
