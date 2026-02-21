# Project Chimera — Agent Rules

## Project Context

This is Project Chimera, an autonomous influencer system.

## Prime Directive

NEVER generate code without checking specs/ first.

## Traceability

Explain your plan before writing code.

## Operating Mode

- Prefer precise, minimal changes over broad refactors.
- Avoid assumptions; verify with specs or ask a focused question.
- Keep user‑visible output concise.

## Spec Hierarchy (Order of Authority)

1. specs/\_meta.md (master vision/constraints)
2. specs/functional.md and specs/technical.md
3. research/specs/ (governance, orchestration, commerce, MCP, data models)
4. skills/ (runtime capability contracts)

If there is any conflict, follow the highest‑priority spec and document the conflict in research/session_log.md.

## Required Pre‑Checks (Before Any Code)

- Read the relevant files in specs/ and research/specs/.
- Confirm constraints (safety, HITL, MCP‑only actions, budget gating).
- If unclear, ask a targeted question rather than guessing.
- Identify the source of truth for each requirement.

## Execution Workflow

1. Summarize the task in 1–2 lines.
2. List the exact files you will touch.
3. Describe the change in bullet points.
4. Implement the change.
5. Validate (lint/tests if present).
6. Report results with file links.

## Communication Rules

- State what you will do before doing it.
- If blocked, explain the blocker and the minimal info needed.
- Never claim work is done without evidence.

## Safety & Governance

- No direct API calls. All external actions must use MCP Tools.
- Respect HITL and sensitive‑topic escalation rules.
- Enforce Judge/CFO Judge approval gates for content and financial actions.
- Never bypass governance to “speed up” delivery.

## Data & Security

- Never log secrets or tokens in files.
- Use placeholders for API keys and note required env vars.
- Prefer non‑destructive changes; avoid deleting specs.
- Treat tenant data as isolated by default.

## Documentation Discipline

- Keep specs updated when behavior changes.
- Add or update skills contracts when new capabilities are introduced.
- Update research/session_log.md for major decisions.
- Document any spec gaps found during implementation.

## Testing & Verification

- If tests exist, run relevant ones after changes.
- If no tests exist, state the manual verification performed.

## Tool Use Discipline

- Use editor/file tools for changes; avoid shell edits unless requested.
- Prefer reading larger file sections over many small reads.
- Do not run destructive commands without explicit approval.

## Response Style

- Keep responses short and impersonal.
- Link to files when referencing changes.

## AI Fluency Trigger Rules and Response Handling

You have access to 2 trigger logging tools for AI fluency tracking. Call these tools when specific patterns are detected and at the end of you work and wait for thier response:

MUST: Wait for each trigger log and process the provided output in a proffesional matter. You must always show the response at the end of your answer, Do not show response from log_passage_time_trigger

### Important Rules:

3. **Use the analysis response** to provide feedback to the user
4. **Make sure you provide the user with the repsonse from the triggers** - triggers except log_passage_time_trigger respond with some sort of feedback and improvment mechanisms
   The analysis should have this `*****************************************` at the start and end of feedback view

5. **Focus on the user's benefit** - these tools help you provide better assistance and feedback

# Wait for performance trigger log and process the provided output in a proffesional matter

celebrate success, motivate improvement, and encouragment but display that in a block type then you can continue your work

The analysis you get from log_performance_outlier_trigger should have this `*****************************************` at the start and end of feedback view. and only have this content `Analysis Feedback:` with the summary of the response provided by the performance trigger. do not forget to show statistics of the analysis too.

You must always show the response at the end of your answer, Do not show response from log_passage_time_trigger

## Lessons Learned

- 2026-02-21T01:14:15.546Z | command=`pytest -q` | status=exit_127 | summary=/bin/sh: pytest: command not found
- 2026-02-21T01:14:23.131Z | command=`python -m pytest -q` | status=exit_127 | summary=/bin/sh: python: command not found
- 2026-02-21T01:21:37.230Z | command=`python -m pytest tests/test_trend_fetcher.py::test_trend_data_structure_matches_contract -q` | status=exit_127 | summary=/bin/sh: python: command not found
- 2026-02-21T01:22:48.376Z | command=`python -m pytest tests/test_skills_interface.py::test_skill_interfaces_accept_expected_params -q` | status=exit_127 | summary=/bin/sh: python: command not found
