# Changelog

## v1.3 - 2026-11-14

### Fixed

- Delta fits phone screens. On a 320 to 390px screen the page was about 584px wide, so phones zoomed it out: the tagline never wrapped, and the Compare and View option groups were single rows that could not wrap. They wrap now, and from 320px up the page is never wider than the screen. Desktop layout is unchanged.
- Where the side-by-side diff stacks (800px and narrower), each half now spans the full width. Before, every stacked line was squeezed into half the screen.
- Markdown link and image addresses come out exactly as written. Underscores and asterisks inside an address were read as emphasis, so `https://example.com/a_b_c` became a broken link. Addresses may also hold balanced parentheses, as in `https://en.wikipedia.org/wiki/Diff_(Unix)`, and links and emphasis inside a code span stay plain text. The v1.2 rules are unchanged: a link keeps only an http, https, mailto, or relative address, every address is escaped, and an image shows only from a `data:` URL.

### Changed

- On touch screens, the saved-tab icons, the find arrows, the ignore-pattern field, and **expand all** are large enough to tap (the icon buttons 32px), and text fields use at least 16px text, which also keeps phones from zooming in when you start typing. On phones the editors start 300px tall instead of 460px, and can still be dragged taller. With a mouse, nothing changes.
- A shorter page title for search results, and the structured data's description now matches the page description.

### Added

- `tests/`: browser tests with no dependencies, run with `node tests/run.mjs` (Node 22 or later and Chrome or Edge). They cover the v1.2 security guarantees in three settings (served without a security policy as on GitHub Pages, served with the radmagelabs.com headers, and the release zip opened from disk), with v1.1 as a known-vulnerable control; Markdown rendering; layout from 320px to desktop; and everyday use. Neither the release zip nor the GitHub Pages copy includes them.

## v1.2 - 2026-11-13

### Security

- Markdown preview could run script from the text being previewed. Quotes in link and image addresses were not escaped, so an address could add an event handler to the element, and links kept any scheme, including `javascript:`. Addresses are now fully escaped, and a link keeps only an http, https, mailto, or relative address; any other scheme leaves just its text.
- Previews no longer load anything from the network. Pasted HTML could pull images, stylesheets, fonts, or media from other sites, and Markdown images loaded from their addresses, telling those sites the preview was opened. The HTML preview now carries its own Content-Security-Policy that allows only inline styles and `data:` URLs, and a Markdown image shows as `[image: alt text]` unless it is a `data:` URL.

### Added

- Delta also runs at [radmagelabs.com/delta/](https://radmagelabs.com/delta/). A workflow publishes the `delta/` folder to GitHub Pages on each push to `main` that changes it, and radmagelabs.com serves that copy with a Content-Security-Policy that blocks requests to other sites.
- A page description, a canonical address, link-preview tags, and structured data for search, plus a RadMage Labs link in the tagline.

### Changed

- The script that applies a saved theme before first paint is now its own file, `theme.js`, instead of an inline script, so it still runs under that security policy.

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
