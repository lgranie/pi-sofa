---
id: "R001"
kind: "research"
---

# R001 Session usage for opencode and little-coder

`extensions/sofa/harness.ts` reads token usage for pi and claude, but not for opencode and little-coder.

Find out, from their docs or source, not guesses:
1. **opencode:** where a session's token usage and cost are stored (file, SQLite, CLI such as `opencode session` / `opencode stats` / `opencode export`), and how to look one up by the session id herdr reports (`herdr agent get <pane>` → `agent.agent_session.value`).
2. **little-coder** (built on pi): does it accept pi's `--append-system-prompt <file>` and `--thinking <level>`? Where does it keep sessions (its own agent dir?), and is the format pi's session JSONL?
3. Whether herdr detects little-coder as an agent (`herdr agent get` after starting it in a pane).

Report the exact paths, commands and formats, plus a sketch of the `usage(sessionId)` function for each.
