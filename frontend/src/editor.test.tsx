import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { Editor } from "./editor"

describe("mounted editor visibility", () => {
  it("retains inactive textareas but hides and inerts their controls without duplicate help IDs", () => {
    const props = { value: "Initial", token: "fixture", available: true, enabled: true, onEnabled() {}, onChange() {}, onSave() {} }
    const html = renderToStaticMarkup(<><Editor {...props} name="a.md" active /><Editor {...props} name="b.md" active={false} /></>)
    expect(html.match(/<textarea/g)).toHaveLength(2)
    expect(html.match(/id="completion-help"/g)).toHaveLength(1)
    expect(html.match(/display:none/g)).toHaveLength(2)
    expect(html.match(/inert=""/g)).toHaveLength(2)
  })
})
