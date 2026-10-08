# pi-sofa notes

Everything needed to set up and test sofa on another machine: setup, a test plan, what has been verified, known pitfalls, design decisions and open work. The README covers usage.

## Set up a new machine

**Prerequisites**

| Tool | Notes |
|---|---|
| git | Commits need `user.name` / `user.email`. Repo commits so far use `laurent.granie@gmail.com`. |
| [herdr](https://herdr.dev) | Developed against 0.9.3 (protocol 22). `herdr status` must show the server running. |
| [mise](https://mise.jdx.dev) | Installs and launches the agent harnesses (`mise x <tool> -- ...`). |
| Node.js ≥ 22.19 | Needed by pi and little-coder, and by `npm run check` (Node 24 runs `.ts` tests directly). |
| pi | Through mise: `mise use -g pi`. sofa launches it as `mise x pi -- pi`, so a global version isn't strictly needed. |

**Steps**

1. `git clone https://github.com/lgranie/pi-sofa` and run `npm run check` (3 board tests should pass).
2. Log in the agents the roles use. The default `sofa-agents.json` uses:
   - **pi** (builder low/medium, researcher): run `pi`, then `/login` or set a provider API key.
   - **claude** (builder high, reviewer at all levels): run `claude` once and log in. mise installs it if missing (`mise x claude`).
   - If one of them isn't available, edit `~/.pi/agent/sofa-agents.json` (copy the packaged one) to use only what you have.
3. Optional classifier, to pick low/medium/high per task. Without one, every task runs at `medium`.
   - pi built-in: TypeSafe Jev with `TYPESAFE_API_KEY`.
   - Your own: declare a `type: "classifier"` model in `~/.pi/agent/models.json`. The launch scripts load [pi-decision-provider](https://github.com/lgranie/pi-decision-provider) to register it. On Windows it currently fails (see pitfalls).
4. In the project to work on (a git repo with at least one commit), run `path/to/pi-sofa/sofa.ps1` (Windows) or `sofa.sh` (macOS/Linux). It starts the `sofa` herdr session, opens a workspace with pi and the extension, and attaches.
5. In that pi: `/login` if needed, then `/sofa help`. It shows the config file in use and each role's agent per level.

## Test plan

Not yet run with a real model. Go from cheap to expensive:

1. **Load:** `/sofa help` lists the config and roles. `/sofa` shows "Board is empty."
2. **Research task (cheap):** `/sofa add research Where is X handled?`, then `/sofa start R001`.
   - Expect: a herdr worktree workspace `sofa-R001` with a tab `researcher:medium`, the agent answers, the task moves to `.sofa/board/done/`, and the orchestrator receives the report.
   - Check the task file's Log row: session id, tokens, and cost for pi.
3. **Feature with gate and review:** ask the orchestrator for a small feature with `check: "npm test"` (or any command) and `review: true`.
   - Expect: builder tab, check run (it re-prompts the builder on failure, max 3 attempts), commit on `sofa/F001` titled with the task title, then a `reviewer:medium` tab (claude) and the task in `ready/`.
4. **Merge:** "merge F001". Expect a confirmation dialog, a `--no-ff` merge into the repo's current branch, the worktree removed and the task in `merged/`.
5. **Blocked escalation:** claude runs with `--permission-mode acceptEdits`, so a bash command makes it ask. Expect the task in `blocked/` and the orchestrator naming the herdr pane that needs you. Answer in the pane and the task continues.
6. **Resume:** restart pi while a task is running. Expect it in `interrupted/`. `sofa_resume <id>` waits on the still-running pane instead of re-prompting.
7. **Hand-written task:** drop `todo/idea.md` containing `# Some title` into `.sofa/board/`. `/sofa` gives it an id (F00x).
8. **Self-improvement:** run sofa in the pi-sofa repo itself with `check: "npm run check"`. Restart pi after merging, since a merge doesn't change the running session.

## Verified so far (Windows 11, herdr 0.9.3, pi 1.0.2)

- Extension loads as a directory (`-e extensions/sofa`) and as a package (`-e .`). `/sofa help` and the board view work.
- `sofa-agents.json` lookup and validation, with errors reported at session start.
- End to end through pi RPC in a scratch repo:
  - `/sofa add` dialogs, `F001` / `B001` ids, a hand-written todo file picked up
  - `/sofa start`, herdr worktree on `sofa/F001`, tab `builder:medium`, role prompt file
  - `mise x pi -- pi --thinking medium --append-system-prompt <file>`, herdr detecting the agent, prompt delivered
  - failure path: `agent_prompt_stalled` (no model) → `failed/` with the error report
- Harness args for pi, claude, opencode (agent defined through `OPENCODE_CONFIG`, confirmed with `opencode agent list`) and little-coder.
- Claude usage reader on a real transcript.
- Board markdown round-trip (`npm run check`).

**Not verified:** any real model run, the check gate, commit, review, merge, resume, blocked handling, the pi usage reader on a real session, a real classifier, little-coder, and `sofa.sh` on macOS/Linux.

## Pitfalls found

- **herdr on Windows:** `herdr agent start` refuses fresh panes ("not an available shell"). sofa uses `herdr pane run "<cmd>"` instead, and herdr's process detection then recognizes the agent.
- **`herdr pane run` prints nothing on success.** The CLI wrapper treats exit 0 without JSON as success.
- **`herdr worktree create --cwd <repo>`** also opens a primary workspace for the repo if none exists. Worktrees live in `~/.herdr/worktrees/<repo>/<branch-slug>`.
- **pi shim without a global version:** a bare `pi` fails with "No version is set for shim: pi". sofa and the scripts always use `mise x pi -- pi`.
- **pi-decision-provider on Windows:** it reads `process.env.HOME`, which is empty on Windows, so it never finds `models.json` and registers nothing. Fix: `os.homedir()` in its `modelsJsonPath()`.
- **JIRA commit hook** (this Windows machine only: scoop's global `core.hooksPath`): every commit message needs a key matching `[A-Z]{4,6}-[0-9]{1,6}`. sofa commits use the task title, so titles need the key. Repo commits so far skipped it with `--no-verify`, with explicit consent each time.
- **pi without a model:** prompts stall (`agent_prompt_stalled`). `/login` first.
- **`/reload` vs restart:** after an in-process `/reload` the old runtime may keep supervising running tasks. Restart pi, then use `sofa_resume`.

## Decisions made

- **Code first:** the pipeline is TypeScript (`pipeline.ts`); prompts only carry the role and the task.
- **Vocabulary:** no naval terms (firstmate is only an inspiration). The pi session is the orchestrator, agents are workers, task kinds are feature/bug/research, roles are builder/researcher/reviewer, `sofa_finish` merges or discards, and the status icon is 🛋.
- **Task ids:** `F001` feature, `B001` bug, `R001` research, numbered separately per prefix.
- **Roles in `sofa-agents.json`:** an exec and args per level (low/medium/high), chosen by a classifier. Lookup order: trusted project `.pi/`, then `~/.pi/agent/`, then the packaged default.
- **herdr layout:** a workspace per project, a worktree and branch per task, a tab per role.
- **Role prompt as system prompt** where the harness supports it (`harness.ts`): pi and little-coder use `--append-system-prompt`, claude uses `--append-system-prompt-file`, opencode gets a generated agent plus `--agent`. Other harnesses get it in the first message.
- **Board:** a markdown kanban in `.sofa/board/<column>/` (gitignored). `todo/` is a backlog that only starts explicitly. The log has one row per role session with tokens and cost.
- **Merging stays a human decision**, confirmed in a dialog.

## Open work

The backlog is sofa's own board: `.sofa/board/todo/` in this repo, one task file each with a brief and acceptance criteria. Run sofa in this repo, then `/sofa start <id>`.

| id | task | why |
|---|---|---|
| F001 | Reproduce-first gate for bug tasks | check must fail before the fix and pass after it |
| F002 | Flag changed test files | an agent can make `check` pass by weakening tests |
| F003 | Leaner orchestrator messages | full reports in the conversation cause context rot |
| F004 | `/sofa stats` | cost per merged task, merge rate per level and agent |
| F005 | Limit concurrent running tasks | `maxRunning` in sofa-agents.json |
| B001 | Cost of unsettled workers is not logged | failed or discarded workers miss their log row |
| B002 | Resume leaves an idle worker tab | pane recorded only when prompted |
| R001 | Session usage for opencode and little-coder | needed before writing their usage readers |

Suggested order: R001 and F003 first, since they're cheap and make the rest easier to follow, then F001, F002, B001, F004, F005, B002. F001 to F004 come from Kun Chen's [OPINIONS.md](https://github.com/kunchenguid/kun/blob/main/OPINIONS.md).

Task titles are commit messages. On a machine with the JIRA hook, prefix them with a key before starting.

Not on the board:
- The pi-decision-provider Windows fix (`os.homedir()`) belongs in that repo.
- Edits to a task file while sofa runs that task are overwritten. This is a known limit of the design.
