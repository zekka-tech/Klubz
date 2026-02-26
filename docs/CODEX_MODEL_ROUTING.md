# Codex Model Routing

This setup routes low-compute operational tasks to a smaller model profile and keeps complex implementation tasks on a stronger profile.

## Profiles

Add these profiles in `~/.codex/config.toml`:

- `fast_ops`: mini model for operational tasks
- `deep_work`: primary model for implementation/reasoning-heavy work

## Wrapper

Use:

```bash
/home/zimele-dubazana/Klubz/scripts/codex-route.sh <codex args...>
```

Routing behavior:

- `fast_ops` profile for prompts/commands that look like:
  - `git status`, `git pull`, `git push`, `git commit`, `git log`, `git show`, `git diff`
  - code/search/file inspection patterns (`rg`, `grep`, `find`, `ls`, `cat`, `sed`, `head`, `tail`, `wc`)
  - phrases like `search codebase`, `scan repo`, `read files`
- `deep_work` for everything else.

## Optional shell functions

Source helper functions:

```bash
source /home/zimele-dubazana/Klubz/scripts/codex-model-shell.sh
```

Available commands:

- `codex_fast ...` -> always `-p fast_ops`
- `codex_deep ...` -> always `-p deep_work`
- `codex_auto ...` -> route automatically using `codex-route.sh`

## Overrides

- Explicit model/profile bypasses routing logic:
  - `codex_auto -m gpt-5.3-codex ...`
  - `codex_auto -p deep_work ...`
- Force a profile for one call:
  - `CODEX_PROFILE_FORCE=fast_ops codex_auto ...`
