Spec completion marker convention for this build invocation:

Read the saved spec snapshot unchanged. Outside code blocks, a leading single hash
followed by a space ("# "), after optional indentation, marks that spec line as
completed, not pending. For example, "  # Add search" is already completed.
Preserve completed text as context. Do not implement completed requirements again
unless explicitly reopened by removing the completion marker. Completion applies
only to the marked line, not automatically to subsequent lines or an entire section.
A line containing only "#" after indentation may be a completed blank line; it
contains no task. A hash without the following space, such as "#tag", is not a
completion marker. Two or more leading hashes ("##", "###", etc.) remain Markdown
headings, not completion markers. Inline hashes ("Use C#" or "color #fff") do not
mark completion. Hashes in fenced code blocks (backtick or tilde fences), indented
code blocks, and inline code are code content, not completion markers. Distinguish
actual code blocks from ordinary indentation on spec lines.
Implement only pending requirements; retain completed requirements as context.
