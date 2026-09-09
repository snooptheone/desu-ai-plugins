#!/bin/bash
# Runs the scenarios in benchmarks.json against the real agy CLI and reports
# Claude-context token savings: chars/4 of the raw files (no shunt) vs
# chars/4 of what actually comes back into Claude's context (with shunt).
#
# Needs a working, authenticated `agy` on PATH. Takes 10-30s per scenario.

set -u
cd "$(dirname "$0")"

PLUGIN_ROOT="$(cd .. && pwd)"
BULK_READ="$PLUGIN_ROOT/scripts/bulk-read"
CODE_WRITE="$PLUGIN_ROOT/scripts/code-write"

tokens_of() {
  # $1: one or more file paths -> chars/4, summed
  local total=0 f
  for f in "$@"; do
    total=$((total + $(wc -c < "$f" | tr -d ' ')))
  done
  echo $((total / 4))
}

printf '%-24s %14s %14s %10s\n' "scenario" "no-shunt(tok)" "with-shunt(tok)" "savings"
printf '%-24s %14s %14s %10s\n' "--------" "-------------" "----------------" "-------"

n_scenarios=$(jq '.benchmarks | length' benchmarks.json)
for i in $(seq 0 $((n_scenarios - 1))); do
  scenario=$(jq -c ".benchmarks[$i]" benchmarks.json)
  name=$(echo "$scenario" | jq -r '.name')
  type=$(echo "$scenario" | jq -r '.type')

  if [ "$type" = "bulk-read" ]; then
    question=$(echo "$scenario" | jq -r '.question')
    mapfile -t paths < <(echo "$scenario" | jq -r '.paths[]')

    no_shunt_tok=$(tokens_of "${paths[@]}")

    answer=$("$BULK_READ" --question "$question" --paths "${paths[@]}" 2>/dev/null)
    rc=$?
    if [ $rc -ne 0 ]; then
      printf '%-24s %14s %14s %10s\n' "$name" "$no_shunt_tok" "ERROR" "-"
      continue
    fi
    with_shunt_tok=$(( ${#answer} / 4 ))
    savings=$(awk -v a="$no_shunt_tok" -v b="$with_shunt_tok" 'BEGIN { if (a==0) print "n/a"; else printf "%.0f%%", (1 - b/a) * 100 }')
    printf '%-24s %14s %14s %10s\n' "$name" "$no_shunt_tok" "$with_shunt_tok" "$savings"

  elif [ "$type" = "code-write" ]; then
    spec=$(echo "$scenario" | jq -r '.spec')
    reference=$(echo "$scenario" | jq -r '.reference')
    mapfile -t context_files < <(echo "$scenario" | jq -r '.context_files[]')

    no_shunt_tok=$(tokens_of "${context_files[@]}")

    target=$(mktemp)
    "$CODE_WRITE" --spec "$spec" --reference "$reference" --target "$target" 2>/dev/null
    rc=$?
    if [ $rc -ne 0 ]; then
      printf '%-24s %14s %14s %10s\n' "$name" "$no_shunt_tok" "ERROR" "-"
      rm -f "$target"
      continue
    fi
    lines=$(wc -l < "$target" | tr -d ' ')
    rm -f "$target"
    # Output goes straight to disk, so Claude-context cost with shunt is ~0
    # (just the one-line command). "no-shunt" here is only what reading the
    # reference/context would have cost — it excludes the generation itself,
    # which Claude would otherwise have paid for as *output* tokens too.
    printf '%-24s %14s %14s %10s\n' "$name" "$no_shunt_tok" "~0 (${lines}L to disk)" "-"

  fi
done

echo
echo "Notes:"
echo "  - Token counts are chars/4, a conservative estimate for code (same heuristic the scripts use)."
echo "  - code-write savings aren't directly comparable: without shunt, Claude also pays *output*"
echo "    tokens to generate the code inline, which isn't counted in the no-shunt column above."
echo "  - Real numbers depend heavily on file size and question specificity; these fixtures are"
echo "    small (35-602 lines) — savings widen further on the real large files you'd actually hit"
echo "    the ${SHUNT_MIN_LINES:-350}-line hook threshold with."
