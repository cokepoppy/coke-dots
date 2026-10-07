# Agent computer research: evidence and limits

## Product evidence

- OpenAI's [computer and apps guide](https://learn.chatgpt.com/docs/dots/computers-and-apps) says a Dot has its own cloud computer and browser, and that the computer is used for research and other work. The computer remains separate from a user's personal browser. Opening the computer is read-only observation; Take over and Return control explicitly transfer mouse and keyboard control.
- OpenAI's [tasks and memory guide](https://learn.chatgpt.com/docs/dots/tasks-and-memory) says assigned work can continue between conversations and use its original computer or cloud environment. It also distinguishes read-only proactive research from browser/computer control.
- V2 at 11:55–11:57 shows the Dot reporting parallel work on an infographic and web research; captions mention looking in the Dot's browser. This is evidence that research is part of the demonstrated work, but does not show each browser action or establish a login workflow. V2 at 12:50–12:55 shows a Chromium-native page block inside the computer frame, so browser failures must remain visible in the computer rather than turn into fabricated research results.

## Existing gap

Coke Dots already has an isolated tenant browser, a separate cloud desktop, user Take over/Return control, and an Agent runtime endpoint. Before this feature, the `model` adapter had no browser tool calls, and the Chrome click-through only exercised browser control initiated by a user. A model task could not open a public page in the Dot's browser and return its visible text.

## Feature boundary

- The OpenAI-compatible Model API and Pi adapters can call `open_public_page` and receive the page title, current URL, and bounded visible text from the active tenant's Dot computer. Both use the same worker permission checks and tenant computer; Pi registers the capability through its native custom-tools API.
- Pi's [SDK guide](https://pi.dev/docs/latest/sdk) documents custom tool registration on an agent session, and its [extension guide](https://pi.dev/docs/latest/extensions) documents the tool schema and execution contract. This is an adapter implementation choice that gives Pi the same constrained browser capability; the Dots videos do not establish which internal model kernel provides its research.
- DeepSeek Harness is still pending. Its Coke Dots adapter launches a configured Harness profile and does not yet expose a verified plugin patch path for this browser tool; do not infer that Pi support implies DSH support.
- Navigation uses credential-free public HTTPS GETs. Private, loopback, link-local, reserved, non-HTTPS, and non-default-port targets are rejected. Requests that would use an existing website session are rejected; this first slice does not implement website sign-in, saved passwords, form entry, clicks, downloads, or external writes.
- The control plane resolves and screens every address, pins the HTTPS connection to the screened IP, and manually follows only redirects that pass the same checks. The fetched document is capped at 3 MB and reduced to a static HTML snapshot with scripts, frames, styles, links, and network-capable attributes removed before it appears in the browser.
- User takeover remains authoritative. Agent page reads and navigation stop while the user owns the computer. The user can inspect the browser and return control before the task continues.
- Page text is untrusted source data. It cannot override task instructions, trigger page writes, or authorize messages or account actions.

## Verification target

Chrome E2E submits Model API and Pi tasks through the visible composer, observes each kernel request a browser page, verifies that the tenant computer displays the page, checks that the returned text reaches the follow-up model turn, and checks the completed result in Activity. Unit checks cover HTTPS-only URL validation, private address rejection, DNS-pinned requests, redirect revalidation, content-type and response-size limits, takeover rejection, and removal of active/untrusted page content. The automated flow uses a test-only intercepted fixture and requires no real public website or account session.
