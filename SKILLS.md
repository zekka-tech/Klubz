# Skills Registry

## operational-bootstrap-and-delivery

Use this skill at the start of any implementation cycle to enforce consistent operational context and delivery quality.

### Trigger
- User asks to pull latest and execute implementation to production standards.
- User asks for full review/test/commit/push execution.

### Procedure
1. Sync repository:
   - `git pull`
   - `git status --short --branch`
2. Load operational context before edits:
   - `codex.md`
   - `CLAUDE.md`
   - `AGENTS.md`
3. Confirm constraints:
   - No secrets in code.
   - Preserve existing patterns and contracts.
   - Prefer smallest safe change set.
4. Implement requested changes with focused diffs.
5. Run quality gates:
   - Targeted tests for touched areas.
   - `npm run verify`
   - `npm run db:check-migrations` when schema-related changes are made.
6. Update continuity ledger:
   - Add action entries to `codex.md` for pull, major implementation actions, verification, commit, and push.
7. Commit and push with Conventional Commit message.

### Definition of Done
- Requested functionality is implemented and wired end-to-end.
- Tests and build pass.
- `codex.md` updated with exact actions and outcomes.
- Changes are committed and pushed.
