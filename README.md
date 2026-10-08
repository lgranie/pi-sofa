# pi-sofa

**So**ftware **Fa**ctory for [pi](https://pi.dev). Code first: the factory line is TypeScript, not a prompt.

You talk to one pi session, the orchestrator. It dispatches tasks to worker agents: `feature` (id `F001`…), `bug` (`B001`…) or `research` (`R001`…). The extension runs each task in [herdr](https://herdr.dev):

```
herdr workspace (project)
└─ herdr worktree, branch sofa/<id>    one per task
   ├─ tab "builder"   pi / claude / opencode / little-coder, started with `mise x` (installed if missing)
   └─ tab "reviewer"
```

0. A classifier rates the task `low` / `medium` / `high`. Each role defines an agent and its args per level (e.g. builder: pi `--thinking low` … claude `--model opus`). Without a classifier the level is `medium`.
1. Prompt the role's agent and supervise it through herdr agent state. A `blocked` worker is escalated to you.
2. Run the `check` command and require exit code 0. On failure, re-prompt the builder (max 3 attempts).
3. Commit, run the optional review, and report back to the orchestrator.
4. Finish with `sofa_finish`: `merge` (after your confirmation) or `discard`.

An interrupted task (pi restarted) or a failed one can be continued with `sofa_resume`. It picks up at the stage it stopped (`lead`, `check`, `review`). A worker still alive in its herdr pane is awaited, never re-prompted.

## Board

Tasks live on a markdown kanban board in the project, gitignored:

```
.sofa/
├─ board/<column>/<id>-<title>.md   one file per task; the column is its status
│    todo · running · blocked · ready · done · failed · interrupted · merged · discarded
└─ <id>/                            role prompts and worker reports (<role>.report.md)
```

A task file has front matter (`key: <JSON>` per line), the title and brief, links to its reports, and a log with one row per worker session:

| finished | role | agent | session | tokens in | tokens out | cost |
|---|---|---|---|---|---|---|
| 2026-10-08 10:02 | builder | pi --thinking medium | 01a1… | 12400 | 1800 | $0.0310 |

Tokens and cost are read from the harness's own session log: pi gives tokens and cost, claude gives tokens only, and opencode and little-coder aren't read yet.

- **Add:** `/sofa add [feature|bug|research] [title]` (dialogs ask for the brief, check and review), or ask the orchestrator (`sofa_dispatch` with `queue: true`). You can also drop a `.md` file into `todo/`: only a `# Title` is required, plus an optional `kind: bug` front matter. sofa gives it an id.
- **Start:** `/sofa start F001`, or let the orchestrator call `sofa_start`. `sofa_dispatch` without `queue` adds and starts in one go.
- **Edit:** while a task isn't running you can edit its file or move it between columns, e.g. move a failed one back to `todo/`. sofa rewrites the file of a task it is running.

`/sofa` shows the board, and `/sofa help` shows usage and the active agent config.

## Run

```sh
./sofa.sh            # or: .\sofa.ps1   (session name defaults to "sofa")
```

Run it from the project directory. It starts a dedicated herdr session, opens a workspace there with pi + the sofa extension, and attaches.

Requires `herdr`, `mise`, `git`. Setting up a new machine, the test plan and known pitfalls are in [NOTES.md](NOTES.md). The scripts also load [pi-decision-provider](https://github.com/lgranie/pi-decision-provider), so classifiers declared in `~/.pi/agent/models.json` (`type: "classifier"`) can rate tasks. pi's built-in classifiers (e.g. TypeSafe Jev with `TYPESAFE_API_KEY`) work too.

## Customize

Copy [`sofa-agents.json`](sofa-agents.json) and edit it. The first file found wins:

1. `<project>/.pi/sofa-agents.json` (only when the project is trusted)
2. `~/.pi/agent/sofa-agents.json`
3. the packaged default

- `execs`: mise tool + command typed into the herdr pane.
- `roles`: `builder`, `researcher`, `reviewer`. Each has a `prompt` (`{base}` = branch-point commit) and an `exec` + `args` per level.
- `classifier`: `"provider/id"`, or `null` for the first available.

The file is re-read every time a task starts.

## Test

```sh
npm run check
```

## Inspirations

- [Build Your Own AI Software Factory with Claude Code](https://www.youtube.com/watch?v=ctoaIC4LHmI): the software-factory idea, a pipeline of agent roles with gates between them.
- [firstmate](https://github.com/kunchenguid/firstmate) by Kun Chen: one agent you talk to, delegating to agents in isolated git worktrees supervised through a terminal multiplexer. sofa does the same with the pipeline in code rather than in instructions.
- [Kun Chen's opinions on agentic engineering](https://github.com/kunchenguid/kun/blob/main/OPINIONS.md): judge agents by useful work, keep human accountability explicit, isolate agents with fresh context, choose models by task shape, and treat requirements, tests and review as the real bottleneck.
