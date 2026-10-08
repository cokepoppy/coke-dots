# Proactive Slack monitoring evidence

## Product behavior supported by evidence

- The official Dots introduction says proactive research may inspect connected information using read-only tools and return findings to the Dot; it does not send messages or change connected data on the Dot's behalf. [Introducing dots](https://openai.com/index/introducing-dots/)
- The official tasks and memory guide distinguishes a user-configured event monitor from merely connecting an app. Scheduled work and event monitoring are separate triggers, and users can inspect or redirect work in Activity. [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- The controls guide describes reviewing and controlling assigned work. [Control your dot](https://learn.chatgpt.com/docs/dots/controls)
- Slack's public-channel `message.channels` event is a `message` event with `channel_type: "channel"` and needs `channels:history`. Channel discovery uses `conversations.list` and `channels:read`. [message.channels](https://docs.slack.dev/reference/events/message.channels/), [conversations.list](https://docs.slack.dev/reference/methods/conversations.list/)
- The V2 hands-on video sampled in Chrome at 04:07 shows a proactive welcome suggestion in the opening conversation. It does not show an event monitor, Slack channel picker, or a channel event being handled. That frame supports the broader proactive-agent concept only; it is not evidence for this feature's UI. See [time-coded V2 observations](john-aspinall-v2-observations.md).

## Coke Dots implementation

1. An owner/admin connects Slack and grants `channels:read` plus `channels:history`; existing installations need OAuth reauthorization to add them.
2. The Slack setup modal lists public channels for that tenant's connected Slack workspace. A monitor stores one channel and a user-written condition. The tenant/channel pair is unique, so one event creates at most one review in each tenant.
3. The Slack Events API must subscribe to `message.channels`, and the app must be a member of the monitored channel. Requests are verified against the raw body and the configured Slack signing secret.
4. A matching new public-channel event creates a durable task in that tenant with `execution_mode=read-only`. The event text and channel metadata are isolated in task context. The system entry records that no Slack reply will be sent.
5. Slack retry events are deduplicated by `event_id` within each tenant. Events for channels without active monitors are ignored. Pausing a monitor prevents later events from dispatching tasks. Proactive reviews never enter the DM reply-delivery queue.
6. The task result and event are visible in Activity. The review may identify a relevant report or say no follow-up is needed; subsequent external actions still require an explicitly supported tool and its authorization checks.

The monitor list, field labels, modal dimensions, colors, and control placement are implementation choices. The reviewed Dots videos do not show these states, so they are functional and visual extensions rather than pixel-verified copies. Do not fill this evidence gap with invented screenshots or claim exact visual parity.

## Verification

- `tests/slack.test.ts` verifies missing scopes, tenant-scoped monitor visibility, same-channel independence between tenants, read-only task mode, untrusted message context, event deduplication, opt-in filtering, pause behavior, and absence from Slack reply delivery.
- `tests/e2e/ui.e2e.ts` uses Chrome clicks to open the real modal, list mock public channels, exclude a private-channel fixture, enter a monitor condition, send Slack-signed events, wait for the task worker's model result, inspect the Activity card, replay a duplicate, submit an unmonitored-channel event, pause the monitor, and ensure no Slack post is emitted.
- The E2E uses local mock Slack and model servers. It does not validate a live Slack installation or Slack's hosted Events API delivery. Those require separately configured Slack OAuth credentials, a public request URL, `SLACK_SIGNING_SECRET`, and the `message.channels` subscription.
