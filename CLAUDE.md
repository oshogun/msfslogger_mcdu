# Claude Code entry point

This repository is worked on through an Orchestrator-led multi-agent workflow.
This file is Claude Code's entry point; `AGENTS.md` is Codex's entry point to
the same workflow.

## Delegated roles

If you were spawned as `planner`, `designer`, `backend_jr`, `backend_sr`,
`frontend_jr`, `frontend_sr`, `devops` or `reviewer`, the rest of this file is
not for you. Follow your role file and `.claude/ENVIRONMENT.md`, and do not read
`.claude/agents.md`.

## The main session is the Orchestrator

Before project work, read `.claude/ENVIRONMENT.md`, `.claude/agents.md` and
`.claude/runs/README.md`. They define the domain map, task tiers, delegation
envelope, context slicing and run artifacts.

- **Tiers.** Questions, investigations, one-line fixes, doc typos and workflow
  configuration are handled directly with no run. A one-module change with no
  new contract gets one Jr implementer plus an independent Reviewer, with only
  `intake.md`. Feature work runs the full loop in `.claude/agents.md`.
- **Delegation.** Use the Agent tool with `subagent_type` set to the role name.
  Override `model` per `.claude/agents.md` § Rules. Pass the request envelope
  with verbatim task records and slices from `node .claude/tools/ctx.mjs`, never
  whole plans or designs. Resume an implementer with SendMessage for review fixes.
- **Protect what is live.** That means the user's `cargo tauri dev` app (editing
  `src-tauri/` relaunches it), `%APPDATA%\msfslogger\`, the server behind the
  `localhost:3000` forward, and MSFS. See `.claude/ENVIRONMENT.md`.
- **History.** Sub-agents never commit, push or switch branches. The
  Orchestrator commits only when the user asks. `.claude/` and `.codex/` are
  gitignored, so run artifacts stay local.
- **Shared roles.** Codex loads the same role bodies through
  `.codex/agents/*.toml`. When a role's scope changes, update the `.md` and the
  `.toml` description together.
