#!/usr/bin/env bash
# Drive the fleet DAILY ceiling against the built dist/cli.js.
#
# Why this is a script and not a vitest case: the daily branch in checkSendAllowed sits
# after the hourly branch, so at the real defaults it is unreachable in any fast test.
# Hitting it would need over 200 sends with under 60 in every rolling hour. The guard
# constants are read from process.env at module load, so lowering the daily cap and
# raising the hourly one makes the branch reachable in six sends.
#
# This matters because in this same codebase the thread-depth cap passed its unit tests
# while being decoration. An unexercised branch is not a shipped guard.
#
#   bash scripts/verify-daily-ceiling.sh
#
# Exits 0 only if the 6th send is refused by the DAILY ceiling specifically.
set -u

cd "$(dirname "$0")/.." || exit 1
INSTANCE="guardtest-daily-$$"
export CTX_INSTANCE_ID="$INSTANCE"
export CTX_MAX_FLEET_MSGS_PER_HOUR=100000   # take the hourly branch out of the way
export CTX_MAX_FLEET_MSGS_PER_DAY=5

fail() { echo "FAIL: $*"; exit 1; }

sent=0
out=""
rc=0
# Distinct pairs every time, so neither the pair cap (10) nor the depth cap can be
# what refuses. Only a fleet-wide daily counter can see this traffic.
for i in 1 2 3 4 5 6; do
  out=$(CTX_AGENT_NAME="s$i" node dist/cli.js bus send-message "r$i" normal "day $i" 2>&1)
  rc=$?
  [ $rc -ne 0 ] && break
  sent=$((sent + 1))
done

echo "sent before refusal: $sent (want 5)"
[ "$sent" -eq 5 ] || fail "expected 5 sends before the daily cap, got $sent"
[ $rc -eq 1 ] || fail "expected exit 1 on the refused send, got $rc"

echo "$out" | grep -q 'Fleet daily limit' \
  || fail "refusal did not come from the daily ceiling. Got: $out"
echo "$out" | grep -q 'Fleet rate limit' \
  && fail "hourly branch fired instead of daily; the daily branch is still unreachable"

echo "refusal message: $(echo "$out" | grep 'REFUSED' | head -c 200)"
echo "PASS: daily ceiling is reachable, counts across distinct pairs, exits 1"
exit 0
