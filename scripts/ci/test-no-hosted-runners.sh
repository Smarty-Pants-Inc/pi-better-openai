#!/usr/bin/env bash
# Deletion-free regression checks for the canonical #1246 runner policy.
set -euo pipefail
export TMPDIR=$(mktemp -d)
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="${GUARD:-$repo_root/scripts/ci/no-hosted-runners.sh}"

bash "$guard" "$repo_root/.github/workflows"
echo 'PASS: every repository workflow'
: > "$TMPDIR/empty.txt"

expect_rejected() {
  local name="$1" content="$2" diagnostic="$3" fixture output
  fixture="$(mktemp -d "$TMPDIR/case.XXXXXX")"
  printf '%s\n' "$content" > "$fixture/probe.yml"
  if output="$(bash "$guard" "$fixture" "$TMPDIR/empty.txt" 2>&1)"; then
    echo "FAIL: $name was accepted" >&2
    exit 1
  fi
  if [[ "$output" != *"$diagnostic"* ]]; then
    printf 'FAIL: %s lacked expected diagnostic:\n%s\n' "$name" "$output" >&2
    exit 1
  fi
  printf 'PASS: rejected %s (%s)\n' "$name" "$diagnostic"
}

expect_rejected 'unapproved self-hosted label' $'jobs:\n  check:\n    runs-on: [self-hosted, unapproved-linux-x64]' 'unapproved runner: unapproved-linux-x64'
expect_rejected 'generic labels without ownership' $'jobs:\n  check:\n    runs-on: [self-hosted, Linux, X64]' 'runner ownership not established'
expect_rejected 'owned label alongside unknown label' $'jobs:\n  check:\n    runs-on: [smarty-linux-x64, unapproved-linux-x64]' 'unapproved runner: unapproved-linux-x64'
expect_rejected 'multiline unapproved label' $'jobs:\n  check:\n    runs-on:\n      - self-hosted\n      - unapproved-linux-x64' 'unapproved runner: unapproved-linux-x64'
expect_rejected 'unapproved group' $'jobs:\n  check:\n    runs-on:\n      group: unapproved-ci\n      labels: smarty-linux-x64' 'unapproved runner: unapproved-ci'
expect_rejected 'expression selector' $'jobs:\n  check:\n    runs-on: ${{ matrix.runner }}' 'unapproved runner:'
expect_rejected 'workflow comment exception' $'jobs:\n  check:\n    # hosted-exception: approved\n    runs-on: ubuntu-latest' 'unapproved hosted runner'
expect_rejected 'folded runner selector' $'jobs:\n  check:\n    runs-on: >-\n      smarty-linux-x64' 'block-scalar runner value is forbidden'
expect_rejected 'runner alias' $'env:\n  POOL: &pool smarty-linux-x64\njobs:\n  check:\n    runs-on: *pool' 'runs-on via YAML anchor/alias is not allowed'
expect_rejected 'malformed workflow' $'jobs: [' 'workflow YAML does not parse'

fixture="$(mktemp -d "$TMPDIR/owned.XXXXXX")"
cat > "$fixture/probe.yml" <<'YAML'
jobs:
  scalar:
    runs-on: smarty-linux-x64
  constraints:
    runs-on: [self-hosted, Linux, smarty-linux-x64]
  group:
    runs-on:
      group: Smarty Linux CI
      labels: [self-hosted, X64]
YAML
bash "$guard" "$fixture" "$TMPDIR/empty.txt"
echo 'PASS: literal owned pool, constraint conjunction, and owned group'

fixture="$(mktemp -d "$TMPDIR/scoped.XXXXXX")"
printf '%s\n' 'release.yml publish ubuntu-latest https://github.com/Smarty-Pants-Inc/smarty-dev/issues/1246#issuecomment-5941303212' > "$fixture/approved.txt"
printf '%s\n' $'jobs:\n  publish:\n    runs-on: ubuntu-latest\n  other:\n    runs-on: ubuntu-latest' > "$fixture/release.yml"
if output="$(bash "$guard" "$fixture" "$fixture/approved.txt" 2>&1)"; then
  echo 'FAIL: hosted exception crossed jobs' >&2
  exit 1
fi
[[ "$output" == *'unapproved hosted runner'* ]]
echo 'PASS: hosted exception cannot cross jobs'
echo 'All runner guard probes passed'
