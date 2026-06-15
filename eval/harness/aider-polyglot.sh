#!/usr/bin/env bash
# Aider polyglot adapter for eval/bench-matrix.ts — DOCKER SANDBOX edition.
#
# The benchmark executes model-generated solution code, so it runs inside aider's container
# (image `aider-benchmark`, built by `./benchmark/docker_build.sh`). The frites gateway, by
# contrast, runs on the HOST (its child claude/codex CLIs need the host's OAuth/keychain), so the
# container reaches it via host.docker.internal — which is why bench-matrix must bind the gateway to
# 0.0.0.0 (export FRITES_BENCH_GATEWAY_HOST=0.0.0.0). See eval/README.md.
#
# bench-matrix invokes this once per condition with these env vars:
#   FRITES_BENCH_URL        gateway base url on the host (empty for raw-model passthrough baselines)
#   FRITES_BENCH_MODEL      bare model id, e.g. "frites-council" or "anthropic/claude-opus-4-8"
#   FRITES_BENCH_RESULT     host path to write the results JSON this script must produce
#   FRITES_BENCH_NUM_TESTS  exercise cap (empty = run all 225)
#   FRITES_BENCH_CONDITION  condition name (labels the aider run dir)
#   ANTHROPIC_API_KEY / OPENAI_API_KEY  forwarded into the container for raw baselines
#
# You set these (see eval/README.md):
#   AIDER_REPO          path to your cloned aider checkout (with tmp.benchmarks/polyglot-benchmark)
#   AIDER_DOCKER_IMAGE  (optional, default "aider-benchmark")
#   AIDER_EDIT_FORMAT   (optional, default "whole" — easiest for the council to emit correctly)
#   AIDER_THREADS       (optional, default 2 — keep LOW; each frites request fans out to a fleet of
#                        child CLIs, so high thread counts swamp the host + the children's rate limits)
#   AIDER_TRIES         (optional, default 2 — gives the pass@2 column)
set -euo pipefail

: "${AIDER_REPO:?set AIDER_REPO to your aider checkout (see eval/README.md)}"
EDIT_FORMAT="${AIDER_EDIT_FORMAT:-whole}"
THREADS="${AIDER_THREADS:-2}"
TRIES="${AIDER_TRIES:-2}"
IMAGE="${AIDER_DOCKER_IMAGE:-aider-benchmark}"
# Sanitize the condition name for use in a path: it can contain '/', '+', and spaces (e.g.
# "claude+codex / oauth"), and a '/' silently splits the run dir so the stats lookup misses and
# falls back to a STALE run dir — reporting the wrong numbers. Map anything unsafe to '-'.
SAFE_COND="$(printf '%s' "${FRITES_BENCH_CONDITION:-run}" | tr -c 'A-Za-z0-9._-' '-')"
RUN_NAME="frites-${SAFE_COND}-$(date +%s)"

# Removed on exit even if the run fails (set -e would otherwise skip a trailing rm).
SETTINGS_DIR=""
cleanup() { [ -n "${SETTINGS_DIR:-}" ] && rm -rf "$SETTINGS_DIR"; }
trap cleanup EXIT

# Per-condition docker args (mounts + env that differ between frites and raw baselines).
EXTRA_DOCKER=()
SETTINGS_FILE="" # in-container path to the model-settings yaml; empty for passthrough baselines

if [ -n "${FRITES_BENCH_URL:-}" ]; then
  MODEL="anthropic/${FRITES_BENCH_MODEL}"
  # On the host the gateway is 127.0.0.1:PORT; from inside the container that's the CONTAINER. Reach
  # the host gateway via host.docker.internal (docker.sh maps it with --add-host, incl. on Linux).
  CONTAINER_URL="$(printf '%s' "$FRITES_BENCH_URL" | sed -e 's#127\.0\.0\.1#host.docker.internal#' -e 's#localhost#host.docker.internal#')"
  # LiteLLM rejects unknown anthropic model names for cost/token mapping; alias it. mktemp -d with
  # TRAILING X's is portable across BSD/macOS and GNU mktemp. Mounted read-only into the container.
  SETTINGS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/frites-aider.XXXXXX")"
  cat > "$SETTINGS_DIR/model-settings.yml" <<YML
- name: ${MODEL}
  edit_format: ${EDIT_FORMAT}
  use_temperature: false
  extra_params:
    max_tokens: 8192
YML
  SETTINGS_FILE="/frites-settings/model-settings.yml"
  EXTRA_DOCKER+=(-v "$SETTINGS_DIR:/frites-settings:ro")
  EXTRA_DOCKER+=(-e "ANTHROPIC_API_BASE=$CONTAINER_URL")
  EXTRA_DOCKER+=(-e "ANTHROPIC_BASE_URL=$CONTAINER_URL")
  # Auth is off on the gateway by default; any token works. (Children auth on the host, not here.)
  EXTRA_DOCKER+=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-frites}")
else
  MODEL="${FRITES_BENCH_MODEL}"
  # Raw baseline → real provider APIs; forward whatever creds the host has (-e VAR passes its value,
  # or nothing if unset — no shell expansion, so safe under set -u).
  EXTRA_DOCKER+=(-e ANTHROPIC_API_KEY -e OPENAI_API_KEY)
