    (() => {
      'use strict';

      /* ── Diff engine ──────────────────────────────────────────────
         Myers' O(ND) shortest-edit-script algorithm (the same one git and
         GNU diff use internally) -- word/char-level diff for highlighting
         within changed line pairs reuses this too. Cost scales with N (the
         combined size) times D (the actual number of differences), not
         with the product of the two lengths, so two large-but-mostly-
         identical documents diff almost instantly regardless of size --
         the old size-based product was a proxy for "this will be slow,"
         but D (found only by actually working through the diagonals) is
         what really determines cost, so that's what bounds it here: a
         wall-clock time budget, checked once per diagonal-front expansion,
         bails out to the cheap common-prefix/suffix fallback if a diff
         turns out to be big AND genuinely dissimilar (no algorithm does
         well there -- two totally unrelated documents are close to a
         worst case for any diff, not just this one). Time-based (not an
         operation-count guess) so it adapts to whatever hardware it runs
         on instead of being tuned for one machine.
         Verified against 600+ randomized/edge cases (reconstructs both
         inputs exactly, matches the old DP algorithm's optimal edit count)
         plus benchmarked across realistic (large + mostly similar) and
         pathological (large + totally dissimilar) scenarios before this
         replaced the previous plain O(n*m) DP implementation. */
      const MYERS_TIME_BUDGET_MS = 800;
      let lastDiffUsedFallback = false;
      function diffLines(a, b) {
        const n = a.length, m = b.length;
        if (n === 0 && m === 0) { lastDiffUsedFallback = false; return []; }
        const max = n + m;
        const offset = max;
        const v = new Int32Array(2 * max + 1);
        v[1 + offset] = 0;
        // trace[d] holds only the window of diagonals actually in play at
        // step d (length 2d+1, indexed by k+d) -- not the full v array.
        // Storing the full array every step would make the bookkeeping
        // itself scale with N per step (cost ~ D*N) even when D is tiny,
        // which defeats the entire point of using this algorithm on large,
        // mostly-similar documents.
        const trace = [];
        let foundD = -1;
        const startTime = performance.now();
        outer:
        for (let d = 0; d <= max; d++) {
          if (performance.now() - startTime > MYERS_TIME_BUDGET_MS) {
            lastDiffUsedFallback = true;
            return diffLinesFallback(a, b);
          }
          trace.push(v.slice(-d + offset, d + offset + 1));
          for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
              x = v[k + 1 + offset];
            } else {
              x = v[k - 1 + offset] + 1;
            }
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[k + offset] = x;
            if (x >= n && y >= m) { foundD = d; break outer; }
          }
        }
        const ops = [];
        let x = n, y = m;
        for (let d = foundD; d > 0; d--) {
          const win = trace[d];
          const k = x - y;
          let prevK;
          if (k === -d || (k !== d && win[k - 1 + d] < win[k + 1 + d])) {
            prevK = k + 1;
          } else {
            prevK = k - 1;
          }
          const prevX = win[prevK + d];
          const prevY = prevX - prevK;
          while (x > prevX && y > prevY) {
            ops.push({ type: 'equal', a: a[x - 1], b: b[y - 1] });
            x--; y--;
          }
          if (prevK === k + 1) ops.push({ type: 'add', b: b[prevY] });
          else ops.push({ type: 'del', a: a[prevX] });
          x = prevX; y = prevY;
        }
        while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
          ops.push({ type: 'equal', a: a[x - 1], b: b[y - 1] });
          x--; y--;
        }
        ops.reverse();
        lastDiffUsedFallback = false;
        return ops;
      }
      function diffLinesFallback(a, b) {
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        let endA = a.length, endB = b.length;
        while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
        const ops = [];
        for (let i = 0; i < start; i++) ops.push({ type: 'equal', a: a[i], b: b[i] });
        for (let i = start; i < endA; i++) ops.push({ type: 'del', a: a[i] });
        for (let j = start; j < endB; j++) ops.push({ type: 'add', b: b[j] });
        for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ type: 'equal', a: a[i], b: b[j] });
        return ops;
      }
      function diffWords(a, b) {
        const ta = a.split(/(\s+)/).filter(t => t !== '');
        const tb = b.split(/(\s+)/).filter(t => t !== '');
        return diffLines(ta, tb).map(op => ({ type: op.type, text: op.type === 'del' ? op.a : op.b }));
      }
      function diffChars(a, b) {
        const ta = a.split(''), tb = b.split('');
        return diffLines(ta, tb).map(op => ({ type: op.type, text: op.type === 'del' ? op.a : op.b }));
      }
      function tokenCount(s) { return s.split(/\s+/).filter(Boolean).length; }
      const CHAR_DIFF_MAX_LEN = 500;
      // Word-diff reads poorly on sparse/minified lines (JSON, CSV, code)
      // where "words" can be nearly the whole line -- fall back to
      // char-level diffing for those so a one-character edit doesn't
      // highlight as if the entire line changed. Capped by length so a
      // single very long minified line can't blow up the O(n*m) table.
      function chooseLineDiff(a, b) {
        const longest = Math.max(a.length, b.length);
        const sparse = Math.max(tokenCount(a), tokenCount(b)) < 4 && longest > 12;
        if (sparse && longest <= CHAR_DIFF_MAX_LEN) return { ops: diffChars(a, b), mode: 'char' };
        return { ops: diffWords(a, b), mode: 'word' };
      }
      function detectLineEndings(text) {
        const hasCRLF = /\r\n/.test(text);
        const bare = text.replace(/\r\n/g, '');
        const hasLF = /\n/.test(bare), hasCR = /\r/.test(bare);
        const kinds = [hasCRLF && 'CRLF', hasLF && 'LF', hasCR && 'CR'].filter(Boolean);
        if (kinds.length === 0) return 'none';
        if (kinds.length > 1) return 'mixed';
        return kinds[0];
      }
      // Makes an otherwise-invisible whitespace-only change (trailing
      // spaces, tabs) visible when it falls inside a highlighted del/ins span.
      function visualizeWhitespace(s) { return s.replace(/\t/g, '→   ').replace(/ /g, '·'); }
      /* ── Syntax highlighting (optional, off by default) ─────────────
         Uses Prism.js (https://prismjs.com, MIT License) purely as a
         per-line tokenizer -- vendored locally in vendor/prism/ (never a
         CDN) so nothing about "everything stays in the browser" changes,
         and Delta supplies its own token colors in style.css (the
         .tok-* rules) rather than a Prism theme, so highlighted code
         matches the app's own light/dark palette instead of a bolted-on
         foreign one. See vendor/prism/LICENSE for the full license text.

         This is the one deliberate exception to Delta's "zero
         dependencies" design. Hand-rolling correct tokenizers --
         string-escape handling, nested/multi-line comments, regex
         literals, template-literal interpolation, one grammar per
         language -- is a large, easy-to-get-subtly-wrong undertaking on
         its own, comparable in size to the diff engine above; Prism's
         core has no runtime dependencies of its own and is tiny, so this
         seemed like the one place actually worth making an exception for
         rather than either replicating it or skipping the feature. */
      // (the <select> itself is wired up further down, once $() exists)
      let syntaxLang = '';
      // Tokenizes ONE LINE at a time (matching how the diff itself works),
      // not the whole file -- so this has no memory of what came before a
      // given line. A single-line comment/string tokenizes correctly on
      // its own; a multi-line construct (a /* block comment */, a
      // template literal, a triple-quoted string, ...) won't be, since
      // Prism has no cross-line state when called this way and each line
      // gets tokenized as if it started fresh. That's an inherent
      // tradeoff of highlighting a line-oriented diff rather than a
      // whole file, not a bug to chase -- hence the "heuristic tokenizer"
      // wording on the dropdown's tooltip.
      //
      // Flattens Prism's nested token tree (strings, and Token objects
      // whose .content is itself a string, an array, or more Tokens) into
      // a flat list of {start,end,cls} covering [0,text.length) with no
      // gaps -- cls is null for a run Prism left unclassified (plain
      // punctuation/whitespace between recognized tokens, or the whole
      // line when no language is selected). A leaf's own (innermost)
      // type wins over whatever token contains it.
      function tokenizeLineRanges(text, lang) {
        if (!lang || typeof Prism === 'undefined' || !Prism.languages[lang]) {
          return [{ start: 0, end: text.length, cls: null }];
        }
        const ranges = [];
        let pos = 0;
        function walk(node, cls) {
          if (typeof node === 'string') {
            if (node.length) ranges.push({ start: pos, end: pos + node.length, cls });
            pos += node.length;
          } else if (Array.isArray(node)) {
            node.forEach(n => walk(n, cls));
          } else {
            walk(node.content, node.type);
          }
        }
        let tokens;
        try { tokens = Prism.tokenize(text, Prism.languages[lang]); }
        catch (e) { return [{ start: 0, end: text.length, cls: null }]; }
        tokens.forEach(t => walk(t, null));
        return ranges;
      }
      // Two range lists that both fully partition the SAME string by
      // character offset (e.g. diff-changed ranges and syntax-token
      // ranges) don't nest cleanly -- a changed word can straddle a
      // string boundary, a single token can be half-changed -- so they
      // can't just be wrapped one inside the other. This computes their
      // common refinement: every boundary point from either list, in
      // order, with each resulting minimal span carrying whichever
      // element of A and of B it falls inside. Requires both lists to
      // cover the identical total length with no gaps (true for both
      // producers here).
      function mergeRanges(rangesA, rangesB) {
        const merged = [];
        let ia = 0, ib = 0, pos = 0;
        while (ia < rangesA.length && ib < rangesB.length) {
          const end = Math.min(rangesA[ia].end, rangesB[ib].end);
          if (end > pos) merged.push({ start: pos, end, a: rangesA[ia], b: rangesB[ib] });
          pos = end;
          if (rangesA[ia].end === end) ia++;
          if (rangesB[ib].end === end) ib++;
        }
        return merged;
      }
      // Whole-line rendering used everywhere a raw line's full text becomes
      // HTML (equal rows, unpaired del/add rows) -- when the Whitespace
      // toggle is on, every space/tab in the line is made visible, not
      // just whitespace-only changes inside a highlighted span (that
      // narrower case is handled separately in changedLinePairHtml,
      // which needs per-token control). esc() never touches space/tab
      // and visualizeWhitespace() never touches &<>"', so composing them
      // in either order is safe; this always escapes first since text
      // here isn't guaranteed pure whitespace.
      function renderLineText(text) {
        const ranges = tokenizeLineRanges(text, syntaxLang);
        return ranges.map(r => {
          const segText = text.slice(r.start, r.end);
          const inner = opts.showWhitespace ? visualizeWhitespace(esc(segText)) : esc(segText);
          return r.cls ? `<span class="tok-${r.cls}">${inner}</span>` : inner;
        }).join('');
      }
      // Splits a long equal-line run into head/tail context plus a folded
      // middle count. context=0 (the "only changes" view) folds the whole run.
      function planEqualRun(items, context) {
        const n = items.length;
        if (context === 0) return { head: [], foldedCount: n, tail: [] };
        if (n <= context * 2 + 4) return { head: items, foldedCount: 0, tail: [] };
        return { head: items.slice(0, context), foldedCount: n - context * 2, tail: items.slice(n - context) };
      }
      function tryParseJson(text) { try { return JSON.parse(text); } catch (e) { return undefined; } }
      function prettyJsonIfPossible(text) { const parsed = tryParseJson(text); return parsed === undefined ? null : JSON.stringify(parsed, null, 2); }
      async function encodeShareData(payload) {
        const json = JSON.stringify(payload);
        if (typeof CompressionStream === 'function') {
          const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
          const buf = new Uint8Array(await new Response(stream).arrayBuffer());
          let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          return 'z:' + btoa(bin);
        }
        return 'j:' + btoa(unescape(encodeURIComponent(json)));
      }
      async function decodeShareData(encoded) {
        const kind = encoded.slice(0, 2), b64 = encoded.slice(2);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (kind === 'z:') {
          const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
          return JSON.parse(await new Response(stream).text());
        }
        if (kind === 'j:') return JSON.parse(decodeURIComponent(escape(bin)));
        throw new Error('unknown encoding');
      }
      function groupOps(ops) {
        const groups = [];
        let i = 0;
        while (i < ops.length) {
          if (ops[i].type === 'equal') {
            const run = [];
            while (i < ops.length && ops[i].type === 'equal') { run.push(ops[i]); i++; }
            groups.push({ type: 'equal', items: run });
          } else {
            const dels = [], adds = [];
            while (i < ops.length && ops[i].type === 'del') { dels.push(ops[i]); i++; }
            while (i < ops.length && ops[i].type === 'add') { adds.push(ops[i]); i++; }
            groups.push({ type: 'change', dels, adds });
          }
        }
        return groups;
      }
      // Runs AFTER the normal (ignore-pattern-unaware) line diff, marking
      // lines that match the ignore pattern -- the diff's row structure,
      // pairing and line numbering are left completely alone (an earlier
      // version pulled matching lines into their own rows to dodge a
      // mispairing bug, but that restructured the whole view and made it
      // hard to follow); this only flags which side(s) of an existing row
      // should render muted/italic instead of colored, so counts stay
      // accurate without changing what the diff looks like.
      function applyIgnorePattern(ops, ignoreRegexes) {
        if (!ignoreRegexes || !ignoreRegexes.length) return ops;
        return ops.map(op => {
          if (op.type === 'equal' && (testIgnoreAny(ignoreRegexes, op.a) || testIgnoreAny(ignoreRegexes, op.b))) return { ...op, ignored: true };
          if (op.type === 'del' && testIgnoreAny(ignoreRegexes, op.a)) return { ...op, ignored: true };
          if (op.type === 'add' && testIgnoreAny(ignoreRegexes, op.b)) return { ...op, ignored: true };
          return op;
        });
      }
      function testIgnore(regex, line) { try { return regex.test(line); } catch (e) { return false; } }
      function testIgnoreAny(regexes, line) { return regexes.some(re => testIgnore(re, line)); }
      function buildUnifiedText(ops, labelA, labelB) {
        const lines = [`--- ${labelA}`, `+++ ${labelB}`];
        ops.forEach(op => {
          if (op.type === 'equal') lines.push('  ' + op.a);
          else if (op.type === 'del') lines.push('- ' + op.a);
          else lines.push('+ ' + op.b);
        });
        return lines.join('\n');
      }
      function diffLinesDisplay(rawA, rawB, normA, normB) {
        const ops = diffLines(normA, normB);
        let ia = 0, ib = 0;
        return ops.map(op => {
          if (op.type === 'equal') { const r = { type: 'equal', a: rawA[ia], b: rawB[ib] }; ia++; ib++; return r; }
          if (op.type === 'del') { const r = { type: 'del', a: rawA[ia] }; ia++; return r; }
          const r = { type: 'add', b: rawB[ib] }; ib++; return r;
        });
      }
      // Ignore-pattern is deliberately NOT handled here (see
      // applyIgnorePattern below) -- normalizing matching lines to a
      // shared token before diffing broke down whenever the two sides had
      // different COUNTS of matching lines, since the LCS engine has no
      // way to know "don't flag leftovers as changed against whatever's
      // next to them", it can only align tokens or not.
      function normalizeLine(line, opts) {
        let s = line;
        if (opts.ignoreWhitespace) s = s.trim().replace(/\s+/g, ' ');
        if (opts.ignoreCase) s = s.toLowerCase();
        return s;
      }

      /* ── HTML / Markdown preview (auto-detected per side) ───────────
         Zero-dependency, matching the page's own "zero dependencies"
         claim -- HTML renders in a fully sandboxed (sandbox="", no
         tokens) iframe so pasted content can never execute script, and
         Markdown gets a small hand-rolled renderer covering the common
         subset (headers, emphasis, code, links, lists, blockquotes,
         rules) rather than pulling in a library. ── */
      function detectContentType(text) {
        const t = text.trim();
        if (!t) return 'plain';
        if (/^<!doctype/i.test(t) || /^<(html|head|body|div|span|table|p|h[1-6]|ul|ol|section|article|a|img|table)[\s>]/i.test(t) || /<\/[a-z][a-z0-9]*>/i.test(t)) return 'html';
        if (/^#{1,6}\s/m.test(t) || /^\s*[-*+]\s/m.test(t) || /^\s*\d+\.\s/m.test(t) || /\[[^\]]+\]\([^)]+\)/.test(t) || /^```/m.test(t)) return 'markdown';
        return 'plain';
      }
      function markdownToHtml(src) {
        const escMd = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const blocks = [];
        const text = src.replace(/```([\s\S]*?)```/g, (m, code) => {
          blocks.push('<pre><code>' + escMd(code.replace(/^\n/, '')) + '</code></pre>');
          return '\u0000BLOCK' + (blocks.length - 1) + '\u0000';
        });
        function inline(s) {
          s = escMd(s);
          s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
          s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a, b) => '<strong>' + (a || b) + '</strong>');
          s = s.replace(/\*([^*]+)\*|_([^_]+)_/g, (m, a, b) => '<em>' + (a || b) + '</em>');
          s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
          s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
          return s;
        }
        let html = '', inUl = false, inOl = false, inQuote = false, para = [];
        const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
        const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };
        const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
        text.split('\n').forEach(line => {
          let m;
          if ((m = line.match(/^\u0000BLOCK(\d+)\u0000$/))) { flushPara(); closeLists(); closeQuote(); html += blocks[+m[1]]; return; }
          if (/^\s*$/.test(line)) { flushPara(); closeLists(); closeQuote(); return; }
          if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); closeLists(); closeQuote(); const lvl = m[1].length; html += `<h${lvl}>${inline(m[2])}</h${lvl}>`; return; }
          if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeLists(); closeQuote(); html += '<hr>'; return; }
          if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeLists(); if (!inQuote) { html += '<blockquote>'; inQuote = true; } html += inline(m[1]) + '<br>'; return; }
          if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); closeQuote(); if (inOl) { html += '</ol>'; inOl = false; } if (!inUl) { html += '<ul>'; inUl = true; } html += '<li>' + inline(m[1]) + '</li>'; return; }
          if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { flushPara(); closeQuote(); if (inUl) { html += '</ul>'; inUl = false; } if (!inOl) { html += '<ol>'; inOl = true; } html += '<li>' + inline(m[1]) + '</li>'; return; }
          closeLists(); closeQuote();
          para.push(line);
        });
        flushPara(); closeLists(); closeQuote();
        return html;
      }

      /* ── Storage ──────────────────────────────────────────────── */
      const SAVED_KEY = 'delta_saved', CURRENT_KEY = 'delta_current', THEME_KEY = 'delta_theme';
      const $ = id => document.getElementById(id);
      const textA = $('text-a'), textB = $('text-b'), labelAInput = $('label-a'), labelBInput = $('label-b');
      const textBase = $('text-base'), labelBaseInput = $('label-base'), basePaneRowEl = $('base-pane-row'), baseToggleEl = $('base-toggle');
      const diffOutput = $('diff-output'), diffStats = $('diff-stats'), toast = $('toast'), savedBar = $('saved-bar');
      const diffPanelsEl = $('diff-panels'), lineendingBannerEl = $('lineending-banner'), jsonFallbackBannerEl = $('json-fallback-banner');
      const largeInputBannerEl = $('large-input-banner');
      const ignorePatternInput = $('ignore-pattern'), ignorePatternCountEl = $('ignore-pattern-count'), previewPanelsEl = $('preview-panels');
      const ignorePatternChipsEl = $('ignore-pattern-chips');
      const previewBodyA = $('preview-body-a'), previewBodyB = $('preview-body-b'), previewBadgeA = $('preview-badge-a'), previewBadgeB = $('preview-badge-b');

      // Also escapes quotes (not just &/</>) -- textContent/innerHTML round-tripping
      // alone leaves literal " and ' characters untouched, which is fine when the
      // result only ever lands inside text content, but breaks out early wherever
      // it's interpolated straight into an HTML attribute value (e.g. a title or
      // aria-label built from user-entered text) via a template literal.
      function esc(value) {
        const d = document.createElement('div');
        d.textContent = value == null ? '' : value;
        return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
      function makeId() { return 'cmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
      let toastTimer, saveTimer;
      function pulseSaved() { const indicator = $('save-indicator'); if (!indicator) return; indicator.classList.remove('pulse'); void indicator.offsetWidth; indicator.classList.add('pulse'); clearTimeout(saveTimer); saveTimer = setTimeout(() => indicator.classList.remove('pulse'), 650); }
      function flash(message) { toast.textContent = message; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2100); }

      function loadSaved() {
        try { const saved = JSON.parse(localStorage.getItem(SAVED_KEY)); if (Array.isArray(saved)) return saved; } catch {}
        return [];
      }
      function saveSaved() { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); pulseSaved(); }
      function loadCurrent() {
        try { const c = JSON.parse(localStorage.getItem(CURRENT_KEY)); if (c && typeof c === 'object') return c; } catch {}
        return null;
      }
      function saveCurrent() {
        localStorage.setItem(CURRENT_KEY, JSON.stringify({
          textA: textA.value, textB: textB.value, labelA: labelAInput.value, labelB: labelBInput.value, currentSavedId,
          textBase: textBase.value, labelBase: labelBaseInput.value, baseShown: !basePaneRowEl.hidden,
        }));
        pulseSaved();
        refreshDirtyIndicator();
        updateAllPaneStats();
        updateIgnorePatternCount();
      }
      // Called from saveCurrent() (itself called after essentially every
      // content-changing action -- typing, paste, drag-drop, undo/redo,
      // swap, clear, load, share-link/boot restore) rather than wired to
      // individual 'input' events, so it can't go stale after any of them.
      function updatePaneStats(textarea, statsEl) {
        if (!statsEl) return;
        const value = textarea.value;
        if (!value) { statsEl.textContent = ''; return; }
        const lines = value.split('\n').length;
        const chars = value.length;
        statsEl.textContent = `${lines.toLocaleString()} line${lines === 1 ? '' : 's'} · ${chars.toLocaleString()} char${chars === 1 ? '' : 's'}`;
      }
      function updateAllPaneStats() {
        updatePaneStats(textA, $('stats-text-a'));
        updatePaneStats(textB, $('stats-text-b'));
        updatePaneStats(textBase, $('stats-text-base'));
      }

      let saved = loadSaved();
      let currentSavedId = null;
      let opts = { ignoreCase: false, ignoreWhitespace: false, onlyChanges: false, jsonMode: false, ignoreRegexes: [], showWhitespace: false };
      let viewMode = 'split';
      let liveMode = false, previewMode = false;

      /* ── Saved comparisons bar (save / restore / pin) ───────────── */
      function sortedSaved() {
        return [...saved].sort((x, y) => (y.pinned === x.pinned) ? 0 : (y.pinned ? 1 : -1));
      }
      function renderSavedBar() {
        const items = sortedSaved();
        savedBar.innerHTML = items.map(item => `<span class="saved-tab ${item.pinned ? 'pinned' : ''} ${item.id === currentSavedId ? 'active' : ''}" draggable="true" data-id="${esc(item.id)}">` +
          `<button class="saved-pin" type="button" data-pin="${esc(item.id)}" title="${item.pinned ? 'Unpin' : 'Pin'}">${item.pinned ? '★' : '☆'}</button>` +
          `<span class="saved-dirty" title="Unsaved changes" ${item.id === currentSavedId && isCurrentDirty() ? '' : 'hidden'}>●</span>` +
          `<span class="saved-name" data-load="${esc(item.id)}" title="Click to load, double-click to rename">${esc(item.name)}</span>` +
          `<button class="saved-rename" type="button" data-rename="${esc(item.id)}" title="Rename">✎</button>` +
          `<button class="saved-dup" type="button" data-dup="${esc(item.id)}" title="Duplicate">⧉</button>` +
          `<button class="saved-remove" type="button" data-remove="${esc(item.id)}" title="Delete">×</button>` +
          `</span>`).join('') + `<button class="button saved-add" type="button" id="save-as-new-button" title="Creates a new saved comparison from what's in the panes right now">+ New</button>`;
      }
      // A saved item is "dirty" when what's in the panes no longer matches
      // what was last saved under it (or, with nothing loaded, when the
      // panes have unsaved content at all) -- drives both the tab dot and
      // the discard-confirmation before switching away.
      function isCurrentDirty() {
        if (currentSavedId) {
          const item = saved.find(s => s.id === currentSavedId);
          if (!item) return false;
          return item.textA !== textA.value || item.textB !== textB.value ||
            (item.labelA || 'Version A') !== labelAInput.value || (item.labelB || 'Version B') !== labelBInput.value;
        }
        return !!(textA.value || textB.value);
      }
      function confirmDiscardIfDirty(actionLabel) {
        if (!isCurrentDirty()) return true;
        return confirm('You have unsaved changes. ' + actionLabel + ' will discard them. Continue?');
      }
      // Cheap per-keystroke refresh of just the active tab's dirty dot --
      // called from saveCurrent() so it stays in sync without a full
      // saved-bar re-render (and the drag/focus state loss that implies).
      function refreshDirtyIndicator() {
        const dot = savedBar.querySelector('.saved-tab.active .saved-dirty');
        if (dot) dot.hidden = !isCurrentDirty();
      }
      function startRenameTab(id) {
        const tab = savedBar.querySelector(`.saved-tab[data-id="${CSS.escape(id)}"]`);
        const nameEl = tab && tab.querySelector('.saved-name');
        if (!tab || !nameEl) return;
        const item = saved.find(s => s.id === id);
        if (!item) return;
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'saved-name-input'; input.value = item.name; input.maxLength = 80;
        nameEl.replaceWith(input);
        input.focus(); input.select();
        let done = false;
        const commit = () => {
          if (done) return; done = true;
          const name = input.value.trim();
          if (name) { item.name = name.slice(0, 80); saveSaved(); }
          renderSavedBar();
        };
        const cancel = () => { if (done) return; done = true; renderSavedBar(); };
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
      }
      function loadSavedItem(id) {
        const item = saved.find(s => s.id === id);
        if (!item) return;
        if (!confirmDiscardIfDirty('Loading "' + item.name + '"')) return;
        if (textA.value || textB.value) pushUndo();
        currentSavedId = id;
        textA.value = item.textA; textB.value = item.textB;
        labelAInput.value = item.labelA || 'Version A'; labelBInput.value = item.labelB || 'Version B';
        renderSavedBar(); runCompare(); saveCurrent();
        flash('Loaded "' + item.name + '"');
      }
      function duplicateSavedItem(id) {
        const item = saved.find(s => s.id === id);
        if (!item) return;
        if (!confirmDiscardIfDirty('Duplicating "' + item.name + '"')) return;
        const copy = { ...item, id: makeId(), name: (item.name + ' (copy)').slice(0, 80), pinned: false, updatedAt: new Date().toISOString() };
        saved.splice(saved.findIndex(s => s.id === id) + 1, 0, copy);
        currentSavedId = copy.id;
        textA.value = copy.textA; textB.value = copy.textB;
        labelAInput.value = copy.labelA || 'Version A'; labelBInput.value = copy.labelB || 'Version B';
        saveSaved(); renderSavedBar(); runCompare(); saveCurrent();
        flash('Duplicated "' + item.name + '"');
        startRenameTab(copy.id);
      }
      savedBar.addEventListener('click', event => {
        const pin = event.target.closest('[data-pin]'), remove = event.target.closest('[data-remove]'), rename = event.target.closest('[data-rename]'),
          dup = event.target.closest('[data-dup]'), load = event.target.closest('[data-load]'), addNew = event.target.closest('#save-as-new-button');
        if (pin) {
          const item = saved.find(s => s.id === pin.dataset.pin); if (!item) return;
          item.pinned = !item.pinned; saveSaved(); renderSavedBar();
        } else if (remove) {
          const item = saved.find(s => s.id === remove.dataset.remove); if (!item) return;
          if (!confirm('Delete saved comparison "' + item.name + '"?')) return;
          saved = saved.filter(s => s.id !== item.id);
          if (currentSavedId === item.id) currentSavedId = null;
          saveSaved(); renderSavedBar(); saveCurrent();
          flash('Deleted');
        } else if (rename) {
          startRenameTab(rename.dataset.rename);
        } else if (dup) {
          duplicateSavedItem(dup.dataset.dup);
        } else if (load) {
          loadSavedItem(load.dataset.load);
        } else if (addNew) {
          createFreshComparison();
        }
      });
      savedBar.addEventListener('dblclick', event => {
        const nameEl = event.target.closest('[data-load]'); if (!nameEl) return;
        startRenameTab(nameEl.dataset.load);
      });
      let dragId = null;
      savedBar.addEventListener('dragstart', event => { const tab = event.target.closest('[data-id]'); if (!tab) return; dragId = tab.dataset.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragId); });
      savedBar.addEventListener('dragover', event => { if (event.target.closest('[data-id]')) event.preventDefault(); });
      savedBar.addEventListener('drop', event => {
        const target = event.target.closest('[data-id]');
        if (!target || !dragId || target.dataset.id === dragId) return;
        event.preventDefault();
        const from = saved.findIndex(s => s.id === dragId), to = saved.findIndex(s => s.id === target.dataset.id);
        const [item] = saved.splice(from, 1); saved.splice(to, 0, item);
        saveSaved(); renderSavedBar(); dragId = null;
      });
      savedBar.addEventListener('dragend', () => { dragId = null; });

      // Used by the main "Save" button when nothing is currently loaded --
      // saves whatever is in the panes right now under a new name. Creates
      // it right away under a suggested name and drops straight into the
      // same inline rename used elsewhere, instead of a blocking prompt().
      function promptSaveAsNew() {
        const suggestion = (labelAInput.value || 'Comparison') + ' vs ' + (labelBInput.value || 'B');
        const item = { id: makeId(), name: suggestion.slice(0, 80), textA: textA.value, textB: textB.value, labelA: labelAInput.value, labelB: labelBInput.value, pinned: false, updatedAt: new Date().toISOString() };
        saved.push(item); currentSavedId = item.id;
        saveSaved(); renderSavedBar(); saveCurrent();
        flash('Saved "' + item.name + '"');
        startRenameTab(item.id);
      }
      // Used by the "+ New" tab-bar button -- creates a genuinely blank
      // comparison and clears the panes, rather than cloning whatever is
      // currently in them. Opens straight into inline rename rather than
      // a blocking prompt().
      function createFreshComparison() {
        if (!confirmDiscardIfDirty('Creating a new comparison')) return;
        const item = { id: makeId(), name: 'New comparison', textA: '', textB: '', labelA: 'Version A', labelB: 'Version B', pinned: false, updatedAt: new Date().toISOString() };
        saved.push(item); currentSavedId = item.id;

        if (textA.value || textB.value || textBase.value) pushUndo();
        textA.value = ''; textB.value = ''; labelAInput.value = 'Version A'; labelBInput.value = 'Version B';
        textBase.value = ''; labelBaseInput.value = 'Base';
        basePaneRowEl.hidden = true; baseToggleEl.classList.remove('active');
        lastOps = null; lastOpsBaseA = null; lastOpsBaseB = null;
        diffOutput.style.display = ''; diffOutput.className = 'diff-output';
        diffOutput.innerHTML = '<div class="diff-empty">Paste two versions above and click Compare (or press <span class="shortcut">ctrl</span>+<span class="shortcut">enter</span>).</div>';
        diffPanelsEl.innerHTML = '';
        mergePanelEl.hidden = true; mergeBlocks = []; mergeBlocksEl.innerHTML = ''; mergeOutputEl.value = ''; mergeSummaryEl.textContent = ''; lastMergeSignature = null;
        diffStats.textContent = '';
        lineendingBannerEl.hidden = true; lineendingBannerEl.innerHTML = '';
        jsonFallbackBannerEl.hidden = true; jsonFallbackBannerEl.innerHTML = '';
        largeInputBannerEl.hidden = true; largeInputBannerEl.innerHTML = '';
        if (previewMode) updatePreview();

        saveSaved(); renderSavedBar(); saveCurrent();
        flash('Created "' + item.name + '"');
        startRenameTab(item.id);
      }
      function saveOrUpdate() {
        if (currentSavedId) {
          const item = saved.find(s => s.id === currentSavedId);
          if (item) {
            item.textA = textA.value; item.textB = textB.value; item.labelA = labelAInput.value; item.labelB = labelBInput.value; item.updatedAt = new Date().toISOString();
            saveSaved(); renderSavedBar(); saveCurrent();
            flash('Updated "' + item.name + '"');
            return;
          }
        }
        promptSaveAsNew();
      }
      $('save-button').addEventListener('click', saveOrUpdate);

      /* ── Options / view mode ─────────────────────────────────────── */
      document.querySelectorAll('[data-opt]').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.opt;
          opts[key] = !opts[key];
          btn.classList.toggle('active', opts[key]);
          if (key === 'ignoreCase') updateIgnorePatternCount();
          if (lastOps) runCompare();
        });
      });
      document.querySelectorAll('[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
          viewMode = btn.dataset.view;
          document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === btn));
          if (lastOps) renderDiff(lastOps);
        });
      });
      // Ignore patterns are entered one at a time and committed with Enter
      // (rather than diffing the raw textbox on every keystroke) so several
      // can be combined -- a line is ignored if ANY of them match -- and so
      // each committed pattern is a known-valid regex worth persisting.
      ignorePatternInput.addEventListener('input', () => {
        const src = ignorePatternInput.value.trim();
        ignorePatternInput.classList.toggle('invalid', src !== '' && !isValidRegexSrc(src));
      });
      ignorePatternInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (addIgnorePattern(ignorePatternInput.value)) {
            ignorePatternInput.value = '';
            ignorePatternInput.classList.remove('invalid');
            updateIgnorePatternCount();
            if (lastOps) runCompare();
          }
        } else if (event.key === 'Backspace' && !ignorePatternInput.value && ignorePatterns.length) {
          ignorePatterns.pop();
          saveIgnorePatterns();
          renderIgnorePatternChips();
          updateIgnorePatternCount();
          if (lastOps) runCompare();
        }
      });
      ignorePatternChipsEl.addEventListener('click', event => {
        const btn = event.target.closest('.ignore-pattern-chip-remove');
        if (!btn) return;
        ignorePatterns.splice(Number(btn.dataset.index), 1);
        saveIgnorePatterns();
        renderIgnorePatternChips();
        updateIgnorePatternCount();
        if (lastOps) runCompare();
      });
      $('opt-live').addEventListener('click', () => {
        liveMode = !liveMode;
        $('opt-live').classList.toggle('active', liveMode);
        if (liveMode) scheduleLiveCompare();
      });
      $('opt-preview').addEventListener('click', () => {
        previewMode = !previewMode;
        $('opt-preview').classList.toggle('active', previewMode);
        previewPanelsEl.hidden = !previewMode;
        if (previewMode) updatePreview();
      });
      // Purely a rendering concern (unlike ignoreWhitespace, which changes
      // what counts as a difference) -- re-render the already-computed
      // diff instead of routing through the generic [data-opt] handler,
      // which would trigger a full unnecessary re-diff.
      $('opt-whitespace').addEventListener('click', () => {
        opts.showWhitespace = !opts.showWhitespace;
        $('opt-whitespace').classList.toggle('active', opts.showWhitespace);
        if (lastOps) renderDiff(lastOps);
      });
      // Same reasoning as opt-whitespace above -- which language to
      // tokenize as doesn't change what counts as a difference, just how
      // it's drawn, so this only re-renders.
      $('syntax-lang').addEventListener('change', () => {
        syntaxLang = $('syntax-lang').value;
        if (lastOps) renderDiff(lastOps);
      });

      /* ── Compare / render ─────────────────────────────────────────── */
      let lastOps = null, lastOpsBaseA = null, lastOpsBaseB = null;

      function baseModeActive() { return !basePaneRowEl.hidden && textBase.value.trim() !== ''; }

      function effectiveText(rawValue) {
        if (opts.jsonMode) {
          const pretty = prettyJsonIfPossible(rawValue);
          if (pretty !== null) return pretty;
        }
        return rawValue;
      }

      function diffPair(rawValueX, rawValueY) {
        const rawX = effectiveText(rawValueX).replace(/\r\n/g, '\n').split('\n');
        const rawY = effectiveText(rawValueY).replace(/\r\n/g, '\n').split('\n');
        const normX = rawX.map(l => normalizeLine(l, opts));
        const normY = rawY.map(l => normalizeLine(l, opts));
        const ops = diffLinesDisplay(rawX, rawY, normX, normY);
        return applyIgnorePattern(ops, opts.ignoreRegexes);
      }

      function updateLineEndingBanner() {
        const endA = detectLineEndings(textA.value), endB = detectLineEndings(textB.value);
        if (endA !== 'none' && endB !== 'none' && endA !== endB) {
          lineendingBannerEl.hidden = false;
          lineendingBannerEl.innerHTML = `<span>⚠ ${esc(labelAInput.value || 'Version A')} uses <strong>${endA}</strong> line endings, ${esc(labelBInput.value || 'Version B')} uses <strong>${endB}</strong> -- lines that look identical may still show as changed.</span>` +
            `<button type="button" class="button" data-normalize-eol title="Convert both sides to LF line endings">Normalize to LF</button>`;
        } else {
          lineendingBannerEl.hidden = true;
          lineendingBannerEl.innerHTML = '';
        }
      }
      lineendingBannerEl.addEventListener('click', event => {
        if (!event.target.closest('[data-normalize-eol]')) return;
        pushUndo();
        const toLF = s => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        textA.value = toLF(textA.value); textB.value = toLF(textB.value);
        flash('Normalized to LF');
        runCompare();
      });
      // "Pretty-print JSON" silently falls back to a plain text diff when a
      // side doesn't actually parse as JSON -- flag that so it doesn't read
      // as a structural JSON diff when it isn't one.
      function updateJsonFallbackBanner() {
        if (!opts.jsonMode) { jsonFallbackBannerEl.hidden = true; jsonFallbackBannerEl.innerHTML = ''; return; }
        const badA = textA.value.trim() !== '' && prettyJsonIfPossible(textA.value) === null;
        const badB = textB.value.trim() !== '' && prettyJsonIfPossible(textB.value) === null;
        if (!badA && !badB) { jsonFallbackBannerEl.hidden = true; jsonFallbackBannerEl.innerHTML = ''; return; }
        const who = badA && badB ? 'Both versions are' : (badA ? esc(labelAInput.value || 'Version A') + ' is' : esc(labelBInput.value || 'Version B') + ' is');
        jsonFallbackBannerEl.hidden = false;
        jsonFallbackBannerEl.innerHTML = `<span>⚠ ${who} not valid JSON -- showing a plain text diff instead of a structural one.</span>`;
      }

      // Reflects whether the main A/B diff actually had to fall back (set
      // by diffLines() itself, read right after diffPair() runs) rather
      // than guessing from input size upfront -- with Myers' algorithm, a
      // large document that's mostly similar to the other side diffs
      // almost instantly and never needs the fallback at all, so a pure
      // size-based warning would now be wrong more often than not. This
      // only fires when a diff was actually large *and* dissimilar enough
      // to hit the time budget.
      function updateLargeInputBanner() {
        if (lastDiffUsedFallback) {
          const linesA = textA.value ? textA.value.split('\n').length : 0;
          const linesB = textB.value ? textB.value.split('\n').length : 0;
          largeInputBannerEl.hidden = false;
          largeInputBannerEl.innerHTML = `<span>⚠ This comparison (${linesA.toLocaleString()} × ${linesB.toLocaleString()} lines) was too large and different to diff exactly within a reasonable time -- using a faster, simpler diff instead. It matches the common start and end but won't always find the tightest possible alignment in the middle.</span>`;
        } else {
          largeInputBannerEl.hidden = true;
          largeInputBannerEl.innerHTML = '';
        }
      }

      /* ── Ignore patterns -- persisted, multiple, combined with OR ───
         Patterns are stored as raw strings (not RegExp objects) so the
         "Ignore case" toggle can be applied fresh each time one is built,
         instead of baking a flag in at the moment each pattern was added. */
      const IGNORE_PATTERNS_KEY = 'delta_ignore_patterns';
      function loadIgnorePatterns() {
        try {
          const arr = JSON.parse(localStorage.getItem(IGNORE_PATTERNS_KEY));
          return Array.isArray(arr) ? arr.filter(p => typeof p === 'string' && p) : [];
        } catch (e) { return []; }
      }
      function saveIgnorePatterns() {
        try { localStorage.setItem(IGNORE_PATTERNS_KEY, JSON.stringify(ignorePatterns)); } catch (e) {}
      }
      let ignorePatterns = loadIgnorePatterns();
      function isValidRegexSrc(src) { try { new RegExp(src); return true; } catch (e) { return false; } }
      function renderIgnorePatternChips() {
        ignorePatternChipsEl.innerHTML = ignorePatterns.map((p, i) =>
          `<span class="ignore-pattern-chip"><code>${esc(p)}</code><button type="button" class="ignore-pattern-chip-remove" data-index="${i}" title="Remove this pattern" aria-label="Remove pattern ${esc(p)}">×</button></span>`
        ).join('');
      }
      function addIgnorePattern(src) {
        src = src.trim();
        if (!src || !isValidRegexSrc(src) || ignorePatterns.includes(src)) return false;
        ignorePatterns.push(src);
        saveIgnorePatterns();
        renderIgnorePatternChips();
        return true;
      }
      // No 'g' flag: only ever used with .test() (a single does-this-line-
      // match check), and .test() on a global regex is stateful (advances
      // lastIndex across calls), which would silently make matches alternate
      // true/false across lines if reused. Respects "Ignore case" so the two
      // options don't fight -- with case-sensitive matching on, a pattern
      // crafted for lowercase text stops matching the moment "Ignore case"
      // is also on and the input's actual casing differs.
      function computeIgnoreRegexes() {
        const flags = opts.ignoreCase ? 'i' : '';
        return ignorePatterns.map(src => { try { return new RegExp(src, flags); } catch (e) { return null; } }).filter(Boolean);
      }
      // Feedback that the pattern(s) are actually matching something, shown
      // independent of whether it changes the diff verdict -- with no
      // indicator at all, testing them against two sides that already have
      // no differences (or where the matched lines aren't near anything
      // else that changed) looks exactly like it's silently doing nothing.
      function updateIgnorePatternCount() {
        const regexes = computeIgnoreRegexes();
        if (!regexes.length) { ignorePatternCountEl.textContent = ''; ignorePatternCountEl.classList.remove('active'); return; }
        const countMatches = text => text ? text.split('\n').filter(line => testIgnoreAny(regexes, line)).length : 0;
        const count = countMatches(textA.value) + countMatches(textB.value);
        if (count === 0) {
          ignorePatternCountEl.textContent = 'no matching lines';
          ignorePatternCountEl.classList.remove('active');
        } else {
          ignorePatternCountEl.textContent = count + ' line' + (count === 1 ? '' : 's') + ' ignored';
          ignorePatternCountEl.classList.add('active');
        }
      }

      function runCompare() {
        updateLineEndingBanner();
        updateJsonFallbackBanner();
        opts.ignoreRegexes = computeIgnoreRegexes();
        lastOps = diffPair(textA.value, textB.value);
        updateLargeInputBanner(); // after diffPair(), so lastDiffUsedFallback reflects THIS compare
        if (baseModeActive()) {
          lastOpsBaseA = diffPair(textBase.value, textA.value);
          lastOpsBaseB = diffPair(textBase.value, textB.value);
        } else {
          lastOpsBaseA = null; lastOpsBaseB = null;
        }
        renderDiff(lastOps);
        saveCurrent();
        if (previewMode) updatePreview();
      }

      /* ── Live/auto-compare -- debounced re-compare while typing, opt-in
         since diffing on every keystroke isn't wanted for huge inputs. ── */
      let liveTimer;
      function scheduleLiveCompare() {
        if (!liveMode) return;
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => { if (textA.value && textB.value) runCompare(); }, 500);
      }

      function renderPreviewSide(container, badgeEl, text) {
        const type = detectContentType(text);
        badgeEl.textContent = type === 'html' ? 'HTML' : type === 'markdown' ? 'Markdown' : 'Plain text';
        container.innerHTML = '';
        if (!text.trim()) { container.innerHTML = '<div class="preview-empty">Nothing to preview</div>'; return; }
        if (type === 'html') {
          const iframe = document.createElement('iframe');
          iframe.className = 'preview-frame';
          iframe.setAttribute('sandbox', '');
          container.appendChild(iframe);
          iframe.srcdoc = text;
        } else if (type === 'markdown') {
          const div = document.createElement('div');
          div.className = 'preview-markdown';
          div.innerHTML = markdownToHtml(text);
          container.appendChild(div);
        } else {
          const pre = document.createElement('pre');
          pre.className = 'preview-plain';
          pre.textContent = text;
          container.appendChild(pre);
        }
      }
      function updatePreview() {
        if (previewPanelsEl.hidden) return;
        $('preview-title-a').textContent = labelAInput.value || 'Version A';
        $('preview-title-b').textContent = labelBInput.value || 'Version B';
        renderPreviewSide(previewBodyA, previewBadgeA, textA.value);
        renderPreviewSide(previewBodyB, previewBadgeB, textB.value);
      }

      let foldStore = {}, foldCounter = 0;
      const FOLD_CONTEXT = 3;
      function currentFoldContext() { return opts.onlyChanges ? 0 : FOLD_CONTEXT; }

      // Builds highlighted-HTML for a changed line pair, auto-choosing
      // word- or char-level diffing, and makes whitespace-only changes
      // (trailing spaces, tabs) visible instead of silently invisible.
      // If either side matches the ignore pattern, skip word-diffing
      // entirely (there's nothing meaningful to compare word-by-word
      // against a line that's not supposed to count) and just render
      // each side independently: ignored -> muted/italic, otherwise the
      // plain full-line text, same as a genuinely unpaired del/add.
      function changedLinePairHtml(a, b, aIgnored, bIgnored) {
        if (aIgnored || bIgnored) {
          return {
            left: aIgnored ? `<span class="diff-ignored-text">${renderLineText(a)}</span>` : renderLineText(a),
            right: bIgnored ? `<span class="diff-ignored-text">${renderLineText(b)}</span>` : renderLineText(b),
          };
        }
        const { ops: subOps } = chooseLineDiff(a, b);
        // Converts one side's filtered ops (whose .text chunks, in
        // order, exactly reconstruct that side's original line -- an
        // invariant of the diff itself) into offset ranges over that
        // line, so they can be merged against the syntax-token ranges
        // below, which are offsets into that same original line.
        function opsToRanges(ops) {
          const ranges = [];
          let pos = 0;
          ops.forEach(o => { ranges.push({ start: pos, end: pos + o.text.length, type: o.type }); pos += o.text.length; });
          return ranges;
        }
        // Builds one side's HTML by merging its diff ranges with its
        // syntax-token ranges (see mergeRanges), so a word that's both
        // "changed" and "a string literal" gets both a <del>/<ins> and a
        // .tok-string span instead of one silently winning. Whitespace-
        // only CHANGED segments are always made visible (otherwise a
        // pure trailing-space edit is invisible); with the Whitespace
        // toggle on, every segment is, changed or not -- same rule
        // renderLineText uses for whole lines, re-checked per merged
        // segment here since a syntax-token boundary can split what was
        // originally a single whitespace-run diff token.
        function sideHtml(filterOutType, wrapType, lineText) {
          const diffRanges = opsToRanges(subOps.filter(o => o.type !== filterOutType));
          const synRanges = tokenizeLineRanges(lineText, syntaxLang);
          return mergeRanges(diffRanges, synRanges).map(seg => {
            const segText = lineText.slice(seg.start, seg.end);
            const forceViz = opts.showWhitespace || (/^\s+$/.test(segText) && seg.a.type !== 'equal');
            let inner = forceViz ? visualizeWhitespace(esc(segText)) : esc(segText);
            if (seg.b.cls) inner = `<span class="tok-${seg.b.cls}">${inner}</span>`;
            if (seg.a.type === wrapType) {
              inner = wrapType === 'del' ? `<del class="diff-word-del">${inner}</del>` : `<ins class="diff-word-add">${inner}</ins>`;
            }
            return inner;
          }).join('');
        }
        return { left: sideHtml('add', 'del', a), right: sideHtml('del', 'add', b) };
      }

      function foldBarHtml(count, hiddenRowsHtml, colspanClass) {
        const id = 'fold-' + (foldCounter++);
        foldStore[id] = hiddenRowsHtml;
        return `<div class="diff-fold ${colspanClass || ''}" data-fold="${id}">⋯ ${count} unchanged line${count === 1 ? '' : 's'} -- click to expand ⋯</div>`;
      }

      function diffRowHtml(numA, htmlA, numB, htmlB, classA, classB) {
        return `<div class="diff-row">` +
          `<div class="diff-half ${classA}">${numA != null ? `<span class="diff-lineno">${numA}</span>` : '<span class="diff-lineno"></span>'}<span class="diff-line">${htmlA}</span></div>` +
          `<div class="diff-half ${classB}">${numB != null ? `<span class="diff-lineno">${numB}</span>` : '<span class="diff-lineno"></span>'}<span class="diff-line">${htmlB}</span></div>` +
          `</div>`;
      }
      function equalRowsSplit(items, startA, startB) {
        let a = startA, b = startB;
        return items.map(op => {
          a++; b++;
          const htmlA = op.ignored ? `<span class="diff-ignored-text">${renderLineText(op.a)}</span>` : renderLineText(op.a);
          const htmlB = op.ignored ? `<span class="diff-ignored-text">${renderLineText(op.b)}</span>` : renderLineText(op.b);
          return diffRowHtml(a, htmlA, b, htmlB, '', '');
        }).join('');
      }
      function renderSplitHtml(groups, copyActions) {
        let lineA = 0, lineB = 0;
        const rows = [];
        const context = currentFoldContext();
        groups.forEach(g => {
          if (g.type === 'equal') {
            const plan = planEqualRun(g.items, context);
            rows.push(equalRowsSplit(plan.head, lineA, lineB));
            lineA += plan.head.length; lineB += plan.head.length;
            if (plan.foldedCount > 0) {
              const hidden = equalRowsSplit(g.items.slice(plan.head.length, g.items.length - plan.tail.length), lineA, lineB);
              rows.push(foldBarHtml(plan.foldedCount, hidden));
              lineA += plan.foldedCount; lineB += plan.foldedCount;
            }
            rows.push(equalRowsSplit(plan.tail, lineA, lineB));
            lineA += plan.tail.length; lineB += plan.tail.length;
          } else {
            const aStart = lineA + 1, bStart = lineB + 1;
            const groupRows = [];
            const pairCount = Math.min(g.dels.length, g.adds.length);
            for (let k = 0; k < pairCount; k++) {
              lineA++; lineB++;
              const d = g.dels[k], a2 = g.adds[k];
              const { left, right } = changedLinePairHtml(d.a, a2.b, d.ignored, a2.ignored);
              groupRows.push(diffRowHtml(lineA, left, lineB, right, d.ignored ? '' : 'del', a2.ignored ? '' : 'add'));
            }
            for (let k = pairCount; k < g.dels.length; k++) {
              lineA++;
              const d = g.dels[k];
              const html = d.ignored ? `<span class="diff-ignored-text">${renderLineText(d.a)}</span>` : renderLineText(d.a);
              groupRows.push(diffRowHtml(lineA, html, null, '', d.ignored ? '' : 'del', 'empty'));
            }
            for (let k = pairCount; k < g.adds.length; k++) {
              lineB++;
              const a2 = g.adds[k];
              const html = a2.ignored ? `<span class="diff-ignored-text">${renderLineText(a2.b)}</span>` : renderLineText(a2.b);
              groupRows.push(diffRowHtml(null, '', lineB, html, 'empty', a2.ignored ? '' : 'add'));
            }
            if (copyActions) {
              const labelA = esc(labelAInput.value || 'Version A'), labelB = esc(labelBInput.value || 'Version B');
              rows.push(
                `<div class="diff-group" data-a-start="${aStart}" data-a-len="${g.dels.length}" data-b-start="${bStart}" data-b-len="${g.adds.length}">` +
                `<div class="diff-group-rows">${groupRows.join('')}</div>` +
                `<div class="diff-group-actions">` +
                `<button type="button" class="diff-copy-btn" data-copy-dir="a-to-b" title="Copy this block to ${labelB}">&#8594;</button>` +
                `<button type="button" class="diff-copy-btn" data-copy-dir="b-to-a" title="Copy this block to ${labelA}">&#8592;</button>` +
                `</div></div>`
              );
            } else {
              rows.push(groupRows.join(''));
            }
          }
        });
        return rows.join('');
      }
      function equalRowsUnified(items, startA, startB) {
        let a = startA, b = startB;
        return items.map(op => {
          a++; b++;
          const html = op.ignored ? `<span class="diff-ignored-text">${renderLineText(op.a)}</span>` : renderLineText(op.a);
          return `<div class="diff-row"><span class="diff-marker"> </span><span class="diff-lineno">${a}/${b}</span><span class="diff-line">${html}</span></div>`;
        }).join('');
      }
      // Ignored del/add rows keep their marker (-/+) and line number for
      // context, but drop the del/add row class (no red/green background)
      // and render the text muted/italic instead.
      function unifiedRow(marker, rowClass, lineno, html) {
        return `<div class="diff-row${rowClass ? ' ' + rowClass : ''}"><span class="diff-marker">${marker}</span><span class="diff-lineno">${lineno}</span><span class="diff-line">${html}</span></div>`;
      }
      function renderUnifiedHtml(groups) {
        let lineA = 0, lineB = 0;
        const rows = [];
        const context = currentFoldContext();
        groups.forEach(g => {
          if (g.type === 'equal') {
            const plan = planEqualRun(g.items, context);
            rows.push(equalRowsUnified(plan.head, lineA, lineB));
            lineA += plan.head.length; lineB += plan.head.length;
            if (plan.foldedCount > 0) {
              const hidden = equalRowsUnified(g.items.slice(plan.head.length, g.items.length - plan.tail.length), lineA, lineB);
              rows.push(foldBarHtml(plan.foldedCount, hidden, 'diff-fold-unified'));
              lineA += plan.foldedCount; lineB += plan.foldedCount;
            }
            rows.push(equalRowsUnified(plan.tail, lineA, lineB));
            lineA += plan.tail.length; lineB += plan.tail.length;
          } else {
            const pairCount = Math.min(g.dels.length, g.adds.length);
            for (let k = 0; k < pairCount; k++) {
              lineA++; lineB++;
              const d = g.dels[k], a2 = g.adds[k];
              const { left, right } = changedLinePairHtml(d.a, a2.b, d.ignored, a2.ignored);
              rows.push(unifiedRow('-', d.ignored ? '' : 'del', lineA, left));
              rows.push(unifiedRow('+', a2.ignored ? '' : 'add', lineB, right));
            }
            for (let k = pairCount; k < g.dels.length; k++) {
              lineA++;
              const d = g.dels[k];
              const html = d.ignored ? `<span class="diff-ignored-text">${renderLineText(d.a)}</span>` : renderLineText(d.a);
              rows.push(unifiedRow('-', d.ignored ? '' : 'del', lineA, html));
            }
            for (let k = pairCount; k < g.adds.length; k++) {
              lineB++;
              const a2 = g.adds[k];
              const html = a2.ignored ? `<span class="diff-ignored-text">${renderLineText(a2.b)}</span>` : renderLineText(a2.b);
              rows.push(unifiedRow('+', a2.ignored ? '' : 'add', lineB, html));
            }
          }
        });
        return rows.join('');
      }
      // Collects the DOM ids of each change-block's first row so keyboard
      // hunk navigation (] / [) has somewhere to jump to. Populated as a
      // side effect during HTML string assembly, matched up by attaching
      // ids the first time each block's first row is written -- simplest
      // to do as a second lightweight pass over the rendered container
      // after it's in the DOM (see jumpToHunk / collectHunks below).
      function renderDiffSection(ops, targetEl, copyActions) {
        const added = ops.filter(o => o.type === 'add' && !o.ignored).length;
        const removed = ops.filter(o => o.type === 'del' && !o.ignored).length;
        if (!added && !removed) {
          targetEl.className = 'diff-output';
          targetEl.innerHTML = '<div class="diff-empty">No differences -- both versions are identical.</div>';
          return { added, removed };
        }
        const groups = groupOps(ops);
        if (viewMode === 'split') {
          targetEl.className = 'diff-output';
          targetEl.innerHTML = renderSplitHtml(groups, copyActions) || '<div class="diff-empty">No differences.</div>';
        } else {
          targetEl.className = 'diff-output diff-unified';
          targetEl.innerHTML = renderUnifiedHtml(groups) || '<div class="diff-empty">No differences.</div>';
        }
        markHunkStarts(targetEl);
        return { added, removed };
      }
      // Tags every changed .diff-row (del/add/change) with a data-hunk id,
      // for ] / [ navigation -- one stop per changed LINE, not per
      // contiguous block. A block-level "first row of each run" scheme
      // means a single multi-line change is only one stop, so ] just
      // re-flashes that same row forever on anything with one big change
      // block; per-line stops actually walk through it.
      function markHunkStarts(container) {
        let n = 0;
        container.querySelectorAll('.diff-row').forEach(el => {
          // .diff-half.empty alone doesn't count -- it's just the blank
          // side of an unpaired del/add, which always has a .del/.add
          // half of its own too UNLESS that content is ignored (muted,
          // no color class), in which case the row isn't a real change.
          const isChange = el.querySelector('.diff-half.del, .diff-half.add') || el.classList.contains('del') || el.classList.contains('add');
          if (isChange) { el.dataset.hunk = String(n++); }
        });
      }
      // Per-hunk "copy this block to the other side" (Beyond Compare calls
      // it Copy Left/Copy Right; Meld just uses the arrows) -- splices the
      // source side's lines for this hunk over the target side's lines at
      // the same position and re-diffs. Works for replace/insert/delete
      // alike since an empty source or target length just means "delete"
      // or "insert" rather than "replace".
      function spliceGroupInto(sourceLines, sourceStart, sourceLen, targetLines, targetStart, targetLen) {
        const before = targetLines.slice(0, targetStart - 1);
        const after = targetLines.slice(targetStart - 1 + targetLen);
        const middle = sourceLines.slice(sourceStart - 1, sourceStart - 1 + sourceLen);
        return before.concat(middle, after);
      }
      function eolFor(text) { return detectLineEndings(text) === 'CRLF' ? '\r\n' : '\n'; }
      // After a copy, the whole diff re-renders from scratch (line numbers
      // shift, folds can open/close), so there's nothing linking "the block
      // that just vanished on one side" to "the block that just appeared
      // on the other" -- scroll to and sticky-highlight the resulting rows
      // on the target side, same highlight ]/[ navigation uses, so the eye
      // has somewhere to land. Rows hidden inside a collapsed context fold
      // aren't in the DOM to find; this silently highlights nothing for
      // those rather than force-expanding the fold.
      function flashCopiedRange(side, start, len) {
        if (len <= 0) return;
        const halfSelector = side === 'a' ? '.diff-half:first-child' : '.diff-half:last-child';
        const matches = [];
        diffOutput.querySelectorAll('.diff-row').forEach(row => {
          const lineEl = row.querySelector(halfSelector + ' .diff-lineno');
          const n = lineEl ? parseInt(lineEl.textContent, 10) : NaN;
          if (!Number.isNaN(n) && n >= start && n < start + len) matches.push(row);
        });
        if (!matches.length) return;
        dismissHunkFlash();
        matches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        void matches[0].offsetWidth;
        matches.forEach(r => r.classList.add('hunk-flash'));
      }
      // Shared by the mouse click on a .diff-copy-btn and the Alt+Left/
      // Alt+Right keyboard shortcut on a flashed hunk, so the two paths
      // can't drift out of sync with each other.
      function copyHunkGroup(groupEl, dir) {
        const aStart = +groupEl.dataset.aStart, aLen = +groupEl.dataset.aLen;
        const bStart = +groupEl.dataset.bStart, bLen = +groupEl.dataset.bLen;
        const aLines = splitRawLines(textA.value), bLines = splitRawLines(textB.value);
        pushUndo();
        if (dir === 'a-to-b') {
          textB.value = spliceGroupInto(aLines, aStart, aLen, bLines, bStart, bLen).join(eolFor(textB.value));
          textB.dispatchEvent(new Event('input'));
          flash('Copied to ' + (labelBInput.value || 'Version B'));
          runCompare();
          flashCopiedRange('b', bStart, aLen);
        } else {
          textA.value = spliceGroupInto(bLines, bStart, bLen, aLines, aStart, aLen).join(eolFor(textA.value));
          textA.dispatchEvent(new Event('input'));
          flash('Copied to ' + (labelAInput.value || 'Version A'));
          runCompare();
          flashCopiedRange('a', aStart, bLen);
        }
      }
      diffOutput.addEventListener('click', event => {
        const btn = event.target.closest('.diff-copy-btn');
        if (!btn) return;
        const groupEl = btn.closest('.diff-group');
        if (!groupEl) return;
        // Otherwise this same click bubbles up to the document-level
        // ]/[ flash handler below, which unconditionally clears any
        // .hunk-flash on every click -- wiping out the highlight we're
        // about to add before it's ever painted.
        event.stopPropagation();
        copyHunkGroup(groupEl, btn.dataset.copyDir);
      });
      function renderDiff(ops) {
        foldStore = {}; foldCounter = 0;
        hunkIndex = -1;
        bookmarkedHunks.clear(); bookmarkIndex = -1;
        const added = ops.filter(o => o.type === 'add' && !o.ignored).length;
        const removed = ops.filter(o => o.type === 'del' && !o.ignored).length;
        const unchanged = ops.filter(o => o.type === 'equal' || o.ignored).length;
        diffStats.innerHTML = `<span class="added">+${added}</span> <span class="removed">-${removed}</span> · ${unchanged} unchanged`;
        diffPanelsEl.innerHTML = '';
        if (baseModeActive()) {
          diffPanelsEl.appendChild(buildDiffPanel('Base → ' + (labelAInput.value || 'Version A'), lastOpsBaseA));
          diffPanelsEl.appendChild(buildDiffPanel('Base → ' + (labelBInput.value || 'Version B'), lastOpsBaseB));
          diffOutput.style.display = 'none';
          mergePanelEl.hidden = false;
          buildAndRenderMergePanel();
        } else {
          diffOutput.style.display = '';
          renderDiffSection(ops, diffOutput, true);
          mergePanelEl.hidden = true;
        }
      }
      function buildDiffPanel(title, panelOps) {
        const wrap = document.createElement('div');
        wrap.className = 'diff-panel';
        const heading = document.createElement('div');
        heading.className = 'diff-panel-title';
        heading.textContent = title;
        const body = document.createElement('div');
        body.className = 'diff-output';
        wrap.appendChild(heading); wrap.appendChild(body);
        renderDiffSection(panelOps, body);
        return wrap;
      }

      /* ── 3-way merge (Base mode) ──────────────────────────────────
         Standard diff3-style merge: diff Base→A and Base→B separately,
         then walk both alongside the shared Base line numbering. Deciding
         whether to KEEP or DROP an existing base line never conflicts --
         either side can independently agree to drop it, and "both dropped
         it" is just agreement, not a conflict. The only place a real
         conflict can arise is when both sides insert different NEW content
         at the exact same position (immediately reduces to "both sides
         edited this same spot differently" for ordinary line replacements,
         since a replacement is modeled as delete-then-insert-after).
         Always computed from RAW text, ignoring Ignore case/whitespace/
         pattern -- those are review aids for the diff view, and silently
         letting them decide what a produced merge actually contains would
         be a real correctness bug, not just a display choice. */
      const mergePanelEl = $('merge-panel'), mergeSummaryEl = $('merge-summary'), mergeBlocksEl = $('merge-blocks'), mergeOutputEl = $('merge-output');
      let mergeBlocks = [];

      function splitRawLines(text) { return text.replace(/\r\n/g, '\n').split('\n'); }
      function arraysEqualStr(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

      // For one side's diff against Base: for each base line index, was it
      // kept ('equal') or dropped ('removed') on this side; and at each gap
      // BEFORE base line g (gap baseLen = after the last line), what new
      // lines this side inserted there.
      function buildSideMaps(baseLen, ops) {
        const status = new Array(baseLen);
        const insertions = Array.from({ length: baseLen + 1 }, () => []);
        let baseIdx = 0;
        for (const op of ops) {
          if (op.type === 'equal') { status[baseIdx] = 'equal'; baseIdx++; }
          else if (op.type === 'del') { status[baseIdx] = 'removed'; baseIdx++; }
          else if (op.type === 'add') { insertions[baseIdx].push(op.b); }
        }
        return { status, insertions };
      }

      function buildMergeBlocks(baseLines, aLines, bLines) {
        const opsA = diffLinesDisplay(baseLines, aLines, baseLines, aLines);
        const opsB = diffLinesDisplay(baseLines, bLines, baseLines, bLines);
        const { status: statusA, insertions: insA } = buildSideMaps(baseLines.length, opsA);
        const { status: statusB, insertions: insB } = buildSideMaps(baseLines.length, opsB);

        const blocks = [];
        let pending = null;
        let conflictCounter = 0;
        function flushPending() {
          if (!pending) return;
          if (pending.type === 'context' ? pending.lines.length : (pending.removed.length || pending.added.length)) blocks.push(pending);
          pending = null;
        }
        function addContext(line) {
          if (pending && pending.type === 'context') pending.lines.push(line);
          else { flushPending(); pending = { type: 'context', lines: [line] }; }
        }
        function addAuto(source, kind, line) {
          if (pending && pending.type === 'auto' && pending.source === source) pending[kind].push(line);
          else { flushPending(); pending = { type: 'auto', source, removed: [], added: [] }; pending[kind].push(line); }
        }

        for (let g = 0; g <= baseLines.length; g++) {
          const a = insA[g], b = insB[g];
          if (a.length || b.length) {
            if (a.length && !b.length) a.forEach(l => addAuto('A', 'added', l));
            else if (b.length && !a.length) b.forEach(l => addAuto('B', 'added', l));
            else if (arraysEqualStr(a, b)) a.forEach(l => addAuto('both', 'added', l));
            else { flushPending(); blocks.push({ type: 'conflict', id: 'mc-' + (conflictCounter++), aLines: a.slice(), bLines: b.slice(), resolution: null }); }
          }
          if (g < baseLines.length) {
            const sa = statusA[g], sb = statusB[g];
            if (sa === 'equal' && sb === 'equal') addContext(baseLines[g]);
            else if (sa === 'removed' && sb === 'equal') addAuto('A', 'removed', baseLines[g]);
            else if (sa === 'equal' && sb === 'removed') addAuto('B', 'removed', baseLines[g]);
            else addAuto('both', 'removed', baseLines[g]);
          }
        }
        flushPending();
        return blocks;
      }

      function mergeBlockOutputLines(block) {
        if (block.type === 'context') return block.lines;
        if (block.type === 'auto') return block.added;
        // Plain-text output (textarea value / copy / download) -- NOT HTML,
        // so labels go in raw here, unlike renderMergeBlock()'s HTML markup.
        const labelA = labelAInput.value || 'Version A', labelB = labelBInput.value || 'Version B';
        if (block.resolution === 'A') return block.aLines;
        if (block.resolution === 'B') return block.bLines;
        if (block.resolution === 'AB') return block.aLines.concat(block.bLines);
        if (block.resolution === 'BA') return block.bLines.concat(block.aLines);
        return ['<<<<<<< ' + labelA].concat(block.aLines, ['======='], block.bLines, ['>>>>>>> ' + labelB]);
      }
      function regenerateMergeOutput() {
        const lines = [];
        mergeBlocks.forEach(b => lines.push(...mergeBlockOutputLines(b)));
        mergeOutputEl.value = lines.join('\n');
      }

      const MERGE_CONTEXT_FOLD_AT = 8, MERGE_CONTEXT_EDGE = 3;
      function mergeContextHtml(lines) {
        if (lines.length <= MERGE_CONTEXT_FOLD_AT) {
          return lines.map(l => `<div class="merge-line">${esc(l)}</div>`).join('');
        }
        const head = lines.slice(0, MERGE_CONTEXT_EDGE).map(l => `<div class="merge-line">${esc(l)}</div>`).join('');
        const tail = lines.slice(-MERGE_CONTEXT_EDGE).map(l => `<div class="merge-line">${esc(l)}</div>`).join('');
        const hiddenCount = lines.length - MERGE_CONTEXT_EDGE * 2;
        const hiddenHtml = lines.slice(MERGE_CONTEXT_EDGE, -MERGE_CONTEXT_EDGE).map(l => `<div class="merge-line">${esc(l)}</div>`).join('');
        return head + foldBarHtml(hiddenCount, hiddenHtml) + tail;
      }
      function mergeSourceLabel(source) {
        if (source === 'A') return esc(labelAInput.value || 'Version A');
        if (source === 'B') return esc(labelBInput.value || 'Version B');
        return 'both (agree)';
      }
      function renderMergeBlock(block) {
        if (block.type === 'context') {
          return `<div class="merge-block merge-block-context">${mergeContextHtml(block.lines)}</div>`;
        }
        if (block.type === 'auto') {
          const removedHtml = block.removed.map(l => `<div class="merge-line merge-line-removed">${esc(l)}</div>`).join('');
          const addedHtml = block.added.map(l => `<div class="merge-line merge-line-added">${esc(l)}</div>`).join('');
          return `<div class="merge-block merge-block-auto">` +
            `<div class="merge-block-label">Auto-merged -- changed by ${mergeSourceLabel(block.source)}</div>` +
            removedHtml + addedHtml +
            `</div>`;
        }
        const labelA = esc(labelAInput.value || 'Version A'), labelB = esc(labelBInput.value || 'Version B');
        const res = block.resolution;
        return `<div class="merge-block merge-block-conflict" data-conflict-id="${block.id}">` +
          `<div class="merge-block-label">Conflict${res ? ' -- resolved' : ' -- needs a decision'}</div>` +
          `<div class="merge-conflict-columns">` +
          `<div class="merge-conflict-side ${res === 'A' || res === 'AB' || res === 'BA' ? 'chosen' : ''}"><h4>${labelA}</h4>${block.aLines.map(l => `<div class="merge-line">${esc(l)}</div>`).join('')}</div>` +
          `<div class="merge-conflict-side ${res === 'B' || res === 'AB' || res === 'BA' ? 'chosen' : ''}"><h4>${labelB}</h4>${block.bLines.map(l => `<div class="merge-line">${esc(l)}</div>`).join('')}</div>` +
          `</div>` +
          `<div class="merge-conflict-actions">` +
          `<button type="button" class="toggle-chip ${res === 'A' ? 'active' : ''}" data-merge-resolve="A">Use ${labelA}</button>` +
          `<button type="button" class="toggle-chip ${res === 'B' ? 'active' : ''}" data-merge-resolve="B">Use ${labelB}</button>` +
          `<button type="button" class="toggle-chip ${res === 'AB' ? 'active' : ''}" data-merge-resolve="AB">Both (${labelA} then ${labelB})</button>` +
          `<button type="button" class="toggle-chip ${res === 'BA' ? 'active' : ''}" data-merge-resolve="BA">Both (${labelB} then ${labelA})</button>` +
          `</div>` +
          `</div>`;
      }
      function renderMergePanel() {
        const conflicts = mergeBlocks.filter(b => b.type === 'conflict');
        const unresolved = conflicts.filter(b => !b.resolution).length;
        const autoCount = mergeBlocks.filter(b => b.type === 'auto').length;
        mergeSummaryEl.innerHTML = conflicts.length
          ? `<span class="${unresolved ? 'mc-pending' : 'mc-done'}">${unresolved ? unresolved + ' unresolved conflict' + (unresolved === 1 ? '' : 's') : 'All conflicts resolved'}</span> · ${autoCount} change${autoCount === 1 ? '' : 's'} auto-merged`
          : `No conflicts -- ${autoCount} change${autoCount === 1 ? '' : 's'} auto-merged`;
        mergeBlocksEl.innerHTML = mergeBlocks.map(renderMergeBlock).join('');
        regenerateMergeOutput();
      }
      // Re-running Compare (a click, Ctrl+Enter, even just habit) is common
      // while working through a merge -- rebuilding from scratch every time
      // would silently throw away every conflict resolution made so far the
      // moment someone re-compares without having changed anything. Only
      // rebuild (and so only reset resolutions) when Base/A/B actually
      // changed since the last build.
      let lastMergeSignature = null;
      function buildAndRenderMergePanel() {
        const signature = textBase.value + '\u0000' + textA.value + '\u0000' + textB.value;
        if (signature !== lastMergeSignature) {
          mergeBlocks = buildMergeBlocks(splitRawLines(textBase.value), splitRawLines(textA.value), splitRawLines(textB.value));
          lastMergeSignature = signature;
        }
        renderMergePanel();
      }
      mergeBlocksEl.addEventListener('click', event => {
        const btn = event.target.closest('[data-merge-resolve]');
        if (!btn) return;
        const blockEl = btn.closest('[data-conflict-id]');
        const block = mergeBlocks.find(b => b.id === blockEl.dataset.conflictId);
        if (!block) return;
        const choice = btn.dataset.mergeResolve;
        block.resolution = block.resolution === choice ? null : choice;
        renderMergePanel();
      });
      // Copy/download/apply all hand out mergeOutputEl.value as-is, markers
      // and all, same as `git merge` leaving a conflicted file on disk for
      // you to finish by hand -- but silently doing that with zero feedback
      // would be a confusing surprise the first time, so every one of these
      // says so when it applies.
      function unresolvedConflictNote() {
        const unresolved = mergeBlocks.filter(b => b.type === 'conflict' && !b.resolution).length;
        return unresolved ? ` (${unresolved} unresolved conflict${unresolved === 1 ? '' : 's'} left as markers)` : '';
      }
      $('merge-copy-button').addEventListener('click', () => {
        navigator.clipboard.writeText(mergeOutputEl.value).then(() => flash('Merged result copied' + unresolvedConflictNote())).catch(() => flash('Copy failed'));
      });
      $('merge-download-button').addEventListener('click', () => {
        const blob = new Blob([mergeOutputEl.value], { type: 'text/plain' }), url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = 'merged.txt'; link.click(); URL.revokeObjectURL(url);
        flash('Downloaded' + unresolvedConflictNote());
      });
      function sendMergeResultTo(target) {
        pushUndo();
        target.value = mergeOutputEl.value;
        target.dispatchEvent(new Event('input'));
        flash('Merged result applied' + unresolvedConflictNote());
      }
      $('merge-to-a-button').addEventListener('click', () => sendMergeResultTo(textA));
      $('merge-to-b-button').addEventListener('click', () => sendMergeResultTo(textB));

      /* ── Undo / Redo (for paste / drag-drop / swap / clear / load, which
         replace a textarea's .value via script -- browsers don't add that
         to the native ctrl+z history the way typed edits get, so this is
         the only way back from those specific mistakes). Undoing pushes
         onto the redo stack and vice versa; any new pushUndo() (i.e. any
         fresh action) clears redo, same as a normal editor. ── */
      const undoButtonEl = $('undo-button'), redoButtonEl = $('redo-button');
      const undoStack = [], redoStack = [];
      const UNDO_MAX = 20;
      function snapshotState() {
        return { textA: textA.value, textB: textB.value, labelA: labelAInput.value, labelB: labelBInput.value, textBase: textBase.value, labelBase: labelBaseInput.value };
      }
      function applySnapshot(snap) {
        textA.value = snap.textA; textB.value = snap.textB;
        labelAInput.value = snap.labelA; labelBInput.value = snap.labelB;
        textBase.value = snap.textBase; labelBaseInput.value = snap.labelBase;
      }
      function pushUndo() {
        undoStack.push(snapshotState());
        if (undoStack.length > UNDO_MAX) undoStack.shift();
        redoStack.length = 0;
        undoButtonEl.disabled = false;
        redoButtonEl.disabled = true;
      }
      $('undo-button').addEventListener('click', () => {
        if (!undoStack.length) { flash('Nothing to undo'); return; }
        redoStack.push(snapshotState());
        if (redoStack.length > UNDO_MAX) redoStack.shift();
        applySnapshot(undoStack.pop());
        undoButtonEl.disabled = undoStack.length === 0;
        redoButtonEl.disabled = false;
        if (lastOps) runCompare(); else saveCurrent();
        flash('Undone');
      });
      $('redo-button').addEventListener('click', () => {
        if (!redoStack.length) { flash('Nothing to redo'); return; }
        undoStack.push(snapshotState());
        if (undoStack.length > UNDO_MAX) undoStack.shift();
        applySnapshot(redoStack.pop());
        redoButtonEl.disabled = redoStack.length === 0;
        undoButtonEl.disabled = false;
        if (lastOps) runCompare(); else saveCurrent();
        flash('Redone');
      });

      $('compare-button').addEventListener('click', runCompare);
      $('swap-button').addEventListener('click', () => {
        pushUndo();
        const va = textA.value, vb = textB.value, la = labelAInput.value, lb = labelBInput.value;
        textA.value = vb; textB.value = va; labelAInput.value = lb; labelBInput.value = la;
        if (lastOps) runCompare(); else saveCurrent();
        flash('Swapped A and B');
      });
      $('clear-button').addEventListener('click', () => {
        if (textA.value || textB.value || textBase.value) pushUndo();
        textA.value = ''; textB.value = ''; labelAInput.value = 'Version A'; labelBInput.value = 'Version B';
        textBase.value = ''; labelBaseInput.value = 'Base';
        currentSavedId = null; lastOps = null; lastOpsBaseA = null; lastOpsBaseB = null;
        diffOutput.style.display = ''; diffOutput.className = 'diff-output';
        diffOutput.innerHTML = '<div class="diff-empty">Paste two versions above and click Compare (or press <span class="shortcut">ctrl</span>+<span class="shortcut">enter</span>).</div>';
        diffPanelsEl.innerHTML = '';
        mergePanelEl.hidden = true; mergeBlocks = []; mergeBlocksEl.innerHTML = ''; mergeOutputEl.value = ''; mergeSummaryEl.textContent = ''; lastMergeSignature = null;
        diffStats.textContent = '';
        lineendingBannerEl.hidden = true; lineendingBannerEl.innerHTML = '';
        jsonFallbackBannerEl.hidden = true; jsonFallbackBannerEl.innerHTML = '';
        largeInputBannerEl.hidden = true; largeInputBannerEl.innerHTML = '';
        renderSavedBar(); saveCurrent();
        if (previewMode) updatePreview();
      });
      $('copy-diff-button').addEventListener('click', async () => {
        if (!lastOps) { flash('Nothing to copy yet -- run Compare first'); return; }
        const text = buildUnifiedText(lastOps, labelAInput.value || 'Version A', labelBInput.value || 'Version B');
        try { await navigator.clipboard.writeText(text); flash('Diff copied'); } catch (e) { flash('Copy failed'); }
      });
      $('download-diff-button').addEventListener('click', () => {
        if (!lastOps) { flash('Nothing to download yet -- run Compare first'); return; }
        const text = buildUnifiedText(lastOps, labelAInput.value || 'Version A', labelBInput.value || 'Version B');
        const slug = s => (s || '').trim().replace(/[^\w.-]+/g, '_').slice(0, 40);
        const filename = [slug(labelAInput.value) || 'a', slug(labelBInput.value) || 'b'].join('_vs_') + '.patch';
        const blob = new Blob([text], { type: 'text/x-patch' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
        flash('Downloaded ' + filename);
      });

      /* ── Three-way (base) mode ───────────────────────────────────── */
      baseToggleEl.addEventListener('click', () => {
        const show = basePaneRowEl.hidden;
        basePaneRowEl.hidden = !show;
        baseToggleEl.classList.toggle('active', show);
        if (!show) { lastOpsBaseA = null; lastOpsBaseB = null; if (lastOps) renderDiff(lastOps); }
        saveCurrent();
      });

      /* ── Paste button per pane ───────────────────────────────────── */
      document.querySelectorAll('[data-paste]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const target = $(btn.dataset.paste);
          try {
            const text = await navigator.clipboard.readText();
            pushUndo();
            target.value = text; target.dispatchEvent(new Event('input'));
            flash('Pasted');
          } catch (e) { flash('Clipboard access denied -- paste manually with ctrl+v'); }
        });
      });

      /* ── Per-pane find -- textareas can't render inline highlight spans
         (no rich markup inside a native <textarea>), so this uses the
         browser's own text selection to indicate the match and scroll it
         into view. setSelectionRange() does both of those without needing
         focus, which lets the search input keep focus so Enter/typing
         keeps working instead of bouncing focus into the textarea. ── */
      function wireTextareaSearch(targetId) {
        const input = document.querySelector(`[data-search-input="${targetId}"]`);
        const countEl = document.querySelector(`[data-search-count="${targetId}"]`);
        const prevBtn = document.querySelector(`[data-search-prev="${targetId}"]`);
        const nextBtn = document.querySelector(`[data-search-next="${targetId}"]`);
        const textarea = $(targetId);
        if (!input || !countEl || !textarea) return;
        let matches = [], current = -1;

        function recompute() {
          matches = [];
          const term = input.value;
          if (!term) return;
          const hay = textarea.value.toLowerCase(), needle = term.toLowerCase();
          let idx = 0;
          while (true) {
            const found = hay.indexOf(needle, idx);
            if (found === -1) break;
            matches.push(found);
            idx = found + needle.length;
          }
        }
        // current === -1 means "matches are known but nothing's been
        // jumped to yet" (right after typing) -- render() shows that as
        // if match 1 were current, but step()'s arithmetic treats it as
        // "before the first match" so the first Enter actually lands on
        // match 1 (not match 2) and the first Shift+Enter lands on the
        // last match (not the second-to-last).
        function render() {
          const shown = matches.length ? Math.max(current, 0) + 1 : 0;
          countEl.textContent = matches.length ? shown + '/' + matches.length : (input.value ? '0/0' : '');
          input.classList.toggle('no-match', !!input.value && matches.length === 0);
        }
        // Browsers don't paint ANY selection indicator on an unfocused
        // textarea -- confirmed against a real (non-headless) render, not
        // just headless -- custom ::selection styling or not, it's simply
        // never drawn. So an actual jump must focus the textarea; typing
        // in the search box must NOT (that would fight every keystroke).
        function jumpTo(i) {
          if (!matches.length) { current = -1; render(); return; }
          current = ((i % matches.length) + matches.length) % matches.length;
          const start = matches[current];
          textarea.focus();
          textarea.setSelectionRange(start, start + input.value.length);
          render();
          armFollowup();
        }
        function step(direction) {
          if (!matches.length) recompute();
          if (!matches.length) { current = -1; render(); return; }
          if (current === -1) jumpTo(direction > 0 ? 0 : matches.length - 1);
          else jumpTo(current + direction);
        }
        // Focus just moved to the textarea, so a bare Enter there would
        // normally insert a newline into the user's text. Intercept the
        // very next keydown: Enter/Shift+Enter continues the search
        // (matching "keep pressing Enter to cycle" from the search box);
        // any other key means they're actually editing, so let it through
        // untouched and stop intercepting.
        let followup = null;
        function armFollowup() {
          if (followup) textarea.removeEventListener('keydown', followup);
          followup = event => {
            if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
            else if (event.key === 'Escape') {
              event.preventDefault();
              input.value = ''; matches = []; current = -1; render();
              textarea.removeEventListener('keydown', followup); followup = null;
              input.focus();
            } else {
              textarea.removeEventListener('keydown', followup); followup = null;
            }
          };
          textarea.addEventListener('keydown', followup);
        }
        input.addEventListener('input', () => {
          recompute();
          current = -1;
          render();
        });
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
          else if (event.key === 'Escape') { event.preventDefault(); input.value = ''; matches = []; current = -1; render(); }
        });
        if (prevBtn) prevBtn.addEventListener('click', () => step(-1));
        if (nextBtn) nextBtn.addEventListener('click', () => step(1));
        // Loading new content (load a saved comparison, drag-drop, undo,
        // swap...) invalidates match offsets computed against old text.
        textarea.addEventListener('input', () => { if (input.value) recompute(); current = Math.min(current, matches.length - 1); render(); });
      }
      ['text-a', 'text-b', 'text-base'].forEach(wireTextareaSearch);

      /* ── Drag-and-drop a file onto a pane ────────────────────────── */
      document.querySelectorAll('.pane[data-pane]').forEach(paneEl => {
        const targetId = { base: 'text-base', a: 'text-a', b: 'text-b' }[paneEl.dataset.pane];
        const target = $(targetId);
        paneEl.addEventListener('dragover', event => { event.preventDefault(); paneEl.classList.add('drag-over'); });
        paneEl.addEventListener('dragleave', event => { if (!paneEl.contains(event.relatedTarget)) paneEl.classList.remove('drag-over'); });
        paneEl.addEventListener('drop', event => {
          event.preventDefault(); paneEl.classList.remove('drag-over');
          const file = event.dataTransfer.files && event.dataTransfer.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => { pushUndo(); target.value = reader.result; target.dispatchEvent(new Event('input')); flash('Loaded ' + file.name); };
          reader.readAsText(file);
        });
      });

      /* ── Fold-bar expand (works for both #diff-output and the 3-way panels) ── */
      document.addEventListener('click', event => {
        const fold = event.target.closest('[data-fold]');
        if (!fold) return;
        const html = foldStore[fold.dataset.fold];
        if (html == null) return;
        fold.insertAdjacentHTML('afterend', html);
        fold.remove();
      });

      /* ── Keyboard hunk navigation (] / [) ────────────────────────── */
      // Scoped to whichever of Text Compare / Folder Compare is actually
      // visible -- otherwise a diff rendered earlier in the other (now
      // hidden) mode still has its own data-hunk rows in the DOM, and could
      // get jumped to/flashed instead of what's on screen.
      function activeModePanel() { return folderModePanelEl.hidden ? textModePanelEl : folderModePanelEl; }
      let hunkIndex = -1;
      function jumpToHunk(direction) {
        const rows = Array.from(activeModePanel().querySelectorAll('.diff-row[data-hunk]'));
        if (!rows.length) { flash('No changes to jump to'); return; }
        hunkIndex = Math.max(0, Math.min(rows.length - 1, hunkIndex + direction));
        const row = rows[hunkIndex];
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // Clear any previous flash (rapid ]/[ presses would otherwise leave
        // more than one row highlighted at once) and force a reflow so
        // re-flashing the SAME row (repeatedly hitting the last hunk)
        // still visibly restarts instead of being a no-op class re-add.
        // The highlight is now sticky -- it stays until dismissHunkFlash()
        // runs (click elsewhere, Escape, or clicking the row itself to
        // copy it), not on a timer, so it doesn't vanish before you've had
        // a chance to actually look at it.
        dismissHunkFlash();
        void row.offsetWidth;
        row.classList.add('hunk-flash');
        flash('Change ' + (hunkIndex + 1) + ' of ' + rows.length);
      }
      function dismissHunkFlash() {
        document.querySelectorAll('.hunk-flash').forEach(r => r.classList.remove('hunk-flash'));
      }

      /* ── Bookmarked changes ──────────────────────────────────────────
         Independent of ]/['s sequential flash -- flag specific changes to
         come back to on a big diff instead of walking through every one.
         Keyed by the row's data-hunk index, so (like fold state and the
         ]/[ position already do) it resets on any re-render: a fresh
         compare, a view-mode switch, or the whitespace toggle. */
      let bookmarkedHunks = new Set(), bookmarkIndex = -1;
      function toggleBookmark(row) {
        if (!row || row.dataset.hunk == null) return;
        const idx = row.dataset.hunk;
        if (bookmarkedHunks.has(idx)) {
          bookmarkedHunks.delete(idx);
          row.classList.remove('hunk-bookmarked');
          flash('Bookmark removed');
        } else {
          bookmarkedHunks.add(idx);
          row.classList.add('hunk-bookmarked');
          flash('Bookmarked (' + bookmarkedHunks.size + ' total)');
        }
      }
      function jumpToBookmark(direction) {
        const rows = Array.from(activeModePanel().querySelectorAll('.diff-row[data-hunk]')).filter(r => bookmarkedHunks.has(r.dataset.hunk));
        if (!rows.length) { flash('No bookmarks yet -- click a change’s line number to flag one'); return; }
        bookmarkIndex = Math.max(0, Math.min(rows.length - 1, bookmarkIndex + direction));
        const row = rows[bookmarkIndex];
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        dismissHunkFlash();
        void row.offsetWidth;
        row.classList.add('hunk-flash');
        flash('Bookmark ' + (bookmarkIndex + 1) + ' of ' + rows.length);
      }
      // Click a changed row's gutter (line number / +- marker) to toggle
      // its bookmark. Capture phase + stopPropagation so this always wins
      // over the bubble-phase fold-expand/flash-dismiss/clipboard-copy
      // handlers just below, which would otherwise also fire for the same
      // click (e.g. clipboard-copying the row's text just because its
      // gutter happened to be inside the currently-flashed row).
      document.addEventListener('click', event => {
        const gutter = event.target.closest('.diff-lineno, .diff-marker');
        if (!gutter) return;
        const row = gutter.closest('.diff-row');
        if (!row || row.dataset.hunk == null) return;
        event.stopPropagation();
        toggleBookmark(row);
      }, true);

      // Clicking the highlighted row copies that specific line (whichever
      // .diff-line the click landed on) and confirms with a toast; clicking
      // ANYWHERE else just dismisses the highlight, same as Escape.
      document.addEventListener('click', event => {
        const flashedRow = activeModePanel().querySelector('.hunk-flash');
        if (!flashedRow) return;
        if (flashedRow.contains(event.target)) {
          const lineEl = event.target.closest('.diff-line') || flashedRow;
          const text = lineEl.textContent;
          navigator.clipboard.writeText(text).then(() => flash('Copied to clipboard')).catch(() => flash('Copy failed'));
        }
        dismissHunkFlash();
      });

      /* ── HTML report -- a standalone, shareable snapshot, deliberately
         light-themed regardless of the page's own theme, since it's
         meant to be saved/printed/forwarded on its own. Reuses the
         exact rendered diff markup (same class names, light-palette CSS)
         rather than re-implementing rendering. ── */
      function openHtmlReport(html) {
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      // The live diff-copy-btn (arrows for shuffling a hunk to the other
      // side) has no app.js to click against in a standalone report --
      // strip it rather than ship a dead control.
      function reportBodyHtml(sourceEl) {
        const clone = sourceEl.cloneNode(true);
        clone.querySelectorAll('.diff-group-actions').forEach(el => el.remove());
        return clone.innerHTML;
      }
      // The report ships its own separate, light-forced copy of the diff
      // CSS (deliberately -- it must render correctly with zero dependency
      // on style.css or the page's current theme). A few of those rules
      // have drifted out of sync with their style.css counterpart before
      // (the .diff-lineno/.diff-marker line-height fix, the .diff-fold
      // size bump) simply because nothing forced a second edit. Rather
      // than hand-copy numbers into two places yet again, read the LAYOUT
      // values (never colors -- those intentionally stay forced-light)
      // straight off an offscreen probe styled by the live style.css, so
      // whatever it currently says is exactly what the report gets, with
      // no separate constant to remember to update.
      function probeComputedStyle(className, props, wrapClassName) {
        const el = document.createElement('div');
        el.className = className;
        let mount = el;
        if (wrapClassName) {
          const wrap = document.createElement('div');
          wrap.className = wrapClassName;
          wrap.appendChild(el);
          mount = wrap;
        }
        mount.style.cssText = 'position:absolute; left:-9999px; top:-9999px; visibility:hidden;';
        document.body.appendChild(mount);
        const cs = getComputedStyle(el);
        const result = {};
        props.forEach(p => { result[p] = cs[p]; });
        document.body.removeChild(mount);
        return result;
      }
      function reportSyncedLayout() {
        const line = probeComputedStyle('diff-line', ['lineHeight']);
        const lineno = probeComputedStyle('diff-lineno', ['lineHeight']);
        const marker = probeComputedStyle('diff-marker', ['lineHeight'], 'diff-unified');
        const fold = probeComputedStyle('diff-fold', ['fontSize', 'padding']);
        return {
          lineLineHeight: line.lineHeight || '1.6',
          linenoLineHeight: lineno.lineHeight || '1.6',
          markerLineHeight: marker.lineHeight || '1.6',
          foldFontSize: fold.fontSize || '14px',
          foldPadding: fold.padding || '10px 14px',
        };
      }
      function buildHtmlReport() {
        if (!lastOps) return null;
        const layout = reportSyncedLayout();
        const labelA = labelAInput.value || 'Version A', labelB = labelBInput.value || 'Version B';
        // Same "current saved tab wins" precedence as the download filename
        // -- the tab name is what someone renaming a tab expects to see
        // identifying the report, with the A/B labels as the detail line.
        const savedItem = currentSavedId ? saved.find(s => s.id === currentSavedId) : null;
        const reportTitle = savedItem ? savedItem.name : (labelA + ' vs ' + labelB);
        const added = lastOps.filter(o => o.type === 'add').length;
        const removed = lastOps.filter(o => o.type === 'del').length;
        const unchanged = lastOps.filter(o => o.type === 'equal').length;
        const inBase = baseModeActive();
        const bodyHtml = inBase ? reportBodyHtml(diffPanelsEl) : reportBodyHtml(diffOutput);
        const unifiedClass = viewMode === 'unified' ? ' diff-unified' : '';
        const generatedAt = new Date().toLocaleString();
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Delta Diff Report - ${esc(reportTitle)}</title>
<style>
  body { margin:0; padding:32px 16px; background:#eef0f2; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; color:#222; }
  .report { max-width:960px; margin:0 auto; background:#ffffff; border:1px solid #e2e2e2; border-radius:8px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.08); }
  .banner { background:#2e7d32; color:#ffffff; padding:26px 32px; }
  .banner-label { font-size:12px; letter-spacing:1px; text-transform:uppercase; opacity:.85; margin-bottom:6px; }
  .banner-verdict { font-size:22px; font-weight:800; letter-spacing:.2px; }
  .banner-sub { margin-top:4px; font-size:13px; opacity:.85; }
  .banner-stats { margin-top:10px; font-size:13px; }
  .banner-stats .add { color:#c8f5d4; font-weight:700; } .banner-stats .del { color:#ffd2cc; font-weight:700; }
  .section { padding:22px 32px; border-top:1px solid #eee; }
  .footer { padding:18px 32px; background:#fafafa; border-top:1px solid #eee; font-size:11px; color:#999; display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; }
  .diff-output { border:1px solid #ddd; border-radius:7px; background:#fafafa; font-family:ui-monospace,Consolas,'Liberation Mono',Menlo,monospace; font-size:12.5px; }
  .diff-panel { margin-bottom:20px; } .diff-panel:last-child { margin-bottom:0; }
  .diff-panel-title { font-size:12px; font-weight:700; margin-bottom:6px; color:#555; }
  .diff-row { display:flex; }
  .diff-half { flex:0 0 50%; width:50%; display:flex; align-items:flex-start; min-width:0; }
  .diff-half + .diff-half { border-left:1px solid #ddd; }
  .diff-lineno { flex:0 0 42px; text-align:right; padding:2px 8px; color:#999; font-size:11px; user-select:none; align-self:stretch; line-height:${layout.linenoLineHeight}; }
  .diff-line { flex:1; min-width:0; padding:2px 10px; white-space:pre-wrap; word-break:break-word; line-height:${layout.lineLineHeight}; }
  .diff-half.del { background:#fdecea; } .diff-half.add { background:#eafaf1; }
  .diff-half.empty { background:repeating-linear-gradient(135deg, transparent, transparent 7px, #e2e2e2 7px, #e2e2e2 8px); }
  .diff-ignored-text { opacity:.6; font-style:italic; }
  .diff-word-add { background:#b7ebc6; border-radius:2px; } .diff-word-del { background:#f6c6c0; border-radius:2px; text-decoration:line-through; }
  .tok-comment, .tok-prolog, .tok-doctype, .tok-cdata { color:#6b716c; font-style:italic; }
  .tok-string, .tok-char, .tok-attr-value, .tok-regex, .tok-url { color:#0e7c86; }
  .tok-keyword, .tok-atrule, .tok-important { color:#7139b0; }
  .tok-number, .tok-boolean, .tok-constant, .tok-symbol { color:#b3620c; }
  .tok-function, .tok-class-name, .tok-tag, .tok-attr-name, .tok-selector, .tok-property, .tok-namespace { color:#af3a7f; }
  .diff-unified .diff-marker { flex:0 0 20px; text-align:center; color:#999; padding:2px 0; user-select:none; line-height:${layout.markerLineHeight}; }
  .diff-unified .diff-row.del { background:#fdecea; } .diff-unified .diff-row.add { background:#eafaf1; }
  .diff-unified .diff-row.del .diff-marker { color:#c0392b; } .diff-unified .diff-row.add .diff-marker { color:#2e7d32; }
  .diff-unified .diff-lineno { flex:0 0 52px; }
  .diff-fold { padding:${layout.foldPadding}; text-align:center; color:#888; font-size:${layout.foldFontSize}; background:#f0f0f0; }
  .diff-empty { padding:30px 16px; text-align:center; color:#888; font-size:12px; }
  @media print { body { background:#fff; padding:0; } .report { box-shadow:none; border:none; max-width:100%; } }
</style>
</head>
<body>
  <div class="report">
    <div class="banner">
      <div class="banner-label">Delta</div>
      <div class="banner-verdict">${esc(reportTitle)}</div>
      ${savedItem ? `<div class="banner-sub">${esc(labelA)} &rarr; ${esc(labelB)}</div>` : ''}
      <div class="banner-stats"><span class="add">+${added}</span> &nbsp; <span class="del">-${removed}</span> &nbsp; ${unchanged} unchanged</div>
    </div>
    <div class="section">
      <div class="diff-output${unifiedClass}">${bodyHtml}</div>
    </div>
    <div class="footer">
      <span>Generated ${esc(generatedAt)} by Delta</span>
    </div>
  </div>
</body>
</html>`;
      }
      $('html-report-button').addEventListener('click', () => {
        const html = buildHtmlReport();
        if (html == null) { flash('Nothing to report yet -- run Compare first'); return; }
        openHtmlReport(html);
      });
      $('html-report-download-button').addEventListener('click', () => {
        const html = buildHtmlReport();
        if (html == null) { flash('Nothing to report yet -- run Compare first'); return; }
        const slug = s => (s || '').trim().replace(/[^\w.-]+/g, '_').slice(0, 40);
        // Prefer the current saved tab's name (what someone renaming a tab
        // actually expects the file to be called) over the A/B labels,
        // which are a separate, unrelated field.
        const savedItem = currentSavedId ? saved.find(s => s.id === currentSavedId) : null;
        const filename = (savedItem ? slug(savedItem.name) : null)
          || [slug(labelAInput.value) || 'a', slug(labelBInput.value) || 'b'].join('_vs_') || 'delta-diff';
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = filename + '.html'; link.click(); URL.revokeObjectURL(url);
        flash('Downloaded ' + filename + '.html');
      });

      /* ── Share link ───────────────────────────────────────────────── */
      $('share-button').addEventListener('click', async () => {
        try {
          const payload = {
            textA: textA.value, textB: textB.value, labelA: labelAInput.value, labelB: labelBInput.value,
            textBase: baseModeActive() ? textBase.value : '', labelBase: labelBaseInput.value,
          };
          const encoded = await encodeShareData(payload);
          const url = location.origin + location.pathname + '#d=' + encoded;
          if (encoded.length > 60000) flash('Warning: this comparison is large -- the link may not work everywhere');
          await navigator.clipboard.writeText(url);
          flash('Share link copied (' + Math.round(encoded.length / 1024 * 10) / 10 + ' KB)');
        } catch (e) { flash('Could not build share link'); }
      });

      /* ── Export / Import (of the saved-comparisons list) ─────────── */
      $('export-button').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = `delta-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
        flash('Exported');
      });
      const importFile = $('import-file');
      $('import-button').addEventListener('click', () => importFile.click());
      importFile.addEventListener('change', () => {
        const file = importFile.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const incoming = JSON.parse(reader.result);
            if (!Array.isArray(incoming) || !incoming.every(i => i && typeof i.id === 'string' && typeof i.name === 'string' && typeof i.textA === 'string' && typeof i.textB === 'string')) throw Error();
            if (saved.length && !confirm(`This will replace your ${saved.length} existing saved comparison(s) with the ${incoming.length} from this file. This cannot be undone. Continue?`)) return;
            saved = incoming; currentSavedId = null; saveSaved(); renderSavedBar(); saveCurrent();
            flash('Imported ' + incoming.length + ' comparison(s)');
          } catch { flash('That JSON is not a Delta export'); }
          finally { importFile.value = ''; }
        };
        reader.readAsText(file);
      });

      /* ── Text size (panes + diff output) ─────────────────────────────── */
      const FONT_SIZE_KEY = 'delta_font_size', FONT_SIZE_MIN = 10, FONT_SIZE_MAX = 21, FONT_SIZE_STEP = 1;
      const fontSizeDownBtn = $('font-size-down'), fontSizeUpBtn = $('font-size-up');
      function currentFontSize() {
        const stored = parseFloat(localStorage.getItem(FONT_SIZE_KEY));
        return Number.isFinite(stored) ? stored : 12.5;
      }
      function applyFontSize(px) {
        const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, px));
        document.documentElement.style.setProperty('--code-font-size', clamped + 'px');
        localStorage.setItem(FONT_SIZE_KEY, String(clamped));
        fontSizeDownBtn.disabled = clamped <= FONT_SIZE_MIN;
        fontSizeUpBtn.disabled = clamped >= FONT_SIZE_MAX;
        return clamped;
      }
      applyFontSize(currentFontSize());
      renderIgnorePatternChips();
      updateIgnorePatternCount();
      fontSizeDownBtn.addEventListener('click', () => applyFontSize(currentFontSize() - FONT_SIZE_STEP));
      fontSizeUpBtn.addEventListener('click', () => applyFontSize(currentFontSize() + FONT_SIZE_STEP));

      /* ── Theme / About ─────────────────────────────────────────────── */
      // Same four themes as Kard. With no attribute set the stylesheet follows prefers-color-scheme,
      // so "system" is a real choice rather than an unlabeled default; "vegas" is an opt-in neon look.
      const THEMES = ['system', 'light', 'dark', 'vegas'];
      let themeMode = 'system';
      function applyTheme(mode) {
        themeMode = THEMES.includes(mode) ? mode : 'system';
        if (themeMode === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = themeMode;
        const button = $('theme-toggle');
        button.textContent = `Theme: ${themeMode === 'system' ? 'sys' : themeMode}`;
        button.setAttribute('aria-label', `Color theme: ${themeMode}. Click to cycle system, light, dark, vegas.`);
        // Keeps mobile browser chrome in step with the page.
        let meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
        meta.content = getComputedStyle(document.body).backgroundColor || '#101311';
      }
      $('theme-toggle').addEventListener('click', () => {
        // Cycles from the applied mode rather than re-reading storage, which may be blocked.
        const next = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length];
        applyTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch {} flash(`Theme: ${next}`);
      });
      // A theme picked in another tab applies here too (the storage event only fires in other tabs).
      window.addEventListener('storage', event => { if (event.key === THEME_KEY) applyTheme(event.newValue); });
      const aboutDialog = $('about-dialog');
      function openAbout() { aboutDialog.showModal(); }
      $('about-button').addEventListener('click', openAbout);
      $('about-button-2').addEventListener('click', openAbout);
      $('about-close-button').addEventListener('click', () => aboutDialog.close());
      aboutDialog.addEventListener('click', event => { if (event.target === aboutDialog) aboutDialog.close(); });

      /* ── Autosave current pair as you type ───────────────────────── */
      [textA, textB, labelAInput, labelBInput].forEach(el => el.addEventListener('input', () => { saveCurrent(); scheduleLiveCompare(); if (previewMode) updatePreview(); }));
      // The Base pane isn't part of the autosaved "current" pair, but its
      // line/char count should still update live as you type in it.
      textBase.addEventListener('input', updateAllPaneStats);

      /* ── Undo coverage for regular typing / native ctrl+v paste, not
         just the dedicated Paste/drag-drop/Swap/Clear/Load actions.
         Checkpoints once per focus session (before the first edit in it),
         same pattern kard itself uses for its note fields -- not on every
         keystroke, but still catches "select-all, paste over it, oops". ── */
      let fieldEditCheckpointed = false;
      function checkpointOnFieldFocus() {
        if (!fieldEditCheckpointed) { pushUndo(); fieldEditCheckpointed = true; }
      }
      [textA, textB, labelAInput, labelBInput, textBase, labelBaseInput].forEach(el => {
        el.addEventListener('focus', checkpointOnFieldFocus);
        el.addEventListener('blur', () => { fieldEditCheckpointed = false; });
      });

      /* ── Persist drag-resized pane height across reloads. Both panes
         share one saved height (resizing either updates both, so they
         stay visually aligned) -- each observer only writes when the
         height actually differs, so the two observers can't feed back
         into an infinite loop. ── */
      const PANE_HEIGHT_KEY = 'delta_pane_height';
      const savedHeight = localStorage.getItem(PANE_HEIGHT_KEY);
      if (savedHeight) { textA.style.height = savedHeight; textB.style.height = savedHeight; }
      let resizeSaveTimer;
      function onPaneResize(entry) {
        const h = entry.target.style.height;
        if (!h) return;
        clearTimeout(resizeSaveTimer);
        resizeSaveTimer = setTimeout(() => {
          localStorage.setItem(PANE_HEIGHT_KEY, h);
          if (textA.style.height !== h) textA.style.height = h;
          if (textB.style.height !== h) textB.style.height = h;
        }, 300);
      }
      const resizeObserver = new ResizeObserver(entries => entries.forEach(onPaneResize));
      resizeObserver.observe(textA);
      resizeObserver.observe(textB);

      /* ── Same drag-resize persistence for the HTML/Markdown preview
         panes -- previewing rendered HTML in a short fixed box is hard to
         read, so let it grow just like the input panes do. ── */
      const PREVIEW_HEIGHT_KEY = 'delta_preview_height';
      const savedPreviewHeight = localStorage.getItem(PREVIEW_HEIGHT_KEY);
      if (savedPreviewHeight) { previewBodyA.style.height = savedPreviewHeight; previewBodyB.style.height = savedPreviewHeight; }
      let previewResizeSaveTimer;
      function onPreviewResize(entry) {
        const h = entry.target.style.height;
        if (!h) return;
        clearTimeout(previewResizeSaveTimer);
        previewResizeSaveTimer = setTimeout(() => {
          localStorage.setItem(PREVIEW_HEIGHT_KEY, h);
          if (previewBodyA.style.height !== h) previewBodyA.style.height = h;
          if (previewBodyB.style.height !== h) previewBodyB.style.height = h;
        }, 300);
      }
      const previewResizeObserver = new ResizeObserver(entries => entries.forEach(onPreviewResize));
      previewResizeObserver.observe(previewBodyA);
      previewResizeObserver.observe(previewBodyB);

      /* ── Keyboard shortcuts ───────────────────────────────────────── */
      document.addEventListener('keydown', event => {
        if (aboutDialog.open) return;
        const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runCompare(); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveOrUpdate(); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey && !inField) { event.preventDefault(); undoButtonEl.click(); }
        else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z')) && !inField) { event.preventDefault(); redoButtonEl.click(); }
        else if (event.key === ']' && !inField) { event.preventDefault(); jumpToHunk(1); }
        else if (event.key === '[' && !inField) { event.preventDefault(); jumpToHunk(-1); }
        // Copies the flashed hunk in the arrow's direction (Alt+Right =
        // same as clicking ->, Alt+Left = same as clicking <-), so ]/[ to
        // select a change plus this needs no mouse. Only wired where a
        // flashed row actually has a .diff-group (Split-view text
        // compare) -- a plain context row, a Unified-view row, or nothing
        // flashed at all just gets a hint instead of silently no-op'ing.
        else if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !inField) {
          event.preventDefault();
          const flashedRow = activeModePanel().querySelector('.hunk-flash');
          if (!flashedRow) { flash('Press ] or [ to select a change first'); return; }
          const groupEl = flashedRow.closest('.diff-group');
          if (!groupEl) { flash('This change can’t be copied (Split view only)'); return; }
          copyHunkGroup(groupEl, event.key === 'ArrowRight' ? 'a-to-b' : 'b-to-a');
        }
        // Toggles the bookmark on whichever row ]/[ currently has flashed
        // -- same target the click-the-gutter path uses, just keyboard-only.
        else if (event.key.toLowerCase() === 'b' && !inField) {
          const flashedRow = activeModePanel().querySelector('.hunk-flash');
          if (!flashedRow) { flash('Press ] or [ to select a change first'); return; }
          event.preventDefault();
          toggleBookmark(flashedRow);
        }
        else if (event.key === '}' && !inField) { event.preventDefault(); jumpToBookmark(1); }
        else if (event.key === '{' && !inField) { event.preventDefault(); jumpToBookmark(-1); }
        else if (event.key === 'Escape' && document.querySelector('.hunk-flash')) { dismissHunkFlash(); }
      });

      /* ── Mode toggle (Text Compare / Folder Compare) ─────────────── */
      const textModePanelEl = $('text-mode-panel'), folderModePanelEl = $('folder-mode-panel');
      document.querySelectorAll('[data-app-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('[data-app-mode]').forEach(b => b.classList.toggle('active', b === btn));
          const mode = btn.dataset.appMode;
          textModePanelEl.hidden = mode !== 'text';
          folderModePanelEl.hidden = mode !== 'folder';
        });
      });

      /* ── Folder compare ───────────────────────────────────────────
         Reads two folders via <input webkitdirectory> (no server, no
         upload -- files never leave the browser), matches entries by
         their path relative to each folder's own root, and classifies
         each as added/removed/modified/unchanged. Content equality is
         decided with SHA-256 (Web Crypto, already in every browser --
         no need to pull in a hashing library) rather than string
         equality, since files are read as bytes so this also works for
         images/binaries, not just text. Modified text files reuse the
         exact same diff engine/renderer as the main text-compare view;
         modified images get a pixel-level canvas diff; anything else
         just reports the size change. */
      const FOLDER_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico']);
      const FOLDER_TEXT_EXTS = new Set([
        'txt', 'md', 'markdown', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'html', 'htm',
        'css', 'scss', 'sass', 'less', 'xml', 'yml', 'yaml', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf',
        'toml', 'py', 'rb', 'php', 'java', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'go', 'rs', 'sh', 'bash',
        'zsh', 'ps1', 'sql', 'env', 'gitignore', 'gitattributes', 'editorconfig', 'vue', 'svelte',
        'graphql', 'proto', 'dockerfile', 'makefile', 'r', 'pl', 'lua', 'swift', 'kt', 'kts', 'scala', 'dart',
      ]);
      function folderFileKind(path) {
        const base = path.split('/').pop();
        const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : base.toLowerCase();
        if (FOLDER_IMAGE_EXTS.has(ext)) return 'image';
        if (FOLDER_TEXT_EXTS.has(ext)) return 'text';
        return 'binary';
      }
      function formatBytes(n) {
        if (n == null) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
      }
      async function sha256Hex(buf) {
        const digest = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
      function buildFolderMap(fileList) {
        const map = new Map();
        let rootName = '';
        for (const file of fileList) {
          const rel = file.webkitRelativePath || file.name;
          const slash = rel.indexOf('/');
          if (slash === -1) { map.set(rel, file); continue; }
          if (!rootName) rootName = rel.slice(0, slash);
          map.set(rel.slice(slash + 1), file);
        }
        return { rootName: rootName || '(folder)', map };
      }

      let folderA = null, folderB = null;
      let folderDiffEntries = [];
      let folderDiffFilter = 'all';
      let folderSearchTerm = '';
      const folderInputA = $('folder-input-a'), folderInputB = $('folder-input-b');
      const folderCompareButton = $('folder-compare-button');
      const folderDiffListEl = $('folder-diff-list'), folderFilterRowEl = $('folder-filter-row'), folderSummaryEl = $('folder-diff-summary');

      // Chromium's File System Access API gives a "this site wants to view
      // files in ⟨folder⟩" permission prompt -- accurate, and read-only via
      // mode:'read'. The <input webkitdirectory> fallback (Firefox, Safari)
      // has to go through the browser's generic file-upload picker/warning
      // even though nothing is ever sent anywhere; there's no way to change
      // that dialog's wording from the page, so it's only used when the
      // nicer API isn't available.
      async function pickFolder(side) {
        if (window.showDirectoryPicker) {
          try {
            const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            const info = await readDirectoryHandle(dirHandle);
            if (side === 'a') folderA = info; else folderB = info;
            renderFolderPickInfo(side);
            folderCompareButton.disabled = !(folderA && folderB);
          } catch (e) {
            if (e.name !== 'AbortError') flash('Could not read that folder');
          }
          return;
        }
        (side === 'a' ? folderInputA : folderInputB).click();
      }
      async function readDirectoryHandle(dirHandle) {
        const map = new Map();
        async function walk(handle, prefix) {
          for await (const [name, entryHandle] of handle.entries()) {
            const relPath = prefix ? prefix + '/' + name : name;
            if (entryHandle.kind === 'file') map.set(relPath, await entryHandle.getFile());
            else if (entryHandle.kind === 'directory') await walk(entryHandle, relPath);
          }
        }
        await walk(dirHandle, '');
        return { rootName: dirHandle.name, map };
      }
      $('folder-pick-a').addEventListener('click', () => pickFolder('a'));
      $('folder-pick-b').addEventListener('click', () => pickFolder('b'));
      folderInputA.addEventListener('change', () => onFolderPicked('a'));
      folderInputB.addEventListener('change', () => onFolderPicked('b'));

      function renderFolderPickInfo(side) {
        const info = side === 'a' ? folderA : folderB;
        const infoEl = $('folder-info-' + side);
        if (info) {
          infoEl.textContent = `${info.rootName} - ${info.map.size.toLocaleString()} file${info.map.size === 1 ? '' : 's'}`;
          infoEl.classList.add('picked');
        } else {
          infoEl.textContent = 'No folder selected';
          infoEl.classList.remove('picked');
        }
      }
      function onFolderPicked(side) {
        const input = side === 'a' ? folderInputA : folderInputB;
        if (!input.files.length) return;
        const info = buildFolderMap(input.files);
        if (side === 'a') folderA = info; else folderB = info;
        renderFolderPickInfo(side);
        folderCompareButton.disabled = !(folderA && folderB);
      }
      $('folder-swap-button').addEventListener('click', () => {
        [folderA, folderB] = [folderB, folderA];
        renderFolderPickInfo('a'); renderFolderPickInfo('b');
        if (folderDiffEntries.length) runFolderCompare();
      });

      async function diffOneFolderEntry(path, fileA, fileB) {
        const kind = folderFileKind(path);
        if (!fileA) return { path, status: 'added', kind, sizeA: null, sizeB: fileB.size, fileA: null, fileB };
        if (!fileB) return { path, status: 'removed', kind, sizeA: fileA.size, sizeB: null, fileA, fileB: null };
        let status;
        if (fileA.size !== fileB.size) {
          status = 'modified';
        } else {
          try {
            const [bufA, bufB] = await Promise.all([fileA.arrayBuffer(), fileB.arrayBuffer()]);
            const [hashA, hashB] = await Promise.all([sha256Hex(bufA), sha256Hex(bufB)]);
            status = hashA === hashB ? 'unchanged' : 'modified';
          } catch (e) { status = 'modified'; }
        }
        return { path, status, kind, sizeA: fileA.size, sizeB: fileB.size, fileA, fileB };
      }

      async function runFolderCompare() {
        if (!folderA || !folderB) return;
        collapseExpandedFolderRow(); // revoke any open image-diff object URLs before this DOM is discarded
        folderDiffListEl.innerHTML = '<div class="folder-diff-progress">Comparing folders…</div>';
        folderFilterRowEl.hidden = true;
        folderSummaryEl.textContent = '';

        const sortedPaths = Array.from(new Set([...folderA.map.keys(), ...folderB.map.keys()])).sort((x, y) => x.localeCompare(y));
        const entries = new Array(sortedPaths.length);
        const CONCURRENCY = 16;
        let cursor = 0;
        async function worker() {
          while (cursor < sortedPaths.length) {
            const i = cursor++;
            const path = sortedPaths[i];
            entries[i] = await diffOneFolderEntry(path, folderA.map.get(path), folderB.map.get(path));
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sortedPaths.length) || 1 }, worker));

        entries.forEach((e, i) => { e.idx = i; });
        folderDiffEntries = entries;
        renderFolderSummary();
        folderFilterRowEl.hidden = false;
        renderFolderDiffList();
      }
      folderCompareButton.addEventListener('click', runFolderCompare);

      function renderFolderSummary() {
        const added = folderDiffEntries.filter(e => e.status === 'added').length;
        const removed = folderDiffEntries.filter(e => e.status === 'removed').length;
        const modified = folderDiffEntries.filter(e => e.status === 'modified').length;
        const unchanged = folderDiffEntries.filter(e => e.status === 'unchanged').length;
        folderSummaryEl.innerHTML = `<span class="fd-added">+${added} added</span> · <span class="fd-removed">−${removed} removed</span> · <span class="fd-modified">${modified} modified</span> · ${unchanged} unchanged`;
      }

      document.querySelectorAll('[data-folder-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('[data-folder-filter]').forEach(b => b.classList.toggle('active', b === btn));
          folderDiffFilter = btn.dataset.folderFilter;
          renderFolderDiffList();
        });
      });
      $('folder-search').addEventListener('input', () => {
        folderSearchTerm = $('folder-search').value.trim().toLowerCase();
        renderFolderDiffList();
      });

      const FOLDER_STATUS_GLYPH = { added: '+', removed: '−', modified: '~', unchanged: '=' };
      function renderFolderDiffList() {
        collapseExpandedFolderRow(); // revoke any open image-diff object URLs before the DOM under them is discarded
        const filtered = folderDiffEntries.filter(e => {
          if (folderDiffFilter !== 'all' && e.status !== folderDiffFilter) return false;
          if (folderSearchTerm && !e.path.toLowerCase().includes(folderSearchTerm)) return false;
          return true;
        });
        if (!filtered.length) { folderDiffListEl.innerHTML = '<div class="folder-diff-progress">No files match.</div>'; return; }
        folderDiffListEl.innerHTML = filtered.map(e => {
          const meta = e.status === 'added' ? formatBytes(e.sizeB)
            : e.status === 'removed' ? formatBytes(e.sizeA)
            : e.status === 'modified' ? `${formatBytes(e.sizeA)} → ${formatBytes(e.sizeB)}`
            : formatBytes(e.sizeA);
          return `<div class="folder-diff-row" data-status="${e.status}" data-idx="${e.idx}" tabindex="0" role="button" aria-expanded="false">
            <span class="folder-diff-row-status">${FOLDER_STATUS_GLYPH[e.status]}</span>
            <span class="folder-diff-row-path">${esc(e.path)}</span>
            <span class="folder-diff-row-meta">${meta}</span>
            <span class="folder-diff-row-caret">▶</span>
          </div>`;
        }).join('');
      }

      function collapseExpandedFolderRow() {
        const openRow = document.querySelector('.folder-diff-row.expanded');
        if (!openRow) return;
        openRow.classList.remove('expanded');
        openRow.setAttribute('aria-expanded', 'false');
        const detail = openRow.nextElementSibling;
        if (detail && detail.classList.contains('folder-diff-row-detail')) {
          (detail._objectUrls || []).forEach(u => URL.revokeObjectURL(u));
          detail.remove();
        }
      }
      async function toggleFolderRow(row) {
        const wasExpanded = row.classList.contains('expanded');
        collapseExpandedFolderRow();
        if (wasExpanded) return;
        row.classList.add('expanded');
        row.setAttribute('aria-expanded', 'true');
        const detail = document.createElement('div');
        detail.className = 'folder-diff-row-detail';
        detail.innerHTML = '<div class="folder-diff-row-detail-empty">Loading…</div>';
        row.after(detail);
        await renderFolderEntryDetail(folderDiffEntries[Number(row.dataset.idx)], detail);
      }
      folderDiffListEl.addEventListener('click', event => {
        const row = event.target.closest('.folder-diff-row');
        if (!row) return;
        toggleFolderRow(row);
      });
      // Rows are focusable divs (role="button"), not real <button>s (a <button>
      // can't contain the detail panel as a sibling the same way without
      // fighting default button styling/behavior) -- so Enter/Space have to be
      // wired up by hand instead of coming for free.
      folderDiffListEl.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('.folder-diff-row');
        if (!row) return;
        event.preventDefault();
        toggleFolderRow(row);
      });

      async function renderFolderEntryDetail(entry, container) {
        if (entry.status === 'added' || entry.status === 'removed') {
          const only = entry.status === 'added' ? 'B' : 'A';
          const size = entry.status === 'added' ? entry.sizeB : entry.sizeA;
          container.innerHTML = `<div class="folder-diff-row-detail-empty">Only present in Folder ${only} (${formatBytes(size)}).</div>`;
          return;
        }
        if (entry.status === 'unchanged') {
          container.innerHTML = '<div class="folder-diff-row-detail-empty">Files are identical.</div>';
          return;
        }
        if (entry.kind === 'text') {
          try {
            const [textAContent, textBContent] = await Promise.all([entry.fileA.text(), entry.fileB.text()]);
            const rawX = textAContent.replace(/\r\n/g, '\n').split('\n');
            const rawY = textBContent.replace(/\r\n/g, '\n').split('\n');
            const ops = diffLinesDisplay(rawX, rawY, rawX, rawY);
            const outputEl = document.createElement('div');
            container.innerHTML = '';
            container.appendChild(outputEl);
            renderDiffSection(ops, outputEl);
          } catch (e) {
            container.innerHTML = '<div class="folder-diff-row-detail-empty">Could not read file contents for comparison.</div>';
          }
          return;
        }
        if (entry.kind === 'image') {
          await renderFolderImageDetail(entry, container);
          return;
        }
        container.innerHTML = `<div class="folder-diff-row-detail-empty">Binary file changed - ${formatBytes(entry.sizeA)} → ${formatBytes(entry.sizeB)}.</div>`;
      }

      function loadImageEl(url) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = url;
        });
      }
      async function renderFolderImageDetail(entry, container) {
        container.innerHTML = `
          <div class="folder-image-diff">
            <div class="folder-image-diff-cell"><h4>Folder A</h4><img id="fd-img-a"></div>
            <div class="folder-image-diff-cell"><h4>Folder B</h4><img id="fd-img-b"></div>
            <div class="folder-image-diff-cell"><h4>Difference</h4><canvas id="fd-img-diff"></canvas></div>
          </div>`;
        const urlA = URL.createObjectURL(entry.fileA);
        const urlB = URL.createObjectURL(entry.fileB);
        container._objectUrls = [urlA, urlB];
        container.querySelector('#fd-img-a').src = urlA;
        container.querySelector('#fd-img-b').src = urlB;
        try {
          const [imgA, imgB] = await Promise.all([loadImageEl(urlA), loadImageEl(urlB)]);
          const canvas = container.querySelector('#fd-img-diff');
          if (imgA.naturalWidth !== imgB.naturalWidth || imgA.naturalHeight !== imgB.naturalHeight) {
            canvas.replaceWith(document.createTextNode(`Dimensions differ: ${imgA.naturalWidth}×${imgA.naturalHeight} vs ${imgB.naturalWidth}×${imgB.naturalHeight}`));
            return;
          }
          canvas.width = imgA.naturalWidth; canvas.height = imgA.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(imgA, 0, 0);
          const dataA = ctx.getImageData(0, 0, canvas.width, canvas.height);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(imgB, 0, 0);
          const dataB = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const out = ctx.createImageData(canvas.width, canvas.height);
          let diffPixels = 0;
          for (let p = 0; p < dataA.data.length; p += 4) {
            const delta = Math.abs(dataA.data[p] - dataB.data[p]) + Math.abs(dataA.data[p + 1] - dataB.data[p + 1])
              + Math.abs(dataA.data[p + 2] - dataB.data[p + 2]) + Math.abs(dataA.data[p + 3] - dataB.data[p + 3]);
            if (delta > 12) {
              out.data[p] = 255; out.data[p + 1] = 40; out.data[p + 2] = 40; out.data[p + 3] = 255;
              diffPixels++;
            } else {
              out.data[p] = dataB.data[p]; out.data[p + 1] = dataB.data[p + 1]; out.data[p + 2] = dataB.data[p + 2]; out.data[p + 3] = 60;
            }
          }
          ctx.putImageData(out, 0, 0);
          const pct = ((diffPixels / (canvas.width * canvas.height)) * 100).toFixed(1);
          const note = document.createElement('div');
          note.className = 'folder-diff-row-detail-empty';
          note.textContent = `${pct}% of pixels differ (highlighted in red).`;
          container.appendChild(note);
        } catch (e) {
          const note = document.createElement('div');
          note.className = 'folder-diff-row-detail-empty';
          note.textContent = 'Could not load one or both images for pixel comparison.';
          container.appendChild(note);
        }
      }

      /* ── Boot ─────────────────────────────────────────────────────── */
      let initialTheme = null; try { initialTheme = localStorage.getItem(THEME_KEY); } catch {}
      applyTheme(initialTheme);

      async function boot() {
        const hashMatch = location.hash.match(/[#&]d=([^&]+)/);
        if (hashMatch) {
          try {
            const payload = await decodeShareData(decodeURIComponent(hashMatch[1]));
            textA.value = payload.textA || ''; textB.value = payload.textB || '';
            labelAInput.value = payload.labelA || 'Version A'; labelBInput.value = payload.labelB || 'Version B';
            if (payload.textBase) { textBase.value = payload.textBase; labelBaseInput.value = payload.labelBase || 'Base'; basePaneRowEl.hidden = false; baseToggleEl.classList.add('active'); }
            flash('Loaded comparison from shared link');
            renderSavedBar();
            runCompare();
            return;
          } catch (e) { flash('That share link could not be read'); }
        }
        const current = loadCurrent();
        if (current) {
          textA.value = current.textA || ''; textB.value = current.textB || '';
          labelAInput.value = current.labelA || 'Version A'; labelBInput.value = current.labelB || 'Version B';
          currentSavedId = current.currentSavedId || null;
          if (current.textBase) textBase.value = current.textBase;
          if (current.labelBase) labelBaseInput.value = current.labelBase;
          if (current.baseShown) { basePaneRowEl.hidden = false; baseToggleEl.classList.add('active'); }
        }
        renderSavedBar();
        if ((textA.value && textB.value) || currentSavedId) runCompare();
      }
      boot();
    })();
