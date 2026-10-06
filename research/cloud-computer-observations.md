# Dots cloud computer video observations

Source: [John Aspinall, “I Tried ChatGPT Dots: Setup, Voice Calls & Real Tasks”](https://www.youtube.com/watch?v=Q9tF0R8d_Co). I rechecked the recording in the user's Chrome on 2026-10-07. The source is a compressed video composite with the product, presenter, and YouTube controls; it is useful for visible states and relative layout, but it does not reveal the original viewport or CSS pixel dimensions.

## Frames and visible states

| Time | Visible cloud-computer UI | What the frame confirms | Evidence boundary |
| --- | --- | --- | --- |
| 04:44 | A warm coral/orange desktop surface holds a white browser window. The page says “This is my computer. Watch me work, or take control when you need to,” shows an orange avatar wearing glasses and a crown, a clock, “Welcome back, Roger,” a grid of app shortcuts (3D Slicer, Blender, Draw, FreeCAD, GIMP, Go, Godot, Inkscape, Kdenlive, KiCad), and a centered three-icon dock. Below the desktop, the green control strip reads “Roger has control” and “Take over.” | The cloud computer is shown as a persistent desktop/browser surface with a clear agent-owner state and explicit takeover affordance. | Direct Chrome frame at 04:44, retained as `research/frames/john-aspinall-v2-0444-dot-control-replay.png` (local ignored evidence). The welcome clock is only a sampled display; its ticking behavior is not established. |
| About 04:50 | The same desktop and browser page remain visible. The control strip is orange and reads “You have control” and “Return control.” | Control ownership changes while the current page remains open; takeover does not replace the desktop with a setup page. | Direct Chrome sample at 04:50, retained as `research/frames/john-aspinall-v2-0450-user-control-replay.png`. Transition time is bounded between this frame and 04:44. |
| 04:53–05:14 | The browser page changes through Google verification/search, a “speed test” search, the Internet speed test panel, and a Google consent screen. The orange user-control strip remains. | User input controls the same remote browser after takeover. | Sequential direct Chrome samples; retained files are listed in `john-aspinall-v2-observations.md`. They do not prove the speed-test result is accurate or reveal the browser's hidden permission model. |
| 05:40 | The conversation and a details panel are visible. The panel shows connected-computer entries (“Roger's computer” and “Mac Mini 2024”), “Recent activity,” and “Outputs.” | Computer context is available beside the conversation. | Direct Chrome frame; this is the conversation/details view, not the remote desktop canvas. |

The 04:44 remote desktop itself is approximately 4:3. Within that remote desktop, the coral wallpaper frames a centered browser window: its left and top insets are each about 7–9% of the desktop, and it occupies about 87% of the width and 82% of the height. A translucent three-icon dock sits at the bottom center. The owner status and takeover action share the viewer centerline. These are ratios measured from a compressed player frame, not source CSS measurements. The Debian replica now uses a 1440×1080 4:3 screen, coral root wallpaper, a browser window at those relative bounds, and a three-launcher dock; the actual K3D screenshot is checked for the coral margin, measured screen ratio, and centered control state.

The recording also contains a wider black surround with a neon outline and a presenter panel. Those elements could be part of the creator's recording layout, so they are recorded as uncertain and are not copied into the product surface without another clean product frame.

## Replica changes driven by these frames

- The Linux desktop had been starting at `example.com`, unlike the directly observed welcome screen. It now starts at `about:blank`; the restricted desktop Worker supplies the shared welcome page before the first screenshot and applies the tenant's Dot name when Coke Dots opens that computer.
- The shared page keeps the observed copy, light patterned wallpaper, avatar, clock, shortcut grid, and fixed arrangement across local Chrome and Debian Chromium. This is a reference-backed first screen, not evidence about Dots' underlying operating-system image.
- The Coke Dots computer view keeps the agent/user owner status and hand-back action visible below the remote desktop, centered as in the frame. Chrome E2E covers takeover, navigation, clicking, typing, and return. The K3D E2E checks the actual Debian screenshot, the 4:3 screen shape, and centered controls in both owner states.

## Remaining visual limits

The video does not provide a clean desktop-only source frame, native screen resolution, exact browser zoom, or original UI assets. Small labels and icon artwork are blurred by the video scale. We can compare relative arrangement and visible state, but we cannot honestly claim pixel parity from this footage alone. Preserve each measured frame, fixed viewport, and comparison output as the target is tuned; keep unshown transitions marked unverified.
