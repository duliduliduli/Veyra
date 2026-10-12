# Offline helper proposal review

The Studio helper remains built-in and offline. No AI provider is connected. This
change only reviews an already-issued proposal; it does not execute or validate
Python, save a version, or make a service request.

## Review contract

- Compact line-by-line additions/removals include before-proposal and proposed
  line numbers, three nearby unchanged lines, and explicit unchanged-line gaps.
- The base is labeled **Before proposal**, because editing the draft does not
  refresh an existing proposal. Apply still checks project, file, draft revision,
  and exact base source. Existing protected Undo remains unchanged.
- The complete before/proposed source remains available in an expandable section.
  Large/dense diffs open that section automatically. Nothing is truncated.
- Source is inserted as text, never HTML. The display can reveal spaces, tabs and
  other Unicode whitespace. Each diff line labels LF, CRLF, CR, or no final
  newline. Full-source metadata includes ending totals and final-newline state;
  raw line breaks can look alike in that view.
- Whitespace-only is a description, not a safety claim. The review explicitly warns
  that whitespace/indentation can change Python behavior.
- Only presentation uses whitespace markers. Apply and Undo retain the original
  proposal strings, including CRLF/lone CR, Unicode and final-newline state.
- Scroll regions and full source are keyboard-focusable and labeled. Added/removed
  states have text/signs and border styles as well as background colors. Review
  height is bounded; editor and conversation dimensions are unchanged.

## Bounds

`proposal-diff.js` has no DOM, storage, network or execution dependencies. It splits
exact line tokens, trims equal prefix/suffix, interns remaining tokens, and uses a
bounded LCS table. The current helper limit is 100,000 JavaScript string characters
(UTF-16 code units) per source. The table has at most 250,000 uint32 cells (1 MB),
with at most 400 changed lines and 600 displayed contextual rows. Input scans and
line storage are linear in source size; token comparisons in the table are integers.

If comparison or display limits are reached, the full-source fallback states why.
When no complete comparison ran, counts are explicitly labeled **Replacement
block**, covering the differing block after equal prefix/suffix removal rather
than claiming a minimal diff. A completed comparison retains exact added/removed
counts even if the compact display is too dense.

## Offline verification

Use an existing jsdom installation; no additional dependency was added. New suites:

- `tests/e2e/proposal-diff.mjs`: 10 tests for exact tokenization/reconstruction,
  whitespace/endings/final newline, Unicode, contextual elisions, empty/repeated
  lines, bounded large/dense inputs, 1,000 generated fixtures and pure browser export.
- `tests/e2e/proposal-diff-ui.mjs`: 6 synthetic DOM tests for inert text rendering,
  complete source, counts/labels, unchanged source before Apply, exact Apply/Undo,
  repeated Apply, stale revision/base/Undo checks, Dismiss, replacement requests,
  file switches, truthful fallback and absence of helper network writes.

Focused command (66 passed):

```sh
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test \
  tests/e2e/proposal-diff.mjs tests/e2e/proposal-diff-ui.mjs \
  tests/e2e/studio-assistant.mjs tests/e2e/studio.mjs tests/e2e/workspace-store.mjs
```

Regression command (306 passed) explicitly excludes the existing Python serialization case:

```sh
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test \
  --test-skip-pattern='real Python canonical serialization' \
  tests/e2e/approval-recovery-ui.mjs tests/e2e/backtest-approval-ui.mjs \
  tests/e2e/chart-ui.mjs tests/e2e/public-private-copy-ui.mjs \
  tests/e2e/publications.mjs tests/e2e/run-lifecycle-ui.mjs \
  tests/e2e/strategy-backup-ui.mjs tests/e2e/strategy-library-ui.mjs \
  tests/e2e/strategy-settings-lifecycle-ui.mjs tests/e2e/strategy-storage-ui.mjs \
  tests/e2e/version-history-ui.mjs
```

Existing fixture changes only load `proposal-diff.js`; `publications.mjs` also
replaces fixed script indices with helper scripts followed by the final app script.
No CI, backend, provider, API, credentials, billing, execution or deployment code
was changed. Browser layout, actual screen-reader output and native keyboard
scrolling were not tested. Real-browser/server/publication checks remain blocked
or outside this slice; synthetic DOM tests do not establish those outcomes.
