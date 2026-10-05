import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("run-spec", () => {
  test("runs the build agent in the directory where the launcher was invoked", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "run-goal-"))
    temporary.push(directory)

    const bin = path.join(directory, "bin")
    const project = path.join(directory, "project with spaces")
    const specName = "goal spec.md"
    const spec = path.join(project, specName)
    const capture = path.join(directory, "capture")
    mkdirSync(bin)
    mkdirSync(project)
    writeFileSync(spec, "Build the requested service.\n")
    writeFileSync(path.join(bin, "opencode-source"), '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$@" > "$CAPTURE"\n')
    chmodSync(path.join(bin, "opencode-source"), 0o755)

    const result = Bun.spawnSync(["bash", path.join(root, "script/run-spec.sh"), specName], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture },
    })

    expect(result.exitCode).toBe(0)
    expect(readFileSync(capture, "utf8").split("\n")).toEqual([
      root,
      "run",
      "--thinking",
      "--dir",
      project,
      "--agent",
      "build",
      "Build the requested service.",
      "",
    ])
  })

  test.each([
    { args: [], error: "Usage:" },
    { args: ["one", "two"], error: "Usage:" },
    { args: ["missing.md"], error: "Spec file does not exist: missing.md" },
  ])("rejects invalid input without launching the agent", ({ args, error }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "run-goal-invalid-"))
    temporary.push(directory)

    const result = Bun.spawnSync(["bash", path.join(root, "script/run-spec.sh"), ...args], {
      cwd: directory,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(error)
  })
})
