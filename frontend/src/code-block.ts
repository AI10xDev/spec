// Stateful, source-order classification shared by highlighting, markers and reports.
// Indented code cannot interrupt a paragraph, but can follow a completed block.
export function codeBlockClassifier() {
  let fence = ""
  let indented = false
  let boundary = true
  let paragraph = false
  return (text: string): boolean => {
    const blank = !text.trim()
    const codeIndent = /^(?: {4}| {0,3}\t)/.test(text)
    const inIndentedCode = !fence && ((codeIndent && (boundary || indented)) || (blank && indented))
    indented = inIndentedCode
    if (inIndentedCode) { paragraph = false; boundary = blank; return true }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(text)
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^[ \t\r]*$/.test(delimiter[2])) fence = ""
      boundary = !fence
      paragraph = false
      return true
    }
    if (delimiter && (delimiter[1][0] !== "`" || !delimiter[2].includes("`"))) {
      fence = delimiter[1]
      boundary = false
      paragraph = false
      return true
    }
    const heading = /^ {0,3}#{1,6}(?:[ \t]|\r?$)/.test(text)
    const thematic = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/.test(text)
    const setext = paragraph && /^ {0,3}(?:=+|-+)[ \t]*\r?$/.test(text)
    boundary = blank || heading || thematic || setext
    paragraph = !boundary && !/^ {0,3}(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/.test(text)
    return false
  }
}
