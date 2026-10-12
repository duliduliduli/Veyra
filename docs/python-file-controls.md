# Draft-only Python file controls

Studio can add blank Python files, rename nested relative paths, select an existing entrypoint, and explicitly remove a non-entrypoint file from the next draft. The last file and current entrypoint cannot be removed. Renaming an entry file updates the entrypoint; Python imports are not refactored. Every operation stays in the device draft until Save version.

The complete file map and entrypoint are used by dirty checks, save, backup, download, quotes and assistant proposals. Entrypoint-only changes create new versions. Quotes and duplication require a clean, explicitly saved snapshot. A newer edit during a pending save remains an unsaved draft, and stale quotes cannot reappear when inputs change and are later reverted. Assistant apply/undo uses the exact source and draft revision, including CRLF text.

Draft schema 2 stores full files, entrypoint and base version identity. It recovers file additions, removals and renames without merging removed files back in. Legacy patches still recover when compatible. Every editor opening gets its own key; rejected, invalid and stale payloads are retained for private recovery download. A newer clean marker prevents a deliberately reverted recovered draft from reappearing. Ordering uses increasing stored timestamps rather than browser key enumeration. Retained payloads can accumulate toward browser storage quota; failed storage writes are visibly reported.

Source validation enforces existing aggregate 256 KiB / 50-file limits and valid UTF-8 without altering source. New file paths are safe relative .py paths up to 256 ASCII characters; older accepted long paths remain inspectable. Source exceeding limits is kept as recovery-only raw draft data and is explicitly marked as unable to restore automatically. No code is executed.

Both local and cloud Duplicate accept an optional strict positive expected_version_no up to 2147483647. Studio sends the displayed saved number, so a stale tab cannot silently duplicate a newer strategy revision. A mismatch returns 409 before source access or copy creation. No-body and omitted-field API callers retain existing latest-source behavior. The selected source is immutable: a save that commits after the selected version is read cannot change the copied file map. No new database migration or permission is needed.

Verification uses synthetic fixtures, strict schema tests and jsdom interrupted/repeated flows. Real browser layout/focus and authenticated database integration remain separate release gates.
