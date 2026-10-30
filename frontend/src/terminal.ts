// Match whole terminal strings before splitting lines: OSC/DCS payloads may
// contain newlines. Keep this identical for visible log text and report evidence.
export const terminalControls = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)(?:[^\x07\x1b\x9c]|\x1b(?!\\))*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])(?:[^\x1b\x9c]|\x1b(?!\\))*(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*$|\x1b[ -/]*[@-~]?|[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function normalizeTerminal(value: string): string {
  return value.replace(terminalControls, "")
}
