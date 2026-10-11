# Changelog

## v1.1 - 2026-10-11

### Added

- **Open** button on every pane, next to Paste, that loads a text file from this computer. A pane still carrying its default name ("Version A", "Version B", "Base") takes the file's name, whether the file was opened or dropped; a name you typed is left alone.
- Dropping two files on a pane fills Version A and Version B at once, in the order they were dropped, as one undo step, and runs the compare.
- The stats line shows the number of changes (contiguous blocks) next to the added and removed line counts, and an **expand all** link opens every folded run of unchanged lines, in the main diff and both 3-way panels.
- Folder Compare: **Open in Text Compare** on a modified text file loads both versions into Text Compare, titled by folder and path, for copy arrows, 3-way merge, and export.
- Folder Compare: **Copy Summary** copies the file list as text, honoring the current filter and path search, with the counts at the top.
- `?` opens the About dialog, which lists every feature and shortcut.
- A saved tab's tooltip shows when it was last updated and whether it is a 3-way comparison.

### Fixed

- Saved comparisons now keep the Base pane. Before, saving a 3-way comparison stored only A and B, so loading it back lost the original; the tab's unsaved-changes dot and the discard confirmation also ignored edits to the Base pane. Comparisons saved by v1.0 load with the Base pane hidden and empty, as before.
- Loading a saved comparison without a Base pane now hides the Base pane instead of leaving the previous comparison's base in place.
- **Copy Diff** and **Download .patch** produce a real unified diff: single-character prefixes, `@@` hunk headers with three lines of context, and `\ No newline at end of file` where it applies. The v1.0 output used two-character prefixes and no hunk headers, so `patch` and `git apply` rejected it. Verified by applying the generated patches with `git apply` across several hundred random cases.
- The HTML report included folded context only as a dead "click to expand" bar, since the hidden rows never left the page. Folded runs are now written into the report inside a section that opens on click with no script.
- The HTML report's banner counts now follow the same rule as the on-page stats: lines matched by an ignore pattern are not counted as changes.
- The line-ending banner could never appear, because a text box normalizes every CRLF to LF on the way in. Delta now remembers the line endings of what was opened, dropped, pasted with the Paste button, or sent from Folder Compare, and the banner says when the two sides came in differently and that the comparison, patch, and merged result use LF. Swap and undo keep that record in step; Clear and loading a saved tab reset it.

## v1.0 - 2026-10-01

Initial release of Delta, a local-first diff and compare tool.

### Added

- Text Compare with line-level diffs and word- and character-level highlighting, in Split or Unified view
- Ignore case, ignore whitespace, only-show-changes, and pretty-print-JSON toggles
- Ignore-lines-matching regex patterns, saved as removable pills
- Base / 3-way compare with a 3-way merge and conflict resolution
- Copy-to-other-side arrows, change navigation, bookmarks, and per-pane find
- Live and Preview modes, a whitespace toggle, and optional syntax highlighting (Prism.js, vendored)
- Folder Compare by SHA-256 content hash, with text diffs and image pixel-difference overlays
- Saved comparisons as tabs, autosave, and undo/redo
- Copy Diff, .patch download, standalone HTML report, share links, and JSON export/import
- System, light, dark, and Vegas neon themes on the Theme button, following the system setting by default
- MIT license
