# CLAUDE

## Lessons Learned

- Keep `apply_diff` search anchors minimal in high-churn sections (for example `recent_history`) to avoid strict-match failures.
- For intent-governed writes, `write_to_file` should always carry `intent_id` and `mutation_class`; dispatcher shim now backfills when active intent exists.

## Governance Rollups

- Dashboard rollups are implemented in `src/hooks/GovernanceRollupService.ts`.
- Coverage is in `src/hooks/__tests__/GovernanceRollupService.spec.ts`.

### What it rolls up

- Intent funnel and status counts.
- Governance ledger totals (`OK`, `FAILED`, `DENIED`), denied-by-tool, top denied paths.
- Trace activity totals, mutation class mix (`AST_REFACTOR`, `INTENT_EVOLUTION`, `UNSPECIFIED`), specification activity.
- Risk hotspots by `intent_id` + path.

### Snapshot usage

- Programmatic snapshot export:
    - Instantiate `GovernanceRollupService(workspacePath)`.
    - Call `writeSnapshot("reports/governance-dashboard-sample.json")`.
