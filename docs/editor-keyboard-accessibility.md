# Studio keyboard editing

Status: local source candidate, 2026-10-12. No publication or deployment is part of this change.

## Interaction

The symbol row is a labeled group of native buttons with explicit insertion names.
Its existing text, dimensions, font, and colors are retained. The Tab button's
accessible name includes its visible label and explains that it inserts four spaces.
The controls start disabled and remain disabled while a project is loading or unavailable.

Each button inserts through its native `click` handler. A primary `pointerdown`
only prevents focus from leaving the textarea; it does not edit the source.
Secondary mouse buttons and explicitly nonprimary touch/pen pointers are ignored.
Keyboard Enter/Space and assistive activation therefore use the same insertion
path as a completed pointer click. Cancelled presses do not insert. A pending
pointer click is rejected after a source-file render, newer source revision,
project replacement, or route change. Each new click consumes its pending pointer
context, and keyboard activation does not reuse a stale pointer context.

Insertion captures the textarea selection before restoring editor focus, replaces
that range, and places the caret after the inserted text. It uses the existing
`input` / `editedSource` / draft path, including exact untouched CRLF/CR/LF bytes,
no-op detection, quote invalidation, and dirty-state tracking. Missing projects or
files, hidden or stale project routes, and disabled/read-only editors cannot insert.
Nothing saves a version or runs code as a side effect of insertion.

The visible help paragraph is linked to the textarea with `aria-describedby`:

- Unmodified Tab inserts four spaces at the selection.
- Press Escape, then Tab to let the browser move focus forward normally.
- Shift+Tab keeps normal backward focus traversal.
- The Escape sequence is one-use. Another key, a pointer selection, input,
  composition start, blur/return, file render, or navigation resets it.
- Modified Tab/Escape and IME composition keys are not intercepted.
- Existing explicit Ctrl/Cmd+S save behavior is unchanged.

Focus traversal is left to the browser; there is no hard-coded next target,
roving-tabindex toolbar, timer, or persistent keyboard mode.

## Verification

Only explicitly named offline jsdom suites were run:

```sh
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/editor-accessibility-ui.mjs tests/e2e/studio.mjs tests/e2e/proposal-diff-ui.mjs tests/e2e/strategy-backup-ui.mjs tests/e2e/strategy-storage-ui.mjs tests/e2e/backtest-approval-ui.mjs
```

169 tests passed, including 23 focused keyboard/pointer cases. Fixtures use inert
source strings, synthetic API responses, and ephemeral in-memory storage. They
check all symbol buttons, explicit Enter/Space click paths, pointerdown/up/click
ordering, cancellation, selection replacement, exact mixed line endings and
Unicode, no-op/empty sources, draft tracking, escape/reset behavior, modifiers,
composition, missing/disabled contexts, interrupted file/project visits, and
explicit local Ctrl/Cmd+S saves. The other five suites cover existing editing,
proposal, backup, storage, and quote/approval regressions.

The focused native-click, no-pointerdown-mutation, and Escape/Tab checks also fail
against the frozen pre-change source and pass with this change.

jsdom does not generate native keyboard clicks or perform default Tab navigation;
focused fixtures dispatch the resulting click explicitly and assert that the exit
Tab is not cancelled. These checks do not establish real browser keyboard/touch
behavior, layout, or screen-reader announcements. Native browser QA remains unrun
under the existing restriction. No browser launch, Python/strategy execution,
network request, installation, database access, or remote publication was performed.
