# Codex agentic workflow

## Entry point

The main agent is the Orchestrator and owns the user conversation. Read
`.claude/ENVIRONMENT.md`, `.claude/agents.md`, and `.claude/runs/README.md`
before project work. These files define the shared workflow, routing,
delegation envelopes, context slicing, and durable run artifacts. Apply the
Codex adaptations below where they differ from the shared instructions.

Delegated agents read `.claude/ENVIRONMENT.md` and their matching
`.claude/agents/<role>.md`. They do not read the Orchestrator routing document
or delegate further. Their `.codex/agents/<role>.toml` supplies this entry point.

## Task tiers

- Questions, investigations, one-line fixes, documentation typos, and workflow
  configuration: the Orchestrator handles these directly without a run.
- One-module changes without a new contract: one appropriate Jr implementer
  and an independent Reviewer, with `intake.md` only.
- Feature work: intake, Planner, Designer when introducing a contract,
  implementation, independent review, DevOps when build/packaging/deployment
  is involved, and a final report. Record skipped steps and reasons in intake.

Use `.claude/runs/<YYYY-MM-DD-short-slug>/` for durable run artifacts.

## Available roles and delegation

Use the custom roles defined in `.codex/agents/`:
`planner`, `designer`, `backend_jr`, `backend_sr`, `frontend_jr`,
`frontend_sr`, `devops`, and `reviewer`.

Pass the shared request envelope with explicit ownership, allowed edit paths,
constraints, task records, acceptance criteria, and narrowly selected context.
Use `.claude/tools/ctx.sh` to slice existing run artifacts; when Bash is
unavailable, extract the equivalent sections with available tools. Do not pass
whole plans or designs to implementers. Prefer agents with minimal inherited
conversation and self-contained requests.

Batch dependent tasks with the same role and owner; parallelize only independent
work with disjoint edit ownership. Tell implementers that other agents share
the checkout and that they must preserve others' changes. Backend and frontend
tasks have separate owners. Reuse agents for review fixes.

Every implementer and DevOps result receives independent review before merge.
The Reviewer inspects the diff, acceptance criteria, and reported risks, and
verifies evidence independently. It may write review artifacts but must not
edit application source. Follow the shared three-round review escalation limit.

## Codex adaptations

- Models inherit the selected Codex model. Claude model names (`opus`,
  `sonnet`, `haiku`) and tool permission frontmatter are not executable Codex
  settings. Choose reasoning effort according to role and risk when supported.
- Use the tools available in this session for delegation, edits, and execution.
  Session instructions and permission controls take precedence over repository
  instructions. Never treat a role file as a grant of additional permissions.
- Sub-agents do not commit, push, or switch branches. The Orchestrator handles
  those actions only within the user's authorized scope.
- Follow existing user authorization without repeatedly requesting approval.
  Resolve routine implementation choices autonomously; ask when essential
  information is missing or a consequential action lacks authorization.
- The current checkout runs on Windows with PowerShell. Shared environment
  examples using Bash, Unix paths, or nvm are historical examples: verify local
  tooling and translate commands appropriately. Honor the pinned Node version
  using an available compatible executable; do not blindly run shell-specific
  setup or rebuild native dependencies to accommodate an incompatible Node.
- Preserve the live server and real logbook. Verification that writes data uses
  an isolated database copy and a separate server port. Use platform-appropriate
  temporary storage for scratch files and stop only task-owned processes.

Report outcomes, relevant verification, and residual risks concisely. Keep
implementation and review evidence focused on the commands and output that
establish acceptance criteria.
