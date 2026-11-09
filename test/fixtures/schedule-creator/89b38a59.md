---
name: create-switchboard-schedule
description: Create a new Switchboard scheduled task for this project
---

You are helping the user create a scheduled task in Switchboard. This task will run automatically on a cron schedule using Claude Code CLI in headless mode (-p flag).

## Instructions for the user

Welcome! I'll help you set up a scheduled task for this project. Tell me:
- **What** the task should do
- **When** it should run (e.g. "every weekday at 9am", "hourly", "every Sunday night")

I'll generate the schedule file and save it. You can always edit it later from the brain tab.

## How to create the task

Ask the user what the task should do and when it should run. Keep it conversational — one or two questions at a time, not all at once.

Once you have enough information, generate a cron expression from their description and confirm it in plain english (e.g. "That's every weekday at 9:00 AM").

## File format

Save to `<project-root>/.claude/commands/schedule-<slug>.md`:

```markdown
---
name: <Human readable name>
cron: <5-field cron expression>
enabled: true
slug: <short-kebab-case-id>
cli:
  permission-mode: acceptEdits
  allowed-tools: <select based on task needs>
  # only include these if the user specified them:
  # model: <model>
  # max-budget-usd: <number>
  # append-system-prompt: <extra context>
  # add-dirs: <comma-separated paths>
---

<The full prompt that will be sent to Claude when this task runs>
```

## Selecting permissions

Scheduled tasks run headless, so choose the minimum tools needed for the task. Available tools:

| Tool | Use when the task needs to... |
|------|-------------------------------|
| Bash | Run shell commands, scripts, tests, git operations |
| Read | Read files from the project |
| Write | Create new files |
| Edit | Modify existing files |
| Glob | Find files by name pattern |
| Grep | Search file contents |
| WebFetch | Fetch URLs, APIs, web pages |
| WebSearch | Search the web |

Examples:
- **Web scraping task** → `Bash,Read,Write,Glob,WebFetch`
- **Test runner** → `Bash,Read,Glob,Grep`
- **Code refactor** → `Bash,Read,Write,Edit,Glob,Grep`
- **Report generator** → `Bash,Read,Write,Glob,Grep,WebFetch`

Default permission-mode is `acceptEdits`. Always include at least `Read` and `Glob`.

## Rules

- The slug must be kebab-case, short, and descriptive
- The prompt in the body must be fully self-contained — it runs without any conversation history
- If the `.claude/commands/` directory doesn't exist, create it
- After saving, tell the user: "Your scheduled task is saved! It will appear in Switchboard's brain tab with a schedule icon. You can enable/disable it or edit the schedule from there."
- If the user wants to see existing schedules, list any `schedule-*.md` files in `.claude/commands/`
