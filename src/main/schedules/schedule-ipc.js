// schedule-ipc.js — IPC handlers and helpers for scheduled task creation
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { renameWithRetry } = require('../shared/atomic-write');
const { encodeProjectPath } = require('../../../encode-project-path');
const { classifyRunExit } = require('./schedule-run-results');
const { resolveRunNowTarget } = require('./run-schedule-now-target');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SCHEDULE_COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');

const SCHEDULE_CREATOR_TEMPLATE = `---
name: create-switchboard-schedule
description: Create a new Switchboard scheduled task for this project
---

You are helping the user create a scheduled task in Switchboard. This task will run automatically on a cron schedule using Claude Code CLI in headless mode (-p flag).

## Instructions for the user

Welcome! I'll help you set up a scheduled task for this project. Tell me:
- **What** the task should do
- **When** it should run (e.g. "every weekday at 9am", "hourly", "every Sunday night")

I'll generate the schedule file and save it. You can always edit it later from the Schedules tab (Global Settings → Schedules tab).

## How to create the task

Ask the user what the task should do and when it should run. Keep it conversational — one or two questions at a time, not all at once.

Once you have enough information, generate a cron expression from their description and confirm it in plain english (e.g. "That's every weekday at 9:00 AM").

## File format

Save to \`<project-root>/.claude/commands/schedule-<slug>.md\`:

\`\`\`markdown
---
name: <Human readable name>
cron: <5-field cron expression>
enabled: true
slug: <short-kebab-case-id>
cli:
  permission-mode: auto
  allowed-tools: <select based on task needs>
  # only include these if the user specified them:
  # model: <model>
  # max-budget-usd: <number>
  # append-system-prompt: <extra context>
  # add-dirs: <comma-separated paths>
---

<The full prompt that will be sent to Claude when this task runs>
\`\`\`

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
- **Web scraping task** → \`Bash,Read,Write,Glob,WebFetch\`
- **Test runner** → \`Bash,Read,Glob,Grep\`
- **Code refactor** → \`Bash,Read,Write,Edit,Glob,Grep\`
- **Report generator** → \`Bash,Read,Write,Glob,Grep,WebFetch\`

Default permission-mode is \`auto\` (Claude classifies each action, allowing routine work and stopping for risky ones). Always include at least \`Read\` and \`Glob\`.

## Rules

- The slug must be kebab-case, short, and descriptive
- The prompt in the body must be fully self-contained — it runs without any conversation history
- If the \`.claude/commands/\` directory doesn't exist, create it
- Add \`catch-up: true\` only if the user wants a run that fell due while Switchboard was closed or the machine asleep to happen once, late, when it is back; leave it out for a task that is useless late (a reminder)
- After saving, tell the user: "Your scheduled task is saved! It will appear in Switchboard's Schedules tab (Global Settings → Schedules tab). You can enable/disable it or edit the schedule from there."
- If the user wants to see existing schedules, list any \`schedule-*.md\` files in \`.claude/commands/\`
`;

const SCHEDULE_WELCOME_MESSAGE = `## Switchboard Scheduled Task Creator

Welcome! This session will help you create a **scheduled task** that runs automatically on a cron schedule using Claude Code.

### How it works
- Describe **what** you want the task to do and **when** it should run
- I'll generate a schedule file with the right cron expression and prompt
- The schedule file gets saved to this project's \`.claude/commands/\` directory as a command — so it can also be run manually from any Claude session using \`/schedule-<name>\`
- Once saved, it appears in the Schedules tab (Global Settings → Schedules tab) where you can edit it directly
- To edit, you can also ask use this schedule claude session to ask to edit existing commands.
- Switchboard runs matching schedules automatically in the background — each run creates a session grouped under the task's slug

### What you can configure
- **The prompt** — what Claude should do each time the task runs
- **The schedule** — any cron pattern (e.g. "every weekday at 9am", "hourly", "first Monday of the month")
- **CLI settings** — model, permission mode, budget cap, allowed tools, additional directories

### To get started
Just describe the task you have in mind, or try one of these:
- **"What are my existing schedules?"** — list just the scheduled tasks
- **"Edit schedule-hn-digest to run every 5 minutes instead of hourly"** — modify an existing schedule
- **"Create a task that runs the test suite every morning at 8am"** — create a new one
- **"Disable schedule-repo-health"** — toggle a schedule off`;

const SHIPPED_CREATOR_TEMPLATE_SHA256 = [
  '4432f59e494f84aa61d2023af7a3455e1e476eb913869c8ec51e2fefbebf75e7',
  'fa7685454d5e4dc3fdac9c90908eae8ae0cbcb3344bec39573850a5788db1221',
  'd2395a41213ee87e034310cb1d3c5cd28d476e98f1057d85b34aee2ebbac3eff',
  'c7050c07b3ca19b7306c9d67ab44de00d013547077a32a906cf7809a9d20a8da',
];

