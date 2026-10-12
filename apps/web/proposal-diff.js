(function (root, factory) {
  "use strict";
  const diff = factory();
  if (typeof module === "object" && module.exports) module.exports = diff;
  else root.VeyraProposalDiff = diff;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // shortcut: bounded LCS and DOM rows; larger reviews use complete sources, never a partial patch.
  const MAX_CHARACTERS = 100000, MAX_CELLS = 250000, MAX_CHANGES = 400, MAX_ROWS = 600, CONTEXT = 3;

  function splitLines(source) {
    const lines = [];
    let start = 0;
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== "\r" && source[i] !== "\n") continue;
      if (source[i] === "\r" && source[i + 1] === "\n") i++;
      lines.push(source.slice(start, i + 1));
      start = i + 1;
    }
    if (start < source.length) lines.push(source.slice(start));
    return lines;
  }

  function lineDetails(raw) {
    const ending = raw.endsWith("\r\n") ? "CRLF" : raw.endsWith("\r") ? "CR" : raw.endsWith("\n") ? "LF" : "none";
    return { text: raw.slice(0, raw.length - (ending === "CRLF" ? 2 : ending === "none" ? 0 : 1)), ending };
  }

  function sourceDetails(lines) {
    const endings = { LF: 0, CRLF: 0, CR: 0 };
    for (const line of lines) {
      const { ending } = lineDetails(line);
      if (ending !== "none") endings[ending]++;
    }
    return { lines: lines.length, endings, finalNewline: lines.length ? lineDetails(lines.at(-1)).ending !== "none" : null };
  }

  function visibleWhitespace(text) {
    return text.replace(/[^\S\r\n]/gu, (char) => char === " " ? "·" : char === "\t" ? "⇥" :
      `⟦U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟧`);
  }

  function compare(before, after) {
    if (typeof before !== "string" || typeof after !== "string") throw new TypeError("Compare source strings only.");
    const a = splitLines(before), b = splitLines(after);
    const result = { mode: "diff", reason: "", rows: [], added: 0, removed: 0,
      before: sourceDetails(a), after: sourceDetails(b),
      whitespaceOnly: before !== after && before.replace(/\s/gu, "") === after.replace(/\s/gu, "") };
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
    function fallback(reason, countsKnown = false) {
      return { ...result, mode: "full", reason, rows: [], countsExact: countsKnown,
        added: countsKnown ? result.added : m, removed: countsKnown ? result.removed : n };
    }
    if (before.length > MAX_CHARACTERS || after.length > MAX_CHARACTERS) return fallback("Source exceeds the 100,000-character diff limit.");
    if ((n + 1) * (m + 1) > MAX_CELLS) return fallback("The changed region is too large for a bounded line comparison.");
    if (Math.abs(n - m) > MAX_CHANGES) return fallback("The replacement is too dense for the compact review.");

    // Intern exact lines once so each matrix comparison is constant-size, even for long repeated lines.
    const ids = new Map();
    const token = (line) => { if (!ids.has(line)) ids.set(line, ids.size); return ids.get(line); };
    const ai = a.slice(prefix, prefix + n).map(token), bi = b.slice(prefix, prefix + m).map(token);
    const width = m + 1, scores = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      scores[i * width + j] = ai[i] === bi[j] ? 1 + scores[(i + 1) * width + j + 1] :
        Math.max(scores[(i + 1) * width + j], scores[i * width + j + 1]);
    }
    const groups = [];
    function add(kind, oldStart, newStart, count = 1) {
      if (!count) return;
      const last = groups.at(-1);
      if (kind === "equal" && last?.kind === kind) last.count += count;
      else groups.push({ kind, oldStart, newStart, count });
      if (kind === "add") result.added += count;
      if (kind === "remove") result.removed += count;
    }
    add("equal", 0, 0, prefix);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ai[i] === bi[j]) { add("equal", prefix + i, prefix + j); i++; j++; }
      else if (i < n && (j === m || scores[(i + 1) * width + j] >= scores[i * width + j + 1])) {
        add("remove", prefix + i, prefix + j); i++;
      } else { add("add", prefix + i, prefix + j); j++; }
    }
    add("equal", a.length - suffix, b.length - suffix, suffix);
    if (result.added + result.removed > MAX_CHANGES) return fallback("The replacement is too dense for the compact review.", true);
    groups.forEach((group, index) => {
      const { kind, oldStart, newStart, count } = group;
      function row(offset) {
        const raw = kind === "add" ? b[newStart + offset] : a[oldStart + offset];
        result.rows.push({ kind, oldLine: kind === "add" ? null : oldStart + offset + 1,
          newLine: kind === "remove" ? null : newStart + offset + 1, raw, ...lineDetails(raw) });
      }
      if (kind !== "equal") { row(0); return; }
      const head = index > 0 || groups.length === 1 ? Math.min(CONTEXT, count) : 0;
      const tail = index < groups.length - 1 ? Math.min(CONTEXT, count - head) : 0;
      for (let k = 0; k < head; k++) row(k);
      if (count > head + tail) result.rows.push({ kind: "gap", count: count - head - tail });
      for (let k = count - tail; k < count; k++) row(k);
    });
    if (result.rows.length > MAX_ROWS) return fallback("The contextual review would require too many rows.", true);
    return { ...result, countsExact: true };
  }

  return Object.freeze({ compare, splitLines, lineDetails, visibleWhitespace });
});