fi

# Runs INSIDE the container. Single-quoted heredoc → the host does NOT expand these; they resolve
# in-container from the -e vars below. benchmark.py progress → stderr (streams to your console);
# stdout stays clean for the stats capture. Container bash is 5.x, so no Bash-3.2 array caveats here.
IN_CONTAINER=$(cat <<'SCRIPT'
set -e
# aider is editable-installed against the mounted /aider; skip if the image already baked it in.
pip show aider-chat >/dev/null 2>&1 || pip install -q -e ".[dev]" >/dev/null 2>&1 || pip install -q -e . >/dev/null 2>&1 || true
ARGS=(--model "$MODEL" --edit-format "$EDIT_FORMAT" --tries "$TRIES" --threads "$THREADS" --exercises-dir polyglot-benchmark --new)
[ -n "${SETTINGS_FILE:-}" ] && ARGS+=(--read-model-settings "$SETTINGS_FILE")
[ -n "${NUM_TESTS:-}" ] && ARGS+=(--num-tests "$NUM_TESTS")
./benchmark/benchmark.py "$RUN_NAME" "${ARGS[@]}" 1>&2
RUN_DIR="$(ls -dt /benchmarks/*--"$RUN_NAME" 2>/dev/null | head -n1 || true)"
[ -n "$RUN_DIR" ] || RUN_DIR="$(ls -dt /benchmarks/*/ 2>/dev/null | head -n1 || true)"
echo "FRITES_RUN_DIR=$RUN_DIR"
./benchmark/benchmark.py --stats "$RUN_DIR" 2>/dev/null || true
SCRIPT
)

# `|| true` so a docker/benchmark failure still lets us write a (zero) result row instead of aborting
# the whole adapter — bench-matrix then shows the failure in the row's notes rather than a bare crash.
OUT="$(docker run --rm \
  --memory=12g --memory-swap=12g \
  --add-host=host.docker.internal:host-gateway \
  -v "$AIDER_REPO:/aider" \
  -v "$AIDER_REPO/tmp.benchmarks/.:/benchmarks" \
  -w /aider \
  -e AIDER_DOCKER=1 \
  -e AIDER_BENCHMARK_DIR=/benchmarks \
  -e RUN_NAME="$RUN_NAME" \
  -e MODEL="$MODEL" \
  -e EDIT_FORMAT="$EDIT_FORMAT" \
  -e TRIES="$TRIES" \
  -e THREADS="$THREADS" \
  -e NUM_TESTS="${FRITES_BENCH_NUM_TESTS:-}" \
  -e SETTINGS_FILE="$SETTINGS_FILE" \
  "${EXTRA_DOCKER[@]+"${EXTRA_DOCKER[@]}"}" \
  "$IMAGE" \
  bash -c "$IN_CONTAINER" || true)"

# Parse the captured --stats on the host (key names drift across aider versions — confirm once with
# `./benchmark/benchmark.py --stats <run-dir>`). Trailing `|| true` keeps no-match set -e-safe.
STATS="$OUT"
RUN_DIR="$(printf '%s\n' "$OUT" | sed -n 's/^FRITES_RUN_DIR=//p' | head -n1 || true)"
# `sed 's/.*[:=]//'` drops everything up to the LAST : or = first, so the number we grab is the
# VALUE — not a digit inside the key name (e.g. the "1" in "pass_rate_1"). Portable BSD/GNU sed.
grab() { { printf '%s\n' "$STATS" | grep -iE "$1" | head -n1 | sed 's/.*[:=]//' | grep -oE '[0-9]+(\.[0-9]+)?' | head -n1; } || true; }

P1="$(grab 'pass_rate_1')"; P1="${P1:-0}"
P2="$(grab 'pass_rate_2')"; P2="${P2:-0}"
# pass@2 is cumulative (>= pass@1); aider omits pass_rate_2 when no case needed a 2nd try, so floor it.
P2="$(awk -v a="$P1" -v b="$P2" 'BEGIN{print (b>a)?b:a}')"
WF="$(grab 'percent_cases_well_formed|well_formed')"; WF="${WF:-0}"
COST="$(grab 'total_cost|(^|[^a-z])cost')"; COST="${COST:-0}"
N="$(grab 'test_cases|num_tests|completed')"; N="${N:-0}"
PT="$(grab 'prompt_tokens')"; PT="${PT:-0}"
CT="$(grab 'completion_tokens')"; CT="${CT:-0}"

NOTES="aider polyglot ${EDIT_FORMAT}/${TRIES}tries (docker) ${RUN_DIR:-<no run dir>}"
printf '%s' "$STATS" | grep -qiE 'pass_rate' || NOTES="NO STATS PARSED — run likely failed, see console. ${NOTES}"

cat > "$FRITES_BENCH_RESULT" <<JSON
{"pass_rate_1": ${P1}, "pass_rate_2": ${P2}, "percent_well_formed": ${WF}, "cost_usd": ${COST}, "n": ${N}, "prompt_tokens": ${PT}, "completion_tokens": ${CT}, "notes": "${NOTES}"}
JSON
# SETTINGS_DIR is removed by the EXIT trap.
