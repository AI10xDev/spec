#!/usr/bin/env bats

setup() {
  REPO_ROOT=$(cd -- "$BATS_TEST_DIRNAME/.." && pwd -P)
  TEST_ROOT=$(mktemp -d)
  CAPTURE="$TEST_ROOT/capture"
  PROJECT="$TEST_ROOT/target project"
  HOME="$TEST_ROOT/home"
  mkdir -p "$CAPTURE" "$PROJECT" "$HOME/specing/nested"
  cp "$REPO_ROOT/tests/helpers/fake-opencode" "$TEST_ROOT/opencode"
  chmod +x "$TEST_ROOT/opencode"
  export REPO_ROOT TEST_ROOT CAPTURE PROJECT HOME
  export FAKE_CAPTURE_DIR="$CAPTURE"
  export SPECIFIC_OPENCODE_BIN="$TEST_ROOT/opencode"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "plan uses default directory and deterministic recursive ordering" {
  printf 'z prompt' > "$HOME/specing/z.md"
  printf 'a prompt' > "$HOME/specing/nested/a file.md"
  run bash -c 'cd -- "$1" && printf "1\n" | "$2"' bash "$PROJECT" "$REPO_ROOT/bin/specific-run-plan"
  [ "$status" -eq 0 ]
  [[ "$output" == *"1) nested/a file.md"* ]]
  [[ "$output" == *"2) z.md"* ]]
  [ "$(<"$CAPTURE/arg-2")" = "$PROJECT" ]
  [ "$(<"$CAPTURE/arg-4")" = plan ]
  [ "$(<"$CAPTURE/arg-5")" = "a prompt" ]
}

@test "plan accepts an explicit directory with spaces" {
  local specs="$TEST_ROOT/other specs"
  mkdir -p "$specs"
  printf 'selected prompt' > "$specs/my spec.md"
  run bash -c 'cd -- "$1" && printf "1\n" | "$2" "$3"' bash \
    "$PROJECT" "$REPO_ROOT/bin/specific-run-plan" "$specs"
  [ "$status" -eq 0 ]
  [ "$(<"$CAPTURE/arg-5")" = "selected prompt" ]
}

@test "invalid selections do not launch OpenCode" {
  printf 'prompt' > "$HOME/specing/spec.md"
  run bash -c 'printf "no\n" | "$1"' bash "$REPO_ROOT/bin/specific-run-plan"
  [ "$status" -ne 0 ]
  [ ! -e "$CAPTURE/count" ]

  run bash -c 'printf "2\n" | "$1"' bash "$REPO_ROOT/bin/specific-run-plan"
  [ "$status" -ne 0 ]
  [ ! -e "$CAPTURE/count" ]
}

@test "empty and missing directories fail before OpenCode starts" {
  local empty="$TEST_ROOT/empty"
  mkdir "$empty"
  run "$REPO_ROOT/bin/specific-run-plan" "$empty"
  [ "$status" -ne 0 ]
  [[ "$output" == *"No specs found"* ]]
  [ ! -e "$CAPTURE/count" ]

  run "$REPO_ROOT/bin/specific-run-plan" "$TEST_ROOT/missing"
  [ "$status" -ne 0 ]
  [ ! -e "$CAPTURE/count" ]
}

@test "plan rejects too many arguments" {
  run "$REPO_ROOT/bin/specific-run-plan" one two
  [ "$status" -ne 0 ]
  [[ "$output" == *"Usage: specific-run-plan"* ]]
}

@test "plan honors SPECIFIC_PLAN_DIR and excludes symlinks" {
  local specs="$TEST_ROOT/configured specs"
  mkdir -p "$specs"
  printf 'real prompt' > "$specs/real.md"
  printf 'outside prompt' > "$TEST_ROOT/outside.md"
  ln -s "$TEST_ROOT/outside.md" "$specs/linked.md"
  export SPECIFIC_PLAN_DIR="$specs"

  run bash -c 'printf "1\n" | "$1"' bash "$REPO_ROOT/bin/specific-run-plan"
  [ "$status" -eq 0 ]
  [[ "$output" == *"1) real.md"* ]]
  [[ "$output" != *"linked.md"* ]]
  [ "$(<"$CAPTURE/arg-5")" = "real prompt" ]
}
