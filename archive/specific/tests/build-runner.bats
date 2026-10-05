#!/usr/bin/env bats

setup() {
  REPO_ROOT=$(cd -- "$BATS_TEST_DIRNAME/.." && pwd -P)
  TEST_ROOT=$(mktemp -d)
  CAPTURE="$TEST_ROOT/capture"
  PROJECT="$TEST_ROOT/project with spaces"
  mkdir -p "$CAPTURE" "$PROJECT"
  cp "$REPO_ROOT/tests/helpers/fake-opencode" "$TEST_ROOT/opencode"
  chmod +x "$TEST_ROOT/opencode"
  export FAKE_CAPTURE_DIR="$CAPTURE"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "build passes caller directory, agent, and complete prompt" {
  printf 'line one\nline two\n\n' > "$PROJECT/spec file.md"
  run bash -c 'cd -- "$1" && SPECIFIC_OPENCODE_BIN="$2" "$3" "$4"' bash \
    "$PROJECT" "$TEST_ROOT/opencode" "$REPO_ROOT/bin/specific-run-build" "spec file.md"
  [ "$status" -eq 0 ]
  [ "$(<"$CAPTURE/arg-0")" = run ]
  [ "$(<"$CAPTURE/arg-1")" = --dir ]
  [ "$(<"$CAPTURE/arg-2")" = "$PROJECT" ]
  [ "$(<"$CAPTURE/arg-3")" = --agent ]
  [ "$(<"$CAPTURE/arg-4")" = build ]
  cmp "$PROJECT/spec file.md" "$CAPTURE/arg-5"
  [ "$(<"$CAPTURE/pwd")" = "$PROJECT" ]
}

@test "explicit OpenCode command name is discovered on PATH" {
  printf 'build this' > "$PROJECT/spec.md"
  run env PATH="$TEST_ROOT:$PATH" SPECIFIC_OPENCODE_BIN=opencode \
    FAKE_CAPTURE_DIR="$CAPTURE" "$REPO_ROOT/bin/specific-run-build" "$PROJECT/spec.md"
  [ "$status" -eq 0 ]
  [ "$(<"$CAPTURE/arg-4")" = build ]
}

@test "invalid arguments and paths fail before OpenCode starts" {
  run env SPECIFIC_OPENCODE_BIN="$TEST_ROOT/opencode" "$REPO_ROOT/bin/specific-run-build"
  [ "$status" -ne 0 ]
  [ ! -e "$CAPTURE/count" ]

  run env SPECIFIC_OPENCODE_BIN="$TEST_ROOT/opencode" "$REPO_ROOT/bin/specific-run-build" one two
  [ "$status" -ne 0 ]
  [ ! -e "$CAPTURE/count" ]

  run env SPECIFIC_OPENCODE_BIN="$TEST_ROOT/opencode" "$REPO_ROOT/bin/specific-run-build" "$PROJECT"
  [ "$status" -ne 0 ]
  [ ! -e "$CAPTURE/count" ]

  run env SPECIFIC_OPENCODE_BIN="$TEST_ROOT/opencode" "$REPO_ROOT/bin/specific-run-build" "$PROJECT/missing.md"
  [ "$status" -ne 0 ]
  [ ! -e "$CAPTURE/count" ]
}

@test "missing OpenCode fails clearly" {
  printf 'build this' > "$PROJECT/spec.md"
  run env PATH=/usr/bin:/bin SPECIFIC_OPENCODE_BIN="$TEST_ROOT/missing" \
    "$REPO_ROOT/bin/specific-run-build" "$PROJECT/spec.md"
  [ "$status" -ne 0 ]
  [[ "$output" == *"OpenCode executable is not available"* ]]
}

@test "NUL-containing specs fail before OpenCode starts" {
  printf 'before\0after' > "$PROJECT/binary.md"
  run env SPECIFIC_OPENCODE_BIN="$TEST_ROOT/opencode" \
    "$REPO_ROOT/bin/specific-run-build" "$PROJECT/binary.md"
  [ "$status" -ne 0 ]
  [[ "$output" == *"contains a NUL byte"* ]]
  [ ! -e "$CAPTURE/count" ]
}
