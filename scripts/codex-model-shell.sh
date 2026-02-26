#!/usr/bin/env bash

# Source this from ~/.bashrc to expose Codex model-routing helpers.
# Example:
#   source /home/zimele-dubazana/Klubz/scripts/codex-model-shell.sh

codex_fast() {
  codex -p fast_ops "$@"
}

codex_deep() {
  codex -p deep_work "$@"
}

codex_auto() {
  /home/zimele-dubazana/Klubz/scripts/codex-route.sh "$@"
}