function ensureScheduleCreatorCommand() {
  let tmp;
  try {
    const commandPath = path.join(SCHEDULE_COMMANDS_DIR, 'create-switchboard-schedule.md');
    const stat = fs.lstatSync(commandPath, { throwIfNoEntry: false });
    if (!stat) {
      fs.mkdirSync(SCHEDULE_COMMANDS_DIR, { recursive: true });
      fs.writeFileSync(commandPath, SCHEDULE_CREATOR_TEMPLATE, { flag: 'wx' });
      return;
    }
    if (!stat.isFile()) return;
    const bytes = fs.readFileSync(commandPath);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash === crypto.createHash('sha256').update(SCHEDULE_CREATOR_TEMPLATE).digest('hex')) return;
    if (!SHIPPED_CREATOR_TEMPLATE_SHA256.includes(hash)) {
      console.info('[schedule] Keeping customized schedule creator command');
      return;
    }
    tmp = path.join(SCHEDULE_COMMANDS_DIR, `.create-switchboard-schedule-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, SCHEDULE_CREATOR_TEMPLATE, { flag: 'wx' });
    renameWithRetry(tmp, commandPath);
    console.info('[schedule] Updated shipped schedule creator command');
  } catch (err) {
    console.info('[schedule] Schedule creator command left unchanged:', err.message);
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

function init(log, runCommand, isPathAllowed, isProjectArchived = () => false) {
  const { parseFrontmatter, createScheduleSession, buildScheduleCommand } = require('./schedule-runner');

  ipcMain.handle('get-schedule-creator-command', () => {
    try {
      const commandPath = path.join(SCHEDULE_COMMANDS_DIR, 'create-switchboard-schedule.md');
      ensureScheduleCreatorCommand();
      return fs.readFileSync(commandPath, 'utf8');
    } catch (err) {
      log.error('[schedule] Failed to read schedule command:', err);
      return null;
    }
  });

  ipcMain.handle('create-schedule-session', (_event, projectPath) => {
    try {
      ensureScheduleCreatorCommand();
      const commandPath = path.join(SCHEDULE_COMMANDS_DIR, 'create-switchboard-schedule.md');
      const systemPrompt = fs.readFileSync(commandPath, 'utf8');

      const sessionId = crypto.randomUUID();
      const msgId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const folder = encodeProjectPath(projectPath);
      const claudeProjectDir = path.join(PROJECTS_DIR, folder);

      fs.mkdirSync(claudeProjectDir, { recursive: true });
      const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);

      const snapshot = JSON.stringify({
        type: 'file-history-snapshot',
        messageId: msgId,
        snapshot: { messageId: msgId, trackedFileBackups: {}, timestamp },
        isSnapshotUpdate: false,
      });

      const assistantMsg = JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd: projectPath,
        sessionId,
        version: '1.0.0',
        gitBranch: 'main',
        slug: 'create-schedule',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: SCHEDULE_WELCOME_MESSAGE }] },
        uuid: msgId,
        timestamp,
      });

      fs.writeFileSync(jsonlPath, snapshot + '\n' + assistantMsg + '\n');
      log.info(`[schedule] Pre-created schedule session ${sessionId} for ${projectPath}`);

      return { sessionId, systemPrompt };
    } catch (err) {
      log.error('[schedule] Failed to create schedule session:', err);
      return null;
    }
  });
  ipcMain.handle('run-schedule-now', async (_event, filePath) => {
    try {
      const target = resolveRunNowTarget(filePath, isPathAllowed);
      if (!target.ok) {
        log.warn(`[schedule] Refused run-schedule-now for ${JSON.stringify(filePath)}: ${target.error}`);
        return { ok: false, error: target.error };
      }
      const { realPath, projectPath } = target;
      if (isProjectArchived(projectPath)) return { ok: false, error: 'Project is archived; unarchive it before running schedules' };

      const content = fs.readFileSync(realPath, 'utf8');
      const { meta, body } = parseFrontmatter(content);
      if (!body) return { ok: false, error: 'No prompt in schedule file' };

      const folder = encodeProjectPath(projectPath);
      const schedule = {
        file: path.basename(realPath),
        filePath: realPath, projectPath, folder,
        name: meta.name || path.basename(realPath),
        cron: meta.cron || '* * * * *',
        slug: meta.slug || path.basename(realPath, '.md').replace(/^schedule-/, ''),
        cli: meta.cli || {},
        prompt: body,
      };

      const { sessionId } = createScheduleSession(schedule);
      const { claudeArgs } = buildScheduleCommand(sessionId, schedule);

      const result = await runCommand(claudeArgs, projectPath, schedule.name, () => {}, { manual: true, filePath: realPath, slug: schedule.slug });
      if (!result?.ok) return { ok: false, error: result?.error || 'The schedule launcher returned no result. Check the shell settings and project folder, then try Run now again.' };

      log.info(`[schedule] Manual run triggered: ${schedule.name} (session ${sessionId})`);
      return { ok: true, sessionId };
    } catch (err) {
      log.error('[schedule] Failed to run schedule:', err);
      return { ok: false, error: err.message };
    }
  });
}

function reportRunExit(window, { name, projectPath, sessionId, manual = false, code, signal, sandbox, stderr }) {
  if (code === 0 || !window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send('schedule-run-exit', {
    name, projectPath, sessionId, manual, code, signal: signal || null,
    failure: classifyRunExit({ code, sandbox, stderr }),
  });
}

module.exports = { ensureScheduleCreatorCommand, init, reportRunExit, SHIPPED_CREATOR_TEMPLATE_SHA256 };
