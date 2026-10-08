# Scheduled task editing and controls

## Evidence

- The [official Dots getting-started help](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) says a user can open a scheduled task to change its repeat schedule, time, or completion notifications.
- The [official Scheduled tasks help](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) says Scheduled can review, edit, pause, resume, or delete tasks. Its task panel describes repeat controls, an end condition, a menu, and pause controls.
- The reviewed Futurepedia and John Aspinall videos show Scheduled list/detail states but do not demonstrate schedule editing, pause/resume, or the editor fields. The exact Coke Dots control placement, copy, and styling remain unverified against video.

## Coke Dots behavior

- A tenant can edit a recurring task's interval, daily time and time zone, or weekly days/time/time zone, with the existing optional end date.
- Saving an active or failed recurring task recalculates its next run from the edited schedule. Saving a paused task changes its schedule but keeps it paused with no next run.
- Pause is available only after the task has returned to its scheduled state. Resume computes the next occurrence from the retained schedule. A past end date prevents resume until the schedule is edited.
- A tenant can edit, pause, resume, or cancel only its own task. Cross-tenant API requests return 404.
- Running tasks and one-off follow-ups cannot use the recurring schedule editor.

## Verification

- Store tests reopen SQLite after replacing an interval schedule with a weekly schedule while paused.
- Chrome E2E edits a failed recurring task, checks its new interval and next run, verifies a second tenant receives 404, pauses it, edits it while paused without scheduling work, resumes it, and then removes the schedule.
- These workflow tests verify Coke Dots behavior; they do not prove exact Dots pixels or behavior not described by official documentation.
