# Scheduled completion notifications

## Evidence

The [official getting-started help for a Dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) documents changing a scheduled task's completion notification preference. The reviewed Futurepedia video shows Scheduled rows marked “Monitoring” at 09:53 and 10:02, but it does not show this preference control. The toggle's exact placement, copy, and styling in Coke Dots are therefore implementation choices, not pixel-verified details.

## Coke Dots behavior

- New and migrated scheduled tasks default to completion notifications enabled.
- The preference is stored per task and tenant. Only a task that belongs to the signed-in tenant can be changed.
- Turning it off suppresses a successful scheduled-run completion notice. A request for the user's reply and a task failure remain visible.
- The Scheduled detail explains this distinction next to the checkbox.

## Verification

- Unit tests cover the enabled default, SQLite persistence across reopen, task isolation, old-schema migration, and worker notification behavior.
- Chrome E2E turns the preference off, confirms that a second tenant receives HTTP 404 when attempting to change the task, waits for the next recurring execution, and verifies the preference remains off in reopened Scheduled details.
- Full E2E run on 2026-10-08: 52 UI steps and 8 cloud-computer checks passed. Evidence is under `artifacts/e2e/2026-10-08T15-55-00-921Z` and `artifacts/e2e/linux-cloud-computer-2026-10-08T15-57-17-558Z`.
