# Website sign-in request and computer handoff

## Reference evidence

- The [official Computers and apps guide](https://learn.chatgpt.com/docs/dots/computers-and-apps) says a Dot can request sign-in through a private form that sends credentials to its remote browser outside the conversation. The user can instead take over the computer and sign in there. The Dot's computer session is separate from the user's personal browser. The guide describes saved credentials as optional and says their reuse requires confirmation.
- V2 around 04:50 shows the user taking over the Dot computer. Around 04:53–05:14, the video shows a Google verification and search activity in that browser. The reviewed video does **not** show the private sign-in form itself, so Coke Dots does not claim pixel parity for that form.
- This feature is separate from the Amazon browser error reference at V2 12:50–12:55. That reference is only a Chromium `ERR_BLOCKED_BY_CLIENT` state in a test fixture, not an Amazon integration.

## Coke Dots behavior

1. An Agent may request website authentication only with a structured `waiting` decision and a standard public HTTPS sign-in URL. Query strings, URL credentials, fragments, and non-default ports are rejected so the stored address cannot carry common one-time authentication values.
2. A tenant-and-task-scoped record stores only the URL, hostname, reason, status, and timestamps. The private form submits its username and password to the authenticated Coke Dots API, which forwards them to that tenant's computer runtime in memory. The credentials are not included in Agent prompts, task entries, Activity, SQLite, or the API response.
3. The computer fills one recognizable visible username field and one visible password field; it does not submit the form. The user checks the target page, submits it, and handles MFA or verification while holding computer control. If the page has an unsupported form or redirects to another host, the UI offers manual takeover.
4. Returning control clears the tracked input fields when the page is still at the same URL. A separate explicit user action queues the task again with a credential-free confirmation. Cancelling or stopping the task closes the pending request.
5. Password saving is not implemented. This preserves the official separation between private login and Agent conversation without introducing an unreviewed password manager.

The form layout and English/Chinese copy are Coke Dots implementation choices. A captured high-resolution Dots private-form frame and an observed submit/MFA handoff are still needed before describing those details as a visual or interaction match.

## Verification

- Adapter and Store tests validate the waiting-only contract, HTTPS address restrictions, tenant isolation, cancellation, continuation, and the metadata-only schema.
- Chrome UI E2E uses a test-only local sign-in page. It submits fake credentials, visibly confirms the password is masked, clicks the page's sign-in button in the computer screenshot, returns control, resumes the task, and checks that neither fake value appears in prompts, task state, Activity, or SQLite.
- The Linux desktop client has a protocol test for the authenticated private sign-in request. The end-to-end Chrome sign-in flow currently exercises the local computer runtime; the browser form itself has not been exercised inside a live K3D Debian desktop.
