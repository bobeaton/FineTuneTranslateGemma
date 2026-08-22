'use strict';

/* =========================================================================
 * RPC bridge to the C# host (Photino WebMessage channel).
 * ========================================================================= */

let rpcCounter = 0;
const pendingRpc = new Map();

window.external.receiveMessage((raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const entry = pendingRpc.get(msg.id);
  if (!entry) return;
  pendingRpc.delete(msg.id);
  if (msg.ok) entry.resolve(msg.result);
  else entry.reject(new Error(msg.error || 'Unknown host error'));
});

function callHost(action, payload) {
  return new Promise((resolve, reject) => {
    const id = 'r' + (++rpcCounter) + '_' + Math.random().toString(36).slice(2);
    pendingRpc.set(id, { resolve, reject });
    window.external.sendMessage(JSON.stringify({ id, action, payload: payload || {} }));
  });
}

/* =========================================================================
 * Fonts (state shape + CSS stack building -- declared up top since `state`
 * below needs the defaults; see the "Fonts" section further down for the
 * font modal itself)
 * ========================================================================= */

// The font modal only ever shows/stores a plain font name (e.g. "Nirmala
// UI") -- no quotes, no generic-family fallback -- since that raw CSS
// syntax is exactly what made this unusable for a non-technical user: typing
// over "Nirmala UI", sans-serif without clearing it exactly right silently
// produces a broken font-family list that visibly changes nothing, which is
// indistinguishable from "the dialog doesn't work." The generic fallback
// per column is fixed and always appended by cssFontStack() instead.
const FONT_FALLBACKS = { info: 'monospace', source: 'sans-serif', target: 'sans-serif' };
const DEFAULT_FONTS = {
  info:   { family: 'Consolas', size: 12 },
  source: { family: 'Nirmala UI', size: 16 },
  target: { family: 'Nirmala UI', size: 16 },
};

function cssFontStack(col, family) {
  const name = (family || '').trim();
  return name ? `"${name.replace(/"/g, '')}", ${FONT_FALLBACKS[col]}` : FONT_FALLBACKS[col];
}

// Recovers a plain name from either a fresh plain value ("Nirmala UI") or an
// old project's pre-fix full CSS stack ("\"Nirmala UI\", sans-serif"), so a
// project saved before this fix still loads correctly instead of doubling
// up into a broken stack via cssFontStack().
function sanitizeFontFamily(raw) {
  if (!raw) return '';
  return String(raw).split(',')[0].trim().replace(/^["']|["']$/g, '').trim();
}

/* =========================================================================
 * State
 * ========================================================================= */

const state = {
  projectPath: null,       // where Save/autosave-once-confirmed writes; auto-derived from the Source file on import
  hasExplicitlySaved: false, // true once the user has done a real Save/Save As/Open this session -- gates whether
                              // autosave is allowed to write to projectPath, or must stick to recoveryPath
  recoveryPath: null,
  sourceFilePath: null,
  sourceLines: [],
  targets: [],           // [{name, filePath, lines: string[]}]
  activeTargetIndex: -1,
  fonts: {
    info:   { ...DEFAULT_FONTS.info },
    source: { ...DEFAULT_FONTS.source },
    target: { ...DEFAULT_FONTS.target },
  },
  dirty: false,
};

// Selection is independent of `state` because it's pure UI/interaction state,
// never persisted, never sent to the host.
const selection = { mode: 'none', col: null, row: null }; // mode: none|cell|row|editing

// Undo history for Delete-triggered cell/row removals (Ctrl+Z), independent
// of `state` for the same reason as `selection` -- it's not persisted.
const undoStack = [];
const UNDO_STACK_LIMIT = 100;
function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > UNDO_STACK_LIMIT) undoStack.shift();
}

function activeTarget() {
  return state.activeTargetIndex >= 0 ? state.targets[state.activeTargetIndex] : null;
}

function rowCount() {
  const t = activeTarget();
  return Math.max(state.sourceLines.length, t ? t.lines.length : 0);
}

function ensureIndex(arr, i) {
  while (arr.length <= i) arr.push('');
}

/* =========================================================================
 * Text analysis for the Info column
 * ========================================================================= */

function countWords(text) {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

// Devanagari prose (Hindi/Kangri) ends sentences with "।"/"॥" as often as
// ".", "!", "?" -- all four are treated as sentence terminators.
// Quote count covers opening/closing curly single/double and straight
// single/double -- every occurrence counts as 1 regardless of which kind,
// since the point is just "does one side have quote marks the other
// doesn't", not matching specific quote styles against each other.
const QUOTE_CHAR_RE = new RegExp("['\"‘’“”]", 'g');

function countSentenceCommaQuote(text) {
  const sentences = (text.match(/[.!?।॥]+/g) || []).length;
  const commas = (text.match(/,/g) || []).length;
  const quotes = (text.match(QUOTE_CHAR_RE) || []).length;
  return { sentences, commas, quotes };
}

// Wraps a count in a bold/underlined span when it's the dimension that
// differs between Source and Target, so line2 draws the eye straight to
// which of sentences/commas/quotes is the mismatched one instead of making
// the reader compare all three pairs themselves.
function markDiff(value, differs) {
  return differs ? `<span class="info-diff">${value}</span>` : String(value);
}

function computeInfo(srcText, tgtText) {
  const ws = countWords(srcText), wt = countWords(tgtText);
  const s = countSentenceCommaQuote(srcText), t = countSentenceCommaQuote(tgtText);
  const wordDiff = Math.abs(ws - wt) > 11;
  const sentDiff = s.sentences !== t.sentences;
  const commaDiff = s.commas !== t.commas;
  const quoteDiff = s.quotes !== t.quotes;
  // Yellow ("structure differs") highlight is deliberately one-sided on
  // commas: a Target with *fewer* commas than Source is worth flagging
  // (likely a dropped clause/pause), but a Target with *more* commas isn't --
  // that's usually just the target language's own punctuation conventions,
  // not a translation problem, so it shouldn't nag the reviewer.
  const structDiff = sentDiff || quoteDiff || (t.commas < s.commas);
  let cls = '';
  if (wordDiff && structDiff) cls = 'info-both';
  else if (wordDiff) cls = 'info-words';
  else if (structDiff) cls = 'info-structure';
  const tooltip = [
    `# of Words in Source (${ws}):Target (${wt})`,
    `# of Sentences (${s.sentences}/${t.sentences})/Commas (${s.commas}/${t.commas})/Quotation marks (${s.quotes}/${t.quotes}) -- Source/Target`,
  ].join('\n');
  return {
    line1: `${ws}:${wt}`,
    line2: `${markDiff(s.sentences, sentDiff)}/${markDiff(s.commas, commaDiff)}/${markDiff(s.quotes, quoteDiff)}`
         + `:${markDiff(t.sentences, sentDiff)}/${markDiff(t.commas, commaDiff)}/${markDiff(t.quotes, quoteDiff)}`,
    cls,
    tooltip,
  };
}

/* =========================================================================
 * Rendering
 * ========================================================================= */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderAll() {
  renderHeader();
  renderBody();
  renderTargetTabs();
  updateStatus();
  updateTitleInfo();
}

function renderHeader() {
  const headerRow = document.getElementById('gridHeaderRow');
  const t = activeTarget();
  let html = '<th class="col-gutter">#</th>';
  if (t) html += '<th class="col-info">Info</th>';
  html += '<th class="col-source">Source</th>';
  if (t) html += '<th class="col-actions"></th>';
  if (t) html += `<th class="col-target">Target: ${escapeHtml(t.name)}</th>`;
  headerRow.innerHTML = html;
  // table-layout:fixed splits leftover space among however many columns are
  // left without an explicit width -- with Info/Actions/Target all added at
  // once here, that was leaving Source and Target's shares miscomputed (a
  // large blank gap) in practice. Toggling this class lets the CSS give
  // Source/Target an explicit, deterministic 50/50 split of the true
  // leftover space whenever a Target column exists, instead of leaving it
  // to that leftover-space heuristic at all.
  document.getElementById('grid').classList.toggle('has-target', !!t);
}

function renderBody() {
  const tbody = document.getElementById('gridBody');
  const n = rowCount();
  const t = activeTarget();
  let html = '';
  for (let i = 0; i < n; i++) html += buildRowHtml(i, t);
  tbody.innerHTML = html;
  reapplySelectionHighlight();
}

function buildRowHtml(i, t) {
  const srcText = state.sourceLines[i] ?? '';
  const tgtText = t ? (t.lines[i] ?? '') : '';
  let out = `<tr data-row="${i}">`;
  out += `<td class="col-gutter" data-role="gutter" data-row="${i}">${i + 1}</td>`;
  if (t) out += buildInfoCellHtml(i, srcText, tgtText);
  out += `<td class="cell col-source" data-col="source" data-row="${i}">${escapeHtml(srcText)}</td>`;
  if (t) out += buildActionsCellHtml(i, t);
  if (t) out += `<td class="cell col-target" data-col="target" data-row="${i}">${escapeHtml(tgtText)}</td>`;
  out += '</tr>';
  return out;
}

// Shared by buildInfoCellHtml and updateInfoCell so the two never drift --
// the two count lines plus a quick "delete row" shortcut (same as the
// right-click menu's "Delete row (both)"). This column is pure computed
// display, never contenteditable, so a button living inside it is completely
// safe (contrast with the Source/Target action buttons below, which
// deliberately live in their OWN column instead of inside the text cells).
function infoCellInnerHtml(info, row) {
  return `<div class="info-cell-inner">`
       + `<div class="info-lines">`
       + `<span class="info-line">${info.line1}</span>`
       + `<span class="info-line">${info.line2}</span>`
       + `</div>`
       + `<button class="mini-btn mini-btn-delete-row" data-row="${row}" title="Delete row (both)">×</button>`
       + `</div>`;
}

function buildInfoCellHtml(row, srcText, tgtText) {
  const info = computeInfo(srcText, tgtText);
  return `<td class="col-info ${info.cls}" data-role="info" title="${escapeHtml(info.tooltip)}">`
       + infoCellInnerHtml(info, row)
       + '</td>';
}

function updateInfoCell(row) {
  const tr = document.querySelector(`#gridBody tr[data-row="${row}"]`);
  if (!tr) return;
  const cell = tr.querySelector('td[data-role="info"]');
  if (!cell) return;
  const srcText = state.sourceLines[row] ?? '';
  const t = activeTarget();
  const tgtText = t ? (t.lines[row] ?? '') : '';
  const info = computeInfo(srcText, tgtText);
  cell.className = `col-info ${info.cls}`;
  cell.title = info.tooltip;
  cell.innerHTML = infoCellInnerHtml(info, row);
}

// The shared gutter column between Source and Target: a delete-cell (×) and
// a combine-with-next-or-previous shortcut for each side, packed as two
// narrow sub-columns (Source's hugging the left/Source edge, Target's
// hugging the right/Target edge) so they read as "belonging to" whichever
// text column they're next to. These are pure shortcuts to the same
// deleteCell/combineCellWithNext/combineCellWithPrevious functions the
// right-click menu uses -- same undo entries, same toasts, nothing
// duplicated. Deliberately its own column rather than buttons overlaid
// inside the Source/Target cells themselves, since those cells are
// contenteditable and rely on being exactly one text node (see
// buildRowHtml/syncCellToState) -- anything else living inside them risks
// corrupting the saved text or confusing caret placement.
function buildActionsCellHtml(row, t) {
  const previous = combineDirection === 'previous';
  const arrow = previous ? '↑' : '↓';
  const direction = previous ? 'with previous' : 'with next';
  const canCombine = (arr) => (previous ? row > 0 : row + 1 < arr.length);
  // Tooltips spell out which column each button belongs to (e.g. "Delete
  // Target cell") rather than a bare "Delete cell" -- since both sides sit
  // right next to each other in this shared gutter, the column name is the
  // only thing the tooltip has to go on to disambiguate which button you're
  // over.
  const combineBtn = (colLabel, col, arr) =>
    `<button class="mini-btn mini-btn-combine" data-mini-col="${col}" data-mini-kind="combine" data-row="${row}" `
    + `title="Combine ${colLabel} cell ${direction}" ${canCombine(arr) ? '' : 'disabled'}>${arrow}</button>`;
  const deleteBtn = (colLabel, col) =>
    `<button class="mini-btn mini-btn-delete" data-mini-col="${col}" data-mini-kind="delete" data-row="${row}" `
    + `title="Delete ${colLabel} cell">×</button>`;
  return `<td class="col-actions" data-role="actions">`
    + `<div class="actions-cell-inner">`
    + `<div class="cell-actions cell-actions-source">${deleteBtn('Source', 'source')}${combineBtn('Source', 'source', state.sourceLines)}</div>`
    + `<div class="cell-actions cell-actions-target">${deleteBtn('Target', 'target')}${combineBtn('Target', 'target', t.lines)}</div>`
    + `</div>`
    + '</td>';
}

function renderTargetTabs() {
  const container = document.getElementById('targetTabs');
  if (state.targets.length === 0) {
    container.hidden = true; container.innerHTML = '';
    refreshDynamicColumnMenus();
    return;
  }
  container.hidden = false;
  container.innerHTML = state.targets.map((t, i) => {
    const mismatch = t.lines.length !== state.sourceLines.length;
    const cls = `target-tab ${i === state.activeTargetIndex ? 'active' : ''} ${mismatch ? 'mismatch' : ''}`;
    const title = mismatch ? `Row count differs from Source (${t.lines.length} vs ${state.sourceLines.length}) — may need re-aligning` : '';
    return `<button class="${cls}" data-target-index="${i}" title="${escapeHtml(title)}">${escapeHtml(t.name)}${mismatch ? ' *' : ''}</button>`;
  }).join('');
  container.querySelectorAll('.target-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      commitEditIfAny();
      state.activeTargetIndex = parseInt(btn.dataset.targetIndex, 10);
      selection.mode = 'none';
      renderAll();
    });
  });
  refreshDynamicColumnMenus();
}

// A row-count mismatch against Source is used as the "this target probably
// needs re-aligning" signal (matches the Info column's coarse-count-based
// heuristics elsewhere in this app, not a deep semantic alignment check).
function renderBodyAndTabs() {
  renderBody();
  renderTargetTabs();
  updateStatus(); // row-count-changing edits (delete/split/replace/etc.) go through
                   // here, not renderAll() -- the status bar needs refreshing too,
                   // or it goes stale showing whatever counts were last rendered.
}

// Called right before/after any operation that changes state.sourceLines'
// LENGTH (not just a row's text). Warns about targets that used to match the
// old Source row count and no longer do -- those are the ones that were fine
// a moment ago and now need re-aligning because Source shifted under them.
function notifyIfTargetsDrifted(beforeSourceLen) {
  const afterSourceLen = state.sourceLines.length;
  if (beforeSourceLen === afterSourceLen) return;
  const drifted = state.targets.filter((t) => t.lines.length === beforeSourceLen && t.lines.length !== afterSourceLen);
  if (drifted.length > 0) {
    showToast(`Source row count changed (${beforeSourceLen} → ${afterSourceLen}) — these targets may need re-aligning: ${drifted.map((t) => t.name).join(', ')}`, true);
  }
}

function updateStatus() {
  const el = document.getElementById('statusText');
  const t = activeTarget();
  const parts = [];
  if (quoteInsertMode) parts.push(`Smart-quote insert mode active (row ${quoteInsertMode.row + 1}) — click a spot, or Esc to stop`);
  parts.push(`${state.sourceLines.length} source line(s)`);
  if (t) parts.push(`${t.lines.length} target line(s) (${t.name})`);
  parts.push(`${rowCount()} row(s) shown`);
  el.textContent = parts.join(' • ');
}

function updateTitleInfo() {
  const el = document.getElementById('titleInfo');
  const bits = [];
  if (state.hasExplicitlySaved && state.projectPath) {
    bits.push(baseNameWithExt(state.projectPath));
    bits.push(state.dirty ? 'unsaved changes' : 'saved');
  } else if (state.projectPath) {
    bits.push(`will save as ${baseNameWithExt(state.projectPath)}`);
    bits.push('not yet saved — autosaving to recovery');
  } else {
    bits.push('not yet saved — autosaving to recovery');
  }
  el.textContent = bits.join(' — ');
}

/* =========================================================================
 * Cell selection / editing
 *
 * Click always enters edit mode directly (caret at the click point) so
 * typing/Enter-splitting needs no extra step. Escape drops the current cell
 * to "selected" (highlighted, not editing) -- that's the state Delete needs
 * to remove the whole cell/row rather than a character within it. Clicking
 * the row-number gutter selects the whole row the same way.
 * ========================================================================= */

function findCell(col, row) {
  return document.querySelector(`td.cell[data-col="${col}"][data-row="${row}"]`);
}

function clearSelectionClasses() {
  document.querySelectorAll('.cell.selected, .cell.editing').forEach((el) => el.classList.remove('selected', 'editing'));
  document.querySelectorAll('tr.row-selected').forEach((el) => el.classList.remove('row-selected'));
}

function reapplySelectionHighlight() {
  if (selection.mode === 'cell' || selection.mode === 'editing') {
    const cell = findCell(selection.col, selection.row);
    if (cell) cell.classList.add(selection.mode === 'editing' ? 'editing' : 'selected');
  } else if (selection.mode === 'row') {
    const tr = document.querySelector(`#gridBody tr[data-row="${selection.row}"]`);
    if (tr) tr.classList.add('row-selected');
  }
}

function selectRow(row) {
  commitEditIfAny();
  clearSelectionClasses();
  selection.mode = 'row'; selection.col = null; selection.row = row;
  const tr = document.querySelector(`#gridBody tr[data-row="${row}"]`);
  if (tr) tr.classList.add('row-selected');
}

function enterEditMode(cell, caretMode, x, y) {
  if (selection.mode === 'editing') {
    const cur = findCell(selection.col, selection.row);
    if (cur && cur !== cell) commitEditIfAny();
  }
  clearSelectionClasses();
  cell.contentEditable = 'true';
  cell.classList.add('editing');
  selection.mode = 'editing';
  selection.col = cell.dataset.col;
  selection.row = parseInt(cell.dataset.row, 10);
  cell.focus();
  if (caretMode === 'point') placeCaretAtPoint(cell, x, y);
  else if (caretMode === 'start') placeCaretAtStart(cell);
  else placeCaretAtEnd(cell);
}

function commitEditIfAny() {
  if (selection.mode !== 'editing') return;
  const cell = findCell(selection.col, selection.row);
  if (cell) {
    syncCellToState(cell);
    cell.contentEditable = 'false';
    cell.classList.remove('editing');
    cell.classList.add('selected');
  }
  selection.mode = 'cell';
}

function syncCellToState(cell) {
  const col = cell.dataset.col;
  const row = parseInt(cell.dataset.row, 10);
  const text = cell.textContent;
  if (col === 'source') {
    ensureIndex(state.sourceLines, row);
    state.sourceLines[row] = text;
  } else if (col === 'target') {
    const t = activeTarget();
    if (t) { ensureIndex(t.lines, row); t.lines[row] = text; }
  }
  markDirty();
  updateInfoCell(row);
}

/* ---- caret placement helpers ---- */

function placeCaretAtPoint(el, x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range || !el.contains(range.startContainer)) { placeCaretAtEnd(el); return; }
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtStart(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtOffset(el, offset) {
  const textNode = el.firstChild || el;
  const len = (textNode.textContent || '').length;
  const o = Math.max(0, Math.min(offset, len));
  const range = document.createRange();
  range.setStart(textNode, o);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ---- row split (Enter) ---- */

function handleEnterSplit() {
  const cell = findCell(selection.col, selection.row);
  if (!cell) return;
  const sel = window.getSelection();
  let before = cell.textContent, after = '';
  if (sel && sel.rangeCount > 0 && cell.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(cell);
    preRange.setEnd(range.startContainer, range.startOffset);
    before = preRange.toString();
    const postRange = document.createRange();
    postRange.selectNodeContents(cell);
    postRange.setStart(range.endContainer, range.endOffset);
    after = postRange.toString();
  }

  const col = selection.col, row = selection.row;
  const arr = col === 'source' ? state.sourceLines : activeTarget()?.lines;
  if (!arr) return;
  ensureIndex(arr, row);
  const beforeSourceLen = state.sourceLines.length;
  arr[row] = before;
  arr.splice(row + 1, 0, after);
  markDirty();
  if (col === 'source') notifyIfTargetsDrifted(beforeSourceLen);

  renderBodyAndTabs();
  const newCell = findCell(col, row + 1);
  if (newCell) {
    newCell.contentEditable = 'true';
    newCell.classList.add('editing');
    selection.mode = 'editing'; selection.col = col; selection.row = row + 1;
    newCell.focus();
    placeCaretAtStart(newCell);
  }
}

/* ---- single-cell / whole-row deletion ---- */

function deleteCell(col, row) {
  const arr = col === 'source' ? state.sourceLines : activeTarget()?.lines;
  if (!arr || row >= arr.length) return;
  pushUndo({ type: 'cell', col, row, value: arr[row], targetIndex: state.activeTargetIndex });
  const beforeSourceLen = state.sourceLines.length;
  arr.splice(row, 1);
  markDirty();
  if (col === 'source') notifyIfTargetsDrifted(beforeSourceLen);
  renderBodyAndTabs();
  const n = rowCount();
  if (n > 0) { selection.mode = 'none'; selectCellNoEdit(col, Math.min(row, n - 1)); }
  else selection.mode = 'none';
}

function deleteRow(row) {
  const t = activeTarget();
  const hadSource = row < state.sourceLines.length;
  const hadTarget = !!(t && row < t.lines.length);
  if (!hadSource && !hadTarget) return;
  pushUndo({
    type: 'row',
    row,
    hadSource,
    sourceValue: hadSource ? state.sourceLines[row] : '',
    hadTarget,
    targetValue: hadTarget ? t.lines[row] : '',
    targetIndex: state.activeTargetIndex,
  });
  const beforeSourceLen = state.sourceLines.length;
  if (hadSource) state.sourceLines.splice(row, 1);
  if (hadTarget) t.lines.splice(row, 1);
  markDirty();
  if (hadSource) notifyIfTargetsDrifted(beforeSourceLen);
  renderBodyAndTabs();
  const n = rowCount();
  if (n > 0) selectRow(Math.min(row, n - 1));
  else selection.mode = 'none';
}

// Merges the cell below (in the same column only) into this one, separated
// by a space, then removes that now-empty-below cell so every row after it
// shifts up. The other column (source vs. target) and its row count are
// untouched -- this is a single-column operation, mirroring deleteCell.
function combineCellWithNext(col, row) {
  const arr = col === 'source' ? state.sourceLines : activeTarget()?.lines;
  if (!arr || row + 1 >= arr.length) return;
  pushUndo({
    type: 'combineCell', col, row,
    previousValue: arr[row], nextValue: arr[row + 1],
    targetIndex: state.activeTargetIndex,
  });
  const beforeSourceLen = state.sourceLines.length;
  arr[row] = arr[row] + ' ' + arr[row + 1];
  arr.splice(row + 1, 1);
  markDirty();
  if (col === 'source') notifyIfTargetsDrifted(beforeSourceLen);
  renderBodyAndTabs();
  selection.mode = 'none';
  selectCellNoEdit(col, Math.min(row, rowCount() - 1));
}

// Same merge, just entered from the second of the two cells -- delegates to
// combineCellWithNext on the row above so undo/redo stays a single code path.
function combineCellWithPrevious(col, row) {
  if (row <= 0) return;
  combineCellWithNext(col, row - 1);
}

// Reverses the most recent deleteCell/deleteRow, re-inserting the removed
// text at the same index. Targets the target column by stored index (not
// "whichever tab is active now"), so undoing still lands correctly even if
// the user switched tabs in between -- and switches back to that tab so the
// restored row is visible.
function performUndo() {
  const entry = undoStack.pop();
  if (!entry) { showToast('Nothing to undo.'); return; }

  if (entry.type === 'cell') {
    const beforeSourceLen = state.sourceLines.length;
    const arr = entry.col === 'source' ? state.sourceLines : state.targets[entry.targetIndex]?.lines;
    if (arr) {
      arr.splice(Math.min(entry.row, arr.length), 0, entry.value);
      markDirty();
    }
    if (entry.col === 'source') notifyIfTargetsDrifted(beforeSourceLen);
    if (entry.col === 'target' && state.targets[entry.targetIndex]) state.activeTargetIndex = entry.targetIndex;
    selection.mode = 'none';
    renderAll();
    selectCellNoEdit(entry.col, entry.row);
    showToast('Undid cell delete.');
    return;
  }

  if (entry.type === 'row') {
    const beforeSourceLen = state.sourceLines.length;
    if (entry.hadSource) state.sourceLines.splice(Math.min(entry.row, state.sourceLines.length), 0, entry.sourceValue);
    const target = state.targets[entry.targetIndex];
    if (entry.hadTarget && target) target.lines.splice(Math.min(entry.row, target.lines.length), 0, entry.targetValue);
    if (target) state.activeTargetIndex = entry.targetIndex;
    if (entry.hadSource) notifyIfTargetsDrifted(beforeSourceLen);
    markDirty();
    renderAll();
    selectRow(entry.row);
    showToast('Undid row delete.');
    return;
  }

  if (entry.type === 'combineCell') {
    const arr = entry.col === 'source' ? state.sourceLines : state.targets[entry.targetIndex]?.lines;
    if (arr) {
      arr[entry.row] = entry.previousValue;
      arr.splice(entry.row + 1, 0, entry.nextValue);
      markDirty();
    }
    if (entry.col === 'target' && state.targets[entry.targetIndex]) state.activeTargetIndex = entry.targetIndex;
    selection.mode = 'none';
    renderAll();
    selectCellNoEdit(entry.col, entry.row);
    showToast('Undid combine cell.');
    return;
  }

  if (entry.type === 'textEdit') {
    const arr = entry.col === 'source' ? state.sourceLines : state.targets[entry.targetIndex]?.lines;
    if (arr) {
      ensureIndex(arr, entry.row);
      arr[entry.row] = entry.previousValue;
      markDirty();
    }
    if (entry.col === 'target' && state.targets[entry.targetIndex]) state.activeTargetIndex = entry.targetIndex;
    selection.mode = 'none';
    renderAll();
    selectCellNoEdit(entry.col, entry.row);
    showToast('Undid edit.');
    return;
  }

  // One Replace All / pinned-search-everywhere pass is one undo step,
  // regardless of how many rows (and, for a pinned search, how many
  // columns) it touched.
  if (entry.type === 'bulkTextEdit') {
    for (const c of entry.changes) {
      const arr = c.col === 'source' ? state.sourceLines : state.targets[c.targetIndex]?.lines;
      if (!arr) continue;
      ensureIndex(arr, c.row);
      arr[c.row] = c.previousValue;
    }
    markDirty();
    selection.mode = 'none';
    renderAll();
    showToast(`Undid ${entry.changes.length} replacement(s).`);
  }
}

function selectCellNoEdit(col, row) {
  clearSelectionClasses();
  selection.mode = 'cell'; selection.col = col; selection.row = row;
  const cell = findCell(col, row);
  if (cell) cell.classList.add('selected');
}

/* ---- "click to insert quotes (Left)/commas (Right)" mode ----
 *
 * Scoped to the row it was started from: left-clicking a Source/Target cell
 * in THAT row inserts a smart quote at the click position, right-clicking
 * inserts a comma instead (suppressing the normal context menu for that
 * click) -- either way it stays in the mode (so e.g. an opening quote, a
 * comma, and a closing quote can all be placed with three clicks). Clicking
 * (either button) on any OTHER row ends the mode and that click still
 * behaves normally; Escape also ends it. See the click/contextmenu
 * interception in gridBody's listeners below, and the Escape check in the
 * keydown listener further down.
 */

let quoteInsertMode = null; // { row } | null

function startQuoteInsertMode(row) {
  quoteInsertMode = { row };
  document.body.classList.add('quote-insert-mode');
  updateStatus();
  showToast(`Row ${row + 1}: left-click inserts a smart quote, right-click inserts a comma, at the click position. Esc or click another row to stop.`);
}

function stopQuoteInsertMode() {
  if (!quoteInsertMode) return;
  quoteInsertMode = null;
  document.body.classList.remove('quote-insert-mode');
  updateStatus();
}

// Each cell renders as exactly one text node (this app's rendering
// convention -- see buildRowHtml), so a Range's startOffset within that text
// node IS the offset within the cell's whole text; no separate node-walking
// needed. Falls back to end-of-text if the point can't be resolved to a
// caret position within this cell (e.g. clicked on empty padding).
function caretOffsetAtPoint(cell, x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range || !cell.contains(range.startContainer)) return (cell.textContent || '').length;
  return range.startOffset;
}

function insertCharAtCell(cell, offset, char) {
  const col = cell.dataset.col;
  const row = parseInt(cell.dataset.row, 10);
  const arr = col === 'source' ? state.sourceLines : activeTarget()?.lines;
  if (!arr) return;
  ensureIndex(arr, row);
  const text = arr[row] ?? '';
  const previousValue = text;
  arr[row] = text.slice(0, offset) + char + text.slice(offset);
  pushUndo({ type: 'textEdit', col, row, previousValue, targetIndex: state.activeTargetIndex });
  markDirty();
  updateInfoCell(row);
  cell.textContent = arr[row]; // patch just this cell -- a full re-render would rebuild every row mid-click-spree
}

function insertSmartQuoteAtClick(cell, x, y) {
  const row = parseInt(cell.dataset.row, 10);
  const arr = cell.dataset.col === 'source' ? state.sourceLines : activeTarget()?.lines;
  if (!arr) return;
  const text = arr[row] ?? '';
  const offset = Math.max(0, Math.min(caretOffsetAtPoint(cell, x, y), text.length));
  const precedingChar = offset > 0 ? text[offset - 1] : undefined;
  const quoteChar = (precedingChar === undefined || /\s/.test(precedingChar)) ? '“' : '”';
  insertCharAtCell(cell, offset, quoteChar);
}

function insertCommaAtClick(cell, x, y) {
  const offset = Math.max(0, Math.min(caretOffsetAtPoint(cell, x, y), (cell.textContent || '').length));
  insertCharAtCell(cell, offset, ',');
}

/* ---- right-click context menu (row-scoped: cell/row delete, punctuation copy) ---- */

let contextMenuRow = null;
// Which column was actually right-clicked: 'source' or 'target' when the
// click landed on that column's cell, null for the Info column or the
// row-number gutter (still ambiguous, so the menu stays column-agnostic).
let contextMenuCol = null;

document.getElementById('gridContainer').addEventListener('contextmenu', (e) => {
  if (quoteInsertMode) {
    const modeTr = e.target.closest('tr[data-row]');
    const clickedRow = modeTr ? parseInt(modeTr.dataset.row, 10) : null;
    if (clickedRow === quoteInsertMode.row) {
      e.preventDefault();
      const cellInRow = e.target.closest('td.cell');
      if (cellInRow) insertCommaAtClick(cellInRow, e.clientX, e.clientY);
      return; // stay in the mode either way
    }
    stopQuoteInsertMode(); // right-clicked a different row -- end the mode, then show the normal menu for it below
  }

  const tr = e.target.closest('tr[data-row]');
  if (!tr) return;
  e.preventDefault();
  commitEditIfAny();
  contextMenuRow = parseInt(tr.dataset.row, 10);
  const clickedCell = e.target.closest('td.col-source, td.col-target');
  contextMenuCol = clickedCell ? (clickedCell.classList.contains('col-source') ? 'source' : 'target') : null;
  showContextMenu(e.clientX, e.clientY);
});

function showContextMenu(x, y) {
  const menu = document.getElementById('cellContextMenu');
  const hasTarget = !!activeTarget();
  // Optional chaining so this stays safe if a button is ever removed from
  // the menu's HTML without a matching update here (that mismatch is what
  // broke the menu entirely last time -- querySelector returned null and
  // setting .disabled on it threw, aborting before menu.hidden = false ran).
  menu.querySelector('[data-ctx="deleteTargetCell"]')?.toggleAttribute('disabled', !hasTarget);
  menu.querySelector('[data-ctx="deleteRow"]')?.toggleAttribute('disabled', !hasTarget);
  menu.querySelector('[data-ctx="combinePreviousSourceCell"]')?.toggleAttribute(
    'disabled', contextMenuRow <= 0);
  menu.querySelector('[data-ctx="combinePreviousTargetCell"]')?.toggleAttribute(
    'disabled', !hasTarget || contextMenuRow <= 0);
  menu.querySelector('[data-ctx="combineSourceCell"]')?.toggleAttribute(
    'disabled', contextMenuRow + 1 >= state.sourceLines.length);
  menu.querySelector('[data-ctx="combineTargetCell"]')?.toggleAttribute(
    'disabled', !hasTarget || contextMenuRow + 1 >= activeTarget().lines.length);
  // Right-clicking directly on a Source or Target cell narrows the menu to
  // just that column's items (and drops the column name from their labels,
  // since it's now obvious from where you clicked) -- right-clicking the
  // Info column or the row-number gutter still shows everything, labeled
  // with the column name, since there's no single column to infer there.
  menu.querySelectorAll('[data-col]').forEach((btn) => {
    if (contextMenuCol) {
      btn.hidden = btn.dataset.col !== contextMenuCol;
      btn.textContent = btn.dataset.labelOnly;
    } else {
      btn.hidden = false;
      btn.textContent = btn.dataset.labelBoth;
    }
  });
  // Keep the menu on-screen even if the click was near an edge.
  const menuWidth = 300, menuHeight = 320;
  const left = Math.min(x, window.innerWidth - menuWidth - 8);
  const top = Math.min(y, window.innerHeight - menuHeight - 8);
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = Math.max(4, top) + 'px';
  menu.hidden = false;
}

function hideContextMenu() {
  document.getElementById('cellContextMenu').hidden = true;
  contextMenuRow = null;
  contextMenuCol = null;
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('#gridContainer')) hideContextMenu();
});

document.querySelectorAll('#cellContextMenu [data-ctx]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    const row = contextMenuRow;
    hideContextMenu();
    if (row == null) return;
    switch (btn.dataset.ctx) {
      case 'deleteSourceCell': deleteCell('source', row); break;
      case 'deleteTargetCell': deleteCell('target', row); break;
      case 'deleteRow': deleteRow(row); break;
      case 'combinePreviousSourceCell': combineCellWithPrevious('source', row); break;
      case 'combinePreviousTargetCell': combineCellWithPrevious('target', row); break;
      case 'combineSourceCell': combineCellWithNext('source', row); break;
      case 'combineTargetCell': combineCellWithNext('target', row); break;
      case 'quoteInsertMode': startQuoteInsertMode(row); break;
    }
  });
});

/* ---- multi-line paste ---- */

function insertPastedText(text) {
  const rawLines = text.split(/\r\n|\r|\n/);
  if (rawLines.length <= 1) {
    document.execCommand('insertText', false, text);
    const cell = findCell(selection.col, selection.row);
    if (cell) syncCellToState(cell);
    return;
  }

  const cell = findCell(selection.col, selection.row);
  if (!cell) return;
  const sel = window.getSelection();
  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(cell);
  preRange.setEnd(range.startContainer, range.startOffset);
  const before = preRange.toString();
  const postRange = document.createRange();
  postRange.selectNodeContents(cell);
  postRange.setStart(range.endContainer, range.endOffset);
  const after = postRange.toString();

  const lines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return;

  const col = selection.col, row = selection.row;
  const arr = col === 'source' ? state.sourceLines : activeTarget()?.lines;
  if (!arr) return;
  ensureIndex(arr, row);

  if (lines.length === 1) {
    arr[row] = before + lines[0] + after;
    markDirty();
    renderBody();
    const newCell = findCell(col, row);
    if (newCell) {
      newCell.contentEditable = 'true'; newCell.classList.add('editing');
      selection.mode = 'editing'; selection.col = col; selection.row = row;
      newCell.focus();
      placeCaretAtOffset(newCell, (before + lines[0]).length);
    }
    return;
  }

  const beforeSourceLen = state.sourceLines.length;
  arr[row] = before + lines[0];
  const middle = lines.slice(1, -1);
  const last = lines[lines.length - 1] + after;
  arr.splice(row + 1, 0, ...middle, last);
  markDirty();
  if (col === 'source') notifyIfTargetsDrifted(beforeSourceLen);
  renderBodyAndTabs();
  const lastRow = row + lines.length - 1;
  const lastCell = findCell(col, lastRow);
  if (lastCell) {
    lastCell.contentEditable = 'true'; lastCell.classList.add('editing');
    selection.mode = 'editing'; selection.col = col; selection.row = lastRow;
    lastCell.focus();
    placeCaretAtOffset(lastCell, lines[lines.length - 1].length);
  }
}

/* ---- event wiring ---- */

const gridBody = document.getElementById('gridBody');

gridBody.addEventListener('click', (e) => {
  // Action-gutter and delete-row mini-buttons -- checked first since they're
  // unambiguous regardless of quote-insert-mode; ending that mode here too
  // since a delete/combine can shift or renumber rows out from under it.
  const rowDeleteBtn = e.target.closest('.mini-btn-delete-row');
  const miniBtn = e.target.closest('.mini-btn[data-mini-col]');
  if (rowDeleteBtn || miniBtn) {
    if (quoteInsertMode) stopQuoteInsertMode();
    commitEditIfAny();
    if (rowDeleteBtn) { deleteRow(parseInt(rowDeleteBtn.dataset.row, 10)); return; }
    const row = parseInt(miniBtn.dataset.row, 10);
    const col = miniBtn.dataset.miniCol;
    if (miniBtn.dataset.miniKind === 'delete') deleteCell(col, row);
    else if (combineDirection === 'previous') combineCellWithPrevious(col, row);
    else combineCellWithNext(col, row);
    return;
  }

  if (quoteInsertMode) {
    const tr = e.target.closest('tr[data-row]');
    const clickedRow = tr ? parseInt(tr.dataset.row, 10) : null;
    if (clickedRow === quoteInsertMode.row) {
      const cellInRow = e.target.closest('td.cell');
      if (cellInRow) insertSmartQuoteAtClick(cellInRow, e.clientX, e.clientY);
      return; // stay in the mode either way (even a no-op click on the gutter/Info cell)
    }
    stopQuoteInsertMode(); // clicked a different row -- end the mode, then let this click behave normally below
  }

  const gutter = e.target.closest('[data-role="gutter"]');
  if (gutter) { selectRow(parseInt(gutter.dataset.row, 10)); return; }
  const cell = e.target.closest('td.cell');
  if (!cell) return;
  // A click-drag text selection that starts and ends within the same cell
  // still fires a native 'click' afterward (mousedown/mouseup landed on the
  // same element) -- if we're already editing THIS cell, leave it alone
  // rather than re-running enterEditMode, which would collapse the
  // just-made selection back to a single caret at the mouse-up point. A
  // plain click here still repositions the caret correctly on its own,
  // since that's normal contenteditable behavior once a cell is editable.
  if (selection.mode === 'editing' && selection.col === cell.dataset.col && selection.row === parseInt(cell.dataset.row, 10)) {
    return;
  }
  enterEditMode(cell, 'point', e.clientX, e.clientY);
});

gridBody.addEventListener('input', (e) => {
  const cell = e.target.closest && e.target.closest('td.cell');
  if (!cell || selection.mode !== 'editing') return;
  syncCellToState(cell);
});

document.addEventListener('paste', (e) => {
  if (selection.mode !== 'editing') return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (text) insertPastedText(text);
});

document.addEventListener('mousedown', (e) => {
  if (selection.mode === 'editing') {
    const cell = findCell(selection.col, selection.row);
    if (cell && !cell.contains(e.target)) commitEditIfAny();
  }
}, true);

// Keys typed into the Find/Replace panel, the font/Saved-Searches modals, or
// the right-click context menu must never fall through to the grid's own
// shortcuts (Delete/Enter/Escape/Ctrl+Z/Ctrl+F) -- otherwise, e.g., pressing
// Delete while editing "Find what" deletes a character there AND (because
// `selection` still points at whatever grid cell/row was selected before
// the panel opened) also deletes that row in the grid.
function isInsideOwnUiPanel(el) {
  return !!(el && el.closest && el.closest('#findReplacePanel, #modalOverlay, #savedSearchesOverlay, #unsavedChangesOverlay, #overwriteWarningOverlay, #deleteTargetOverlay, #cellContextMenu'));
}

document.addEventListener('keydown', (e) => {
  if (isInsideOwnUiPanel(e.target)) return;

  if (quoteInsertMode && e.key === 'Escape') {
    e.preventDefault();
    stopQuoteInsertMode();
    showToast('Smart quote insertion mode ended.');
    return;
  }

  const isFindCombo = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F' || e.key === 'h' || e.key === 'H');
  if (isFindCombo) {
    e.preventDefault();
    commitEditIfAny();
    openFindReplacePanel();
    return;
  }
  const isUndoCombo = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z');
  if (isUndoCombo && selection.mode !== 'editing') {
    // Only intercept outside of text-editing, so Ctrl+Z still does normal
    // browser undo-typing while a cell is being edited.
    e.preventDefault();
    performUndo();
    return;
  }
  const isSaveCombo = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S');
  if (isSaveCombo) {
    e.preventDefault();
    commitEditIfAny();
    saveProject(false);
    return;
  }
  // Ctrl+A for Save As, per request -- only outside of text-editing, so it
  // still does normal browser select-all-in-this-cell while editing.
  const isSaveAsCombo = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'a' || e.key === 'A');
  if (isSaveAsCombo && selection.mode !== 'editing') {
    e.preventDefault();
    commitEditIfAny();
    saveProject(true);
    return;
  }
  if (selection.mode === 'editing') {
    if (e.key === 'Enter') { e.preventDefault(); handleEnterSplit(); }
    else if (e.key === 'Escape') { e.preventDefault(); commitEditIfAny(); }
    return; // everything else: normal contenteditable text-editing behavior
  }
  if (selection.mode === 'cell' || selection.mode === 'row') {
    if (e.key === 'Delete') {
      e.preventDefault();
      if (selection.mode === 'row') deleteRow(selection.row);
      else deleteCell(selection.col, selection.row);
    } else if (selection.mode === 'cell' && (e.key === 'Enter' || e.key === 'F2')) {
      e.preventDefault();
      const cell = findCell(selection.col, selection.row);
      if (cell) enterEditMode(cell, 'end');
    } else if (e.key === 'Escape') {
      clearSelectionClasses();
      selection.mode = 'none'; selection.col = null; selection.row = null;
    }
  }
});

/* =========================================================================
 * Menu bar
 * ========================================================================= */

document.querySelectorAll('.menu-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = btn.dataset.menu;
    const panel = document.querySelector(`.menu-dropdown[data-menu-panel="${key}"]`);
    const wasOpen = panel.classList.contains('open');
    closeAllMenus();
    if (!wasOpen) { panel.classList.add('open'); btn.classList.add('open'); }
  });
});
document.addEventListener('click', closeAllMenus);
function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown.open').forEach((p) => p.classList.remove('open'));
  document.querySelectorAll('.menu-btn.open').forEach((b) => b.classList.remove('open'));
}

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => { closeAllMenus(); runMenuAction(btn.dataset.action); });
});

async function runMenuAction(action) {
  commitEditIfAny();
  try {
    switch (action) {
      case 'importSource': await importSource(); break;
      case 'importTarget': await importTarget(); break;
      case 'newProject': await newProject(); break;
      case 'openProject': await openProject(); break;
      case 'save': await saveProject(false); break;
      case 'saveAsProject': await saveProject(true); break;
      case 'saveAsComparisonJson': await saveAsComparisonJson(); break;
      case 'saveAsCsv': await saveAsCsv(); break;
      case 'exit': await exitApp(); break;
      case 'undo': performUndo(); break;
      case 'openFontSettings': openFontModal(); break;
      case 'openFindReplace': openFindReplacePanel(); break;
      case 'openSavedSearches': openSavedSearchesModal(); break;
      case 'breakBothIntoSentences': breakBothIntoSentences(); break;
      case 'joinBothIntoParagraph': joinBothIntoParagraph(); break;
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    showToast(msg, true);
    // A toast alone is easy to miss for File menu failures (the whole reason
    // to look here is "nothing visible happened") -- pop a real OS message
    // box too so a failure can never look like silent no-op.
    try { await callHost('showMessage', { title: 'ParallelizeTexts — Error', text: msg, icon: 'error' }); } catch { /* best-effort */ }
  }
}

/* =========================================================================
 * Import
 * ========================================================================= */

function baseNameNoExt(path) {
  const base = path.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
function baseNameWithExt(path) { return path.replace(/^.*[\\/]/, ''); }
function dirNameOf(path) { return path.replace(/[\\/][^\\/]*$/, ''); }
function sepFor(path) { return path.includes('\\') ? '\\' : '/'; }

async function importSource() {
  const res = await chooseOpenFile({
    title: 'Import Source',
    filters: [{ name: 'Text files', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (!res.path) return;
  const lr = await callHost('readLines', { path: res.path });
  state.sourceFilePath = res.path;
  state.sourceLines = lr.lines;
  // Each Source file gets its own project identity -- same base name, same
  // folder, .paraproj extension -- established immediately so File > Save
  // already knows where to go without a forced first Save As. Autosave still
  // won't write there until an explicit Save actually happens (see
  // doAutosave/hasExplicitlySaved); until then it keeps using the recovery file.
  state.projectPath = suggestedProjectPath();
  state.hasExplicitlySaved = false;
  markDirty();
  selection.mode = 'none';
  undoStack.length = 0;
  renderAll();
  showToast(`Imported ${lr.lines.length} source line(s)` + (lr.blankSkipped ? ` (${lr.blankSkipped} blank line(s) skipped)` : ''));
}

async function importTarget() {
  const res = await chooseOpenFile({
    title: 'Import Target',
    filters: [{ name: 'Text files', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (!res.path) return;
  const lr = await callHost('readLines', { path: res.path });
  const name = baseNameNoExt(res.path);
  let idx = state.targets.findIndex((t) => t.name === name);
  if (idx < 0) {
    state.targets.push({ name, filePath: res.path, lines: lr.lines });
    idx = state.targets.length - 1;
  } else {
    state.targets[idx] = { name, filePath: res.path, lines: lr.lines };
  }
  state.activeTargetIndex = idx;
  // Only derive a project path from a target's name/folder if nothing has
  // established one yet (i.e. no Source imported and no project open) --
  // a Source's own name always takes priority once one exists.
  if (!state.projectPath) {
    state.projectPath = suggestedProjectPath();
    state.hasExplicitlySaved = false;
  }
  markDirty();
  selection.mode = 'none';
  undoStack.length = 0;
  renderAll();
  showToast(`Imported ${lr.lines.length} line(s) for "${name}"` + (lr.blankSkipped ? ` (${lr.blankSkipped} blank line(s) skipped)` : ''));
}

/* =========================================================================
 * Find / Replace, Saved Searches, Break into Sentences
 *
 * getSearchArray()'s "column" values are 'source' or 'target:<index>' (by
 * target index, not "whichever tab is active") so the Find/Replace panel and
 * Break-into-Sentences submenu can each target ANY target directly without
 * requiring a tab switch first.
 * ========================================================================= */

function getSearchArray(colValue) {
  if (colValue === 'source') return state.sourceLines;
  if (colValue && colValue.startsWith('target:')) {
    const idx = parseInt(colValue.slice(7), 10);
    return state.targets[idx] ? state.targets[idx].lines : null;
  }
  return null;
}

function columnSelectOptionsHtml() {
  let html = '<option value="source">Source</option>';
  state.targets.forEach((t, i) => { html += `<option value="target:${i}">Target: ${escapeHtml(t.name)}</option>`; });
  return html;
}

// The Column <select> in the Find/Replace panel and the Break-into-Sentences
// submenu both list Source + every target by name -- refreshed here (called
// from renderTargetTabs and init) so they stay in sync as targets are
// imported/renamed.
function refreshDynamicColumnMenus() {
  const frColumn = document.getElementById('frColumn');
  if (frColumn) {
    const prev = frColumn.value;
    frColumn.innerHTML = columnSelectOptionsHtml();
    if ([...frColumn.options].some((o) => o.value === prev)) frColumn.value = prev;
  }
  const submenu = document.getElementById('breakSentencesSubmenu');
  if (submenu) {
    submenu.innerHTML = '<button data-col="source">Source</button>'
      + state.targets.map((t, i) => `<button data-col="target:${i}">Target: ${escapeHtml(t.name)}</button>`).join('');
    submenu.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => { closeAllMenus(); breakColumnIntoSentences(btn.dataset.col); });
    });
  }
  const joinSubmenu = document.getElementById('joinParagraphSubmenu');
  if (joinSubmenu) {
    joinSubmenu.innerHTML = '<button data-col="source">Source</button>'
      + state.targets.map((t, i) => `<button data-col="target:${i}">Target: ${escapeHtml(t.name)}</button>`).join('');
    joinSubmenu.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => { closeAllMenus(); joinColumnIntoParagraph(btn.dataset.col); });
    });
  }
  const deleteSubmenu = document.getElementById('deleteTargetSubmenu');
  if (deleteSubmenu) {
    deleteSubmenu.innerHTML = state.targets.length === 0
      ? '<button disabled>No targets</button>'
      : state.targets.map((t, i) => `<button data-target-index="${i}">${escapeHtml(t.name)}</button>`).join('');
    deleteSubmenu.querySelectorAll('[data-target-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeAllMenus();
        deleteTarget(parseInt(btn.dataset.targetIndex, 10));
      });
    });
  }
}

// Resolves to true (delete confirmed) or false (cancelled).
function confirmDeleteTarget(name) {
  return new Promise((resolve) => {
    document.getElementById('deleteTargetText').textContent =
      `Delete the "${name}" target from this project? This only removes it from the ` +
      `current working copy, not from disk -- Import Target can bring it back in, but any ` +
      `unsaved changes to it will be lost.`;
    document.getElementById('deleteTargetOverlay').hidden = false;

    const confirmBtn = document.getElementById('deleteTargetConfirmBtn');
    const cancelBtn = document.getElementById('deleteTargetCancelBtn');

    const cleanup = () => {
      document.getElementById('deleteTargetOverlay').hidden = true;
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
    };
    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Removes a target entirely (its whole column, all rows) so it can be
// re-imported from scratch -- e.g. starting that translator's work over.
// Distinct from deleteRow/deleteCell: those remove one row across the
// columns they're told to; this removes one whole column.
async function deleteTarget(index) {
  const t = state.targets[index];
  if (!t) return;
  commitEditIfAny();
  const confirmed = await confirmDeleteTarget(t.name);
  if (!confirmed) return;

  const wasActive = state.activeTargetIndex;
  state.targets.splice(index, 1);
  if (state.targets.length === 0) state.activeTargetIndex = -1;
  else if (wasActive === index) state.activeTargetIndex = Math.min(index, state.targets.length - 1);
  else if (wasActive > index) state.activeTargetIndex = wasActive - 1;
  else state.activeTargetIndex = wasActive;

  // The undo stack can hold entries tagged with target indices that no
  // longer point at the right column (or any column) once one's removed --
  // same reasoning as New Project/Open Project clearing it wholesale.
  undoStack.length = 0;
  markDirty();
  selection.mode = 'none';
  renderAll();
  showToast(`Deleted target "${t.name}".`);
}

/* ---- regex construction ---- */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function currentFindOpts() {
  return {
    find: document.getElementById('frFind').value,
    replace: document.getElementById('frReplace').value,
    isRegex: document.getElementById('frRegex').checked,
    caseSensitive: document.getElementById('frCase').checked,
    wholeWord: document.getElementById('frWholeWord').checked,
  };
}

function buildSearchRegex(opts) {
  if (!opts.find) throw new Error('Find what is empty.');
  let source = opts.isRegex ? opts.find : escapeRegExp(opts.find);
  if (!opts.isRegex && opts.wholeWord) source = `\\b${source}\\b`;
  const flags = 'g' + (opts.caseSensitive ? '' : 'i');
  return new RegExp(source, flags);
}

// Re-implements JS's own $-token substitution (used automatically when
// String.replace's 2nd arg is a string) because counting replacements
// requires passing a replacer FUNCTION instead, and function replacers don't
// get that substitution for free -- their return value is used verbatim.
function substituteReplacement(template, matchArgs) {
  const args = matchArgs.slice();
  let groups;
  if (typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null) groups = args.pop();
  args.pop(); // full input string
  args.pop(); // match offset
  const fullMatch = args[0];
  const groupVals = args.slice(1);
  return template.replace(/\$(\$|&|<([^>]+)>|[0-9]{1,2})/g, (_, kind, namedGroup) => {
    if (kind === '$') return '$';
    if (kind === '&') return fullMatch;
    if (namedGroup) return (groups && groups[namedGroup]) ?? '';
    const idx = parseInt(kind, 10);
    return groupVals[idx - 1] ?? '';
  });
}

function computeAllMatches(colValue, regex) {
  const arr = getSearchArray(colValue);
  if (!arr) return [];
  const matches = [];
  arr.forEach((text, row) => {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text))) {
      matches.push({ row, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) regex.lastIndex++;
    }
  });
  return matches;
}

/* ---- Find Next / Replace / Replace All (scoped to one chosen column) ---- */

let findState = null; // {col, row, start, end} of the last match jumped to

function selectRangeInCell(cell, start, end) {
  const textNode = cell.firstChild || cell;
  const len = (textNode.textContent || '').length;
  const s = Math.max(0, Math.min(start, len));
  const e = Math.max(s, Math.min(end, len));
  const range = document.createRange();
  range.setStart(textNode, s);
  range.setEnd(textNode, e);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Switches to the target's tab if needed (so the match is actually visible),
// enters edit mode on that cell, and highlights the matched text.
function showMatchInGrid(colValue, row, start, end) {
  let colKey = 'source';
  if (colValue.startsWith('target:')) {
    const idx = parseInt(colValue.slice(7), 10);
    if (idx !== state.activeTargetIndex) { state.activeTargetIndex = idx; renderAll(); }
    colKey = 'target';
  }
  const cell = findCell(colKey, row);
  if (!cell) return;
  commitEditIfAny();
  clearSelectionClasses();
  cell.contentEditable = 'true';
  cell.classList.add('editing');
  selection.mode = 'editing'; selection.col = colKey; selection.row = row;
  cell.scrollIntoView({ block: 'center' });
  cell.focus();
  selectRangeInCell(cell, start, end);
}

function doFindNext() {
  const opts = currentFindOpts();
  let regex;
  try { regex = buildSearchRegex(opts); } catch (err) { showToast(err.message, true); return; }
  const colValue = document.getElementById('frColumn').value;
  let matches;
  try { matches = computeAllMatches(colValue, regex); } catch (err) { showToast('Invalid regular expression.', true); return; }

  document.getElementById('frMatchInfo').textContent = `${matches.length} match(es) in this column`;
  recordSearchHistory(opts);
  if (matches.length === 0) { showToast('No matches found.'); findState = null; return; }

  const wrap = document.getElementById('frWrap').checked;
  let next = null;
  if (findState && findState.col === colValue) {
    next = matches.find((m) => m.row > findState.row || (m.row === findState.row && m.start > findState.start));
  }
  if (!next) {
    if (findState && findState.col === colValue && !wrap) { showToast('No more matches.'); return; }
    next = matches[0];
  }
  findState = { col: colValue, row: next.row, start: next.start, end: next.end };
  showMatchInGrid(colValue, next.row, next.start, next.end);
}

function doReplace() {
  if (!findState) { doFindNext(); return; }
  const opts = currentFindOpts();
  const arr = getSearchArray(findState.col);
  if (!arr) return;

  const text = arr[findState.row];
  const matched = text.slice(findState.start, findState.end);
  let replacement = opts.replace;
  if (opts.isRegex) {
    let regex;
    try { regex = buildSearchRegex(opts); } catch (err) { showToast(err.message, true); return; }
    // `matched` is exactly the one found occurrence, so re-matching it here
    // (non-global) against the same pattern lets String.replace's own native
    // $1/$2/$&/$$ substitution do the work correctly -- substituteReplacement
    // (below) is for the replacer-FUNCTION argument shape used by Replace
    // All/pinned searches, which isn't what regex.exec() returns; passing an
    // exec() result to it silently ate the last two capture groups.
    const singleRegex = new RegExp(regex.source, regex.flags.replace('g', ''));
    replacement = matched.replace(singleRegex, opts.replace);
  }
  const newText = text.slice(0, findState.start) + replacement + text.slice(findState.end);
  pushUndo({
    type: 'textEdit',
    col: findState.col,
    row: findState.row,
    previousValue: text,
    targetIndex: findState.col === 'target' ? state.activeTargetIndex : -1,
  });
  arr[findState.row] = newText;
  markDirty();
  renderBodyAndTabs();
  recordSearchHistory(opts);
  findState = null;
  doFindNext();
}

function doReplaceAll() {
  const opts = currentFindOpts();
  let regex;
  try { regex = buildSearchRegex(opts); } catch (err) { showToast(err.message, true); return; }
  const colValue = document.getElementById('frColumn').value;
  const arr = getSearchArray(colValue);
  if (!arr) { showToast('No such column.', true); return; }

  const colForUndo = colValue === 'source' ? 'source' : 'target';
  const targetIndexForUndo = colValue.startsWith('target:') ? parseInt(colValue.slice(7), 10) : -1;
  const changes = [];
  let totalReplacements = 0, rowsChanged = 0;
  for (let i = 0; i < arr.length; i++) {
    let count = 0;
    regex.lastIndex = 0;
    const newText = arr[i].replace(regex, (...m) => { count++; return substituteReplacement(opts.replace, m); });
    if (count > 0) {
      changes.push({ col: colForUndo, targetIndex: targetIndexForUndo, row: i, previousValue: arr[i] });
      arr[i] = newText;
      totalReplacements += count;
      rowsChanged++;
    }
  }
  if (changes.length > 0) {
    pushUndo({ type: 'bulkTextEdit', changes });
    markDirty();
  }
  findState = null;
  renderBodyAndTabs();
  recordSearchHistory(opts);
  showToast(`Replaced ${totalReplacements} occurrence(s) across ${rowsChanged} row(s).`);
}

/* ---- Find/Replace history + pinned ("Add to Edit menu") searches ---- */

let frSettings = { history: [], pinned: [] };
let frSettingsPath = null;

async function loadFindReplaceSettings() {
  try {
    const { path } = await callHost('getFindReplaceHistoryPath', {});
    frSettingsPath = path;
    const { exists } = await callHost('fileExists', { path });
    if (exists) {
      const { text } = await callHost('readTextFile', { path });
      const data = JSON.parse(text);
      frSettings.history = Array.isArray(data.history) ? data.history : [];
      frSettings.pinned = Array.isArray(data.pinned) ? data.pinned : [];
    }
  } catch (err) {
    console.error('Failed to load find/replace settings', err);
  }
  refreshFindHistoryDatalist();
}

async function saveFindReplaceSettings() {
  if (!frSettingsPath) return;
  try { await callHost('writeTextFile', { path: frSettingsPath, text: JSON.stringify(frSettings, null, 2) }); }
  catch (err) { console.error('Failed to save find/replace settings', err); }
}

function refreshFindHistoryDatalist() {
  const dl = document.getElementById('frFindHistory');
  if (dl) dl.innerHTML = frSettings.history.map((h) => `<option value="${escapeHtml(h.find)}">`).join('');
}

// A pinned search's scope: which of Source / Target(s) "Run" applies it to.
// Missing entirely on searches saved before scope existed -- those default
// to both, matching the "always ran on Source + every Target" behavior they
// were saved under.
function scopeOf(pinned) {
  return pinned.scope
    ? { source: !!pinned.scope.source, targets: !!pinned.scope.targets }
    : { source: true, targets: true };
}

// Default scope for a *newly* pinned search: since Source and Targets are
// usually different languages, a search almost always belongs to just one
// side -- whichever column it was actually run against when pinned. Still
// just a starting point; either checkbox can be toggled after the fact.
function defaultScopeForColumn(colValue) {
  return colValue === 'source' ? { source: true, targets: false } : { source: false, targets: true };
}

// Keyed by "Find what" text -- re-using the same Find text updates (not
// duplicates) its remembered Replace/flag pairing and moves it to the front,
// which is the "remember which ones went together" behavior that was asked
// for. Also records into `pinned` (deduped the same way) when the "Add to
// Edit menu" box is checked at the time of the search -- preserving that
// entry's existing scope if it's an update, rather than resetting it back to
// a fresh default on every re-run.
function recordSearchHistory(opts) {
  if (!opts.find) return;
  frSettings.history = frSettings.history.filter((h) => h.find !== opts.find);
  frSettings.history.unshift({ ...opts });
  if (frSettings.history.length > 50) frSettings.history.length = 50;
  refreshFindHistoryDatalist();

  const pinCheckbox = document.getElementById('frPin');
  if (pinCheckbox && pinCheckbox.checked) {
    const existing = frSettings.pinned.find((p) => p.find === opts.find);
    const scope = existing ? scopeOf(existing) : defaultScopeForColumn(document.getElementById('frColumn').value);
    frSettings.pinned = frSettings.pinned.filter((p) => p.find !== opts.find);
    frSettings.pinned.unshift({ ...opts, scope });
  }
  saveFindReplaceSettings();
}

/* ---- Find/Replace panel open/close ---- */

// selection.col/row survive commitEditIfAny() (it only drops 'editing' back
// to 'cell', it doesn't clear which cell) -- so whichever cell was last
// clicked/edited is still known here even after the caller commits it first.
function currentSelectionColumnValue() {
  if (selection.col === 'source') return 'source';
  if (selection.col === 'target' && state.activeTargetIndex >= 0) return `target:${state.activeTargetIndex}`;
  return null;
}

function openFindReplacePanel() {
  refreshDynamicColumnMenus();
  refreshFindHistoryDatalist();
  const frColumn = document.getElementById('frColumn');
  const preferred = currentSelectionColumnValue();
  if (preferred && [...frColumn.options].some((o) => o.value === preferred) && frColumn.value !== preferred) {
    frColumn.value = preferred;
    findState = null;
    document.getElementById('frMatchInfo').textContent = '';
  }
  document.getElementById('findReplacePanel').hidden = false;
  document.getElementById('frFind').focus();
}
function closeFindReplacePanel() { document.getElementById('findReplacePanel').hidden = true; }

document.getElementById('frCloseBtn').addEventListener('click', closeFindReplacePanel);
document.getElementById('frFindNextBtn').addEventListener('click', doFindNext);
document.getElementById('frReplaceBtn').addEventListener('click', doReplace);
document.getElementById('frReplaceAllBtn').addEventListener('click', doReplaceAll);
document.getElementById('frColumn').addEventListener('change', () => {
  findState = null;
  document.getElementById('frMatchInfo').textContent = '';
});
document.getElementById('frFind').addEventListener('input', (e) => {
  findState = null;
  const match = frSettings.history.find((h) => h.find === e.target.value);
  if (match) {
    document.getElementById('frReplace').value = match.replace;
    document.getElementById('frRegex').checked = !!match.isRegex;
    document.getElementById('frCase').checked = !!match.caseSensitive;
    document.getElementById('frWholeWord').checked = !!match.wholeWord;
  }
});

/* ---- Saved Searches modal (searches pinned via "Add to Edit menu") ---- */

function openSavedSearchesModal() {
  renderSavedSearchesList();
  document.getElementById('savedSearchesOverlay').hidden = false;
}
function closeSavedSearchesModal() { document.getElementById('savedSearchesOverlay').hidden = true; }

function renderSavedSearchesList() {
  const list = document.getElementById('savedSearchesList');
  if (frSettings.pinned.length === 0) {
    list.innerHTML = '<p>No saved searches yet. Check "Add to Edit menu" in Find/Replace to save one.</p>';
    return;
  }
  list.innerHTML = frSettings.pinned.map((p, i) => {
    const scope = scopeOf(p);
    return `
    <div class="saved-search-row">
      <div class="saved-search-desc">Find: <code>${escapeHtml(p.find)}</code> &rarr; Replace: <code>${escapeHtml(p.replace)}</code>
        ${p.isRegex ? '<span class="tag">regex</span>' : ''}${p.caseSensitive ? '<span class="tag">case</span>' : ''}${p.wholeWord ? '<span class="tag">word</span>' : ''}
      </div>
      <label class="saved-search-scope"><input type="checkbox" data-scope-source="${i}" ${scope.source ? 'checked' : ''}> Source</label>
      <label class="saved-search-scope"><input type="checkbox" data-scope-targets="${i}" ${scope.targets ? 'checked' : ''}> Target(s)</label>
      <button data-run="${i}">Run</button>
      <button data-edit="${i}">Edit&hellip;</button>
      <button class="unpin" data-unpin="${i}" title="Remove">&times;</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-scope-source]').forEach((cb) => cb.addEventListener('change', () =>
    setPinnedScope(parseInt(cb.dataset.scopeSource, 10), { source: cb.checked })));
  list.querySelectorAll('[data-scope-targets]').forEach((cb) => cb.addEventListener('change', () =>
    setPinnedScope(parseInt(cb.dataset.scopeTargets, 10), { targets: cb.checked })));
  list.querySelectorAll('[data-run]').forEach((btn) => btn.addEventListener('click', () => runPinnedSearch(parseInt(btn.dataset.run, 10))));
  list.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => editSavedSearch(parseInt(btn.dataset.edit, 10))));
  list.querySelectorAll('[data-unpin]').forEach((btn) => btn.addEventListener('click', () => {
    frSettings.pinned.splice(parseInt(btn.dataset.unpin, 10), 1);
    saveFindReplaceSettings();
    renderSavedSearchesList();
  }));
}

function setPinnedScope(index, patch) {
  const p = frSettings.pinned[index];
  if (!p) return;
  p.scope = { ...scopeOf(p), ...patch };
  saveFindReplaceSettings();
}

// Loads a pinned search into the actual Find/Replace panel (rather than
// building a second set of Find/Replace/regex/case/whole-word editing UI
// inside this dialog) so it can be tweaked and even tried with Find Next
// before committing. "Add to Edit menu" stays checked, so re-running Find
// Next/Replace/Replace All from the panel updates this same pinned entry in
// place (recordSearchHistory dedupes pinned entries by Find text) -- unless
// the Find text itself is changed, which creates a new pinned entry instead
// (matching how Find-what history already works) and leaves the original
// one to be removed manually with its own × if it's no longer wanted.
// Shared by Edit... and Run: loads a pinned search's Find/Replace/flags into
// the actual Find/Replace panel and leaves "Add to Edit menu" checked, so
// running Find Next/Replace/Replace All from there updates this same pinned
// entry in place (recordSearchHistory dedupes pinned entries by Find text).
function loadPinnedIntoFindReplace(p) {
  openFindReplacePanel();
  document.getElementById('frFind').value = p.find;
  document.getElementById('frReplace').value = p.replace;
  document.getElementById('frRegex').checked = !!p.isRegex;
  document.getElementById('frCase').checked = !!p.caseSensitive;
  document.getElementById('frWholeWord').checked = !!p.wholeWord;
  document.getElementById('frPin').checked = true;
  findState = null;
  document.getElementById('frMatchInfo').textContent = '';
}

function editSavedSearch(index) {
  const p = frSettings.pinned[index];
  if (!p) return;
  closeSavedSearchesModal();
  loadPinnedIntoFindReplace(p);
}

// Deliberately does NOT replace every match unattended -- a saved search's
// Find text doesn't always need changing at every occurrence it matches, so
// this hands off to the Find/Replace panel (pre-loaded, starting on the
// first column its Source/Target(s) checkboxes cover) where each occurrence
// can be approved (Replace), skipped (Find Next), or bulk-applied (Replace
// All) -- the user's actual call, not an automatic one.
function runPinnedSearch(index) {
  const p = frSettings.pinned[index];
  if (!p) return;
  const scope = scopeOf(p);
  if (!scope.source && !scope.targets) {
    showToast('Check Source and/or Target(s) first to run this search.', true);
    return;
  }
  closeSavedSearchesModal();
  loadPinnedIntoFindReplace(p);

  const startCol = scope.source ? 'source' : (state.targets.length > 0 ? 'target:0' : null);
  const frColumn = document.getElementById('frColumn');
  if (startCol && [...frColumn.options].some((o) => o.value === startCol) && frColumn.value !== startCol) {
    frColumn.value = startCol;
    findState = null;
    document.getElementById('frMatchInfo').textContent = '';
  }

  if (scope.source && scope.targets) {
    showToast('Loaded into Find/Replace, starting on Source -- use the Column dropdown to move to each Target too.');
  } else if (scope.targets && state.targets.length > 1) {
    showToast(`Loaded into Find/Replace, starting on "${state.targets[0].name}" -- use the Column dropdown to move between targets.`);
  }
}

document.getElementById('savedSearchesCloseBtn').addEventListener('click', closeSavedSearchesModal);

/* ---- Break into Sentences ---- */

// Splits on run(s) of sentence-ending punctuation (Latin . ! ? plus the
// Devanagari/Arabic/Urdu/Ethiopic/CJK terminators the source texts use)
// optionally followed by closing quote marks and/or a closing parenthesis
// (e.g. a whole parenthetical paragraph ending "....)"), each of which may
// itself be preceded by a single space (e.g. "? ”") -- that space is a
// typesetting gap between the punctuation and its closer, not a sentence
// break, so it's stripped along with keeping the closer on the same line.
// Built via new RegExp(string) rather than a /regex/ literal -- a /literal/
// silently flattened the curly closing quotes (U+2019/U+201D) below to
// straight ones here once already; the string form round-tripped correctly.
const SENTENCE_END_RE = new RegExp('[.!?।؟۔።｡。]+( ?[\'"’”)])*', 'g');

function splitIntoSentences(text) {
  const re = new RegExp(SENTENCE_END_RE.source, 'g');
  const sentences = [];
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    // Collapse a space that sits directly before a closing quote/paren within
    // the matched punctuation+closer span (e.g. "? ”" -> "?”"). Only touches
    // spaces immediately preceding a closer -- never other spaces in the text.
    const cleanedMatch = m[0].replace(/ (?=[\'"’”)])/g, '');
    sentences.push((text.slice(lastIndex, m.index) + cleanedMatch).trim());
    lastIndex = end;
    if (m[0].length === 0) re.lastIndex++;
  }
  const rest = text.slice(lastIndex).trim();
  if (rest.length > 0) sentences.push(rest);
  return sentences.filter((s) => s.length > 0);
}

// Returns {newArr, splitCount, purgedCount} without touching state -- shared
// by the single-column and "both columns at once" entry points below.
// splitIntoSentences() already trims each piece and drops empty ones within
// one line's split; a line that's blank/whitespace-only (or collapses to
// nothing once trimmed) comes back as an empty `parts` array, which is
// pushed as-is (i.e. nothing) -- same "trim + skip blank" purge Import
// already applies, rather than leaving an empty placeholder row behind.
function splitArrayIntoSentences(arr) {
  const newArr = [];
  let splitCount = 0;
  let purgedCount = 0;
  for (const line of arr) {
    const parts = splitIntoSentences(line);
    if (parts.length > 1) splitCount++;
    if (parts.length === 0) purgedCount++;
    newArr.push(...parts);
  }
  return { newArr, splitCount, purgedCount };
}

function breakColumnIntoSentences(colValue) {
  const arr = getSearchArray(colValue);
  if (!arr) { showToast('No such column.', true); return; }

  const beforeSourceLen = state.sourceLines.length;
  const beforeRowCount = arr.length;
  const { newArr, splitCount, purgedCount } = splitArrayIntoSentences(arr);
  if (colValue === 'source') {
    state.sourceLines = newArr;
    notifyIfTargetsDrifted(beforeSourceLen);
  } else {
    const idx = parseInt(colValue.slice(7), 10);
    if (state.targets[idx]) state.targets[idx].lines = newArr;
  }
  markDirty();
  selection.mode = 'none';
  undoStack.length = 0; // row indices are wholesale renumbered; old undo entries no longer apply
  findState = null;
  renderAll();
  showToast(`Split ${splitCount} row(s) into multiple sentences (${beforeRowCount} → ${newArr.length} rows)`
    + (purgedCount ? `, purged ${purgedCount} blank row(s)` : '') + '.');
}

// Triggered by clicking the "Break into Sentences" menu label itself (as
// opposed to picking one column from its submenu) -- splits Source AND the
// currently-active Target together in one pass.
function breakBothIntoSentences() {
  const t = activeTarget();
  const beforeSourceLen = state.sourceLines.length;
  const beforeSourceRows = state.sourceLines.length;
  const beforeTargetRows = t ? t.lines.length : 0;

  const sourceResult = splitArrayIntoSentences(state.sourceLines);
  state.sourceLines = sourceResult.newArr;

  let targetResult = null;
  if (t) {
    targetResult = splitArrayIntoSentences(t.lines);
    t.lines = targetResult.newArr;
  }

  notifyIfTargetsDrifted(beforeSourceLen); // other (non-active) targets may now mismatch the new Source length
  markDirty();
  selection.mode = 'none';
  undoStack.length = 0;
  findState = null;
  renderAll();

  const describe = (label, before, result) =>
    `${label} ${before} → ${result.newArr.length} rows (${result.splitCount} split`
    + (result.purgedCount ? `, ${result.purgedCount} purged` : '') + ')';
  const parts = [describe('Source', beforeSourceRows, sourceResult)];
  if (t) parts.push(describe(t.name, beforeTargetRows, targetResult));
  showToast(`Split into sentences: ${parts.join('; ')}`);
}

// Opposite of splitArrayIntoSentences: collapses every row of a column back
// down to one, joined with a single space. Blank/whitespace-only rows are
// dropped rather than leaving stray double-spaces behind, same trim-and-
// skip-blank convention Import/Break-into-Sentences already use.
function joinArrayIntoParagraph(arr) {
  return arr.map((line) => (line || '').trim()).filter((line) => line.length > 0).join(' ');
}

function joinColumnIntoParagraph(colValue) {
  const arr = getSearchArray(colValue);
  if (!arr) { showToast('No such column.', true); return; }
  if (arr.length <= 1) { showToast(arr.length === 0 ? 'No rows to join.' : 'Already a single row.'); return; }

  const beforeSourceLen = state.sourceLines.length;
  const beforeRowCount = arr.length;
  const newArr = [joinArrayIntoParagraph(arr)];
  if (colValue === 'source') {
    state.sourceLines = newArr;
    notifyIfTargetsDrifted(beforeSourceLen);
  } else {
    const idx = parseInt(colValue.slice(7), 10);
    if (state.targets[idx]) state.targets[idx].lines = newArr;
  }
  markDirty();
  selection.mode = 'none';
  undoStack.length = 0; // row indices are wholesale renumbered; old undo entries no longer apply
  findState = null;
  renderAll();
  showToast(`Joined ${beforeRowCount} rows into a single paragraph.`);
}

// Triggered by clicking the "Join into Single Paragraph" menu label itself
// (as opposed to picking one column from its submenu) -- joins Source AND
// the currently-active Target together in one pass.
function joinBothIntoParagraph() {
  const t = activeTarget();
  const beforeSourceLen = state.sourceLines.length;
  const beforeSourceRows = state.sourceLines.length;
  const beforeTargetRows = t ? t.lines.length : 0;

  state.sourceLines = [joinArrayIntoParagraph(state.sourceLines)];
  if (t) t.lines = [joinArrayIntoParagraph(t.lines)];

  notifyIfTargetsDrifted(beforeSourceLen); // other (non-active) targets may now mismatch the new Source length
  markDirty();
  selection.mode = 'none';
  undoStack.length = 0;
  findState = null;
  renderAll();

  const parts = [`Source ${beforeSourceRows} → 1 row`];
  if (t) parts.push(`${t.name} ${beforeTargetRows} → 1 row`);
  showToast(`Joined into single paragraph: ${parts.join('; ')}.`);
}

/* =========================================================================
 * Project save / open / export
 * ========================================================================= */

function serializeProject() {
  return {
    formatVersion: 1,
    sourceFilePath: state.sourceFilePath,
    sourceLines: state.sourceLines,
    targets: state.targets,
    activeTargetIndex: state.activeTargetIndex,
    fonts: state.fonts,
  };
}

function loadProjectData(data) {
  state.sourceFilePath = data.sourceFilePath ?? null;
  state.sourceLines = Array.isArray(data.sourceLines) ? data.sourceLines : [];
  state.targets = Array.isArray(data.targets)
    ? data.targets.map((t) => ({ name: t.name ?? '', filePath: t.filePath ?? null, lines: Array.isArray(t.lines) ? t.lines : [] }))
    : [];
  state.activeTargetIndex = Number.isInteger(data.activeTargetIndex) ? data.activeTargetIndex : (state.targets.length ? 0 : -1);
  if (data.fonts) {
    state.fonts.info = { ...state.fonts.info, ...data.fonts.info };
    state.fonts.source = { ...state.fonts.source, ...data.fonts.source };
    state.fonts.target = { ...state.fonts.target, ...data.fonts.target };
    for (const col of ['info', 'source', 'target']) {
      // A project saved before this fix stored the full old CSS stack
      // (e.g. `"Nirmala UI", sans-serif`) as the family -- normalize it back
      // to a plain name so it displays correctly in the font modal and
      // doesn't double up into a broken stack via cssFontStack().
      state.fonts[col].family = sanitizeFontFamily(state.fonts[col].family) || DEFAULT_FONTS[col].family;
    }
  }
  applyFontsToCss();
}

async function writeProjectTo(path) {
  const json = JSON.stringify(serializeProject(), null, 2);
  await callHost('writeTextFile', { path, text: json });
}

function suggestedProjectPath() {
  const base = state.sourceFilePath || (state.targets[0] && state.targets[0].filePath) || null;
  if (!base) return '';
  return `${dirNameOf(base)}${sepFor(base)}${baseNameNoExt(base)}.paraproj`;
}

function suggestedExportPath(ext) {
  const base = state.projectPath || state.sourceFilePath || (state.targets[0] && state.targets[0].filePath) || null;
  if (!base) return '';
  return `${dirNameOf(base)}${sepFor(base)}${baseNameNoExt(base)}.${ext}`;
}

/* ---- Last browsed folder ----
 *
 * Source, Target(s), and the project file for one piece of work are usually
 * siblings in the same folder, so every open/save dialog remembers the
 * folder the last dialog actually resolved to (persisted to disk, so it's
 * still there on the next launch too) and starts there next time -- unless
 * that specific dialog already has a more relevant default (e.g. Save
 * defaults next to the currently open project). See chooseOpenFile/
 * chooseSaveFile below, which every dialog call goes through instead of
 * calling callHost directly. */

let lastBrowsedFolder = null;
let lastFolderPath = null;

async function loadLastBrowsedFolder() {
  try {
    const { path } = await callHost('getLastFolderPath', {});
    lastFolderPath = path;
    const { exists } = await callHost('fileExists', { path });
    if (exists) {
      const { text } = await callHost('readTextFile', { path });
      const data = JSON.parse(text);
      if (typeof data.folder === 'string') lastBrowsedFolder = data.folder;
    }
  } catch (err) {
    console.error('Failed to load last browsed folder', err);
  }
}

function rememberBrowsedFolder(path) {
  if (!path) return;
  lastBrowsedFolder = dirNameOf(path);
  if (!lastFolderPath) return;
  callHost('writeTextFile', { path: lastFolderPath, text: JSON.stringify({ folder: lastBrowsedFolder }) })
    .catch((err) => console.error('Failed to save last browsed folder', err));
}

async function chooseOpenFile(opts) {
  const defaultPath = opts.defaultPath || lastBrowsedFolder || '';
  const res = await callHost('chooseOpenFile', { ...opts, defaultPath });
  if (res.path) rememberBrowsedFolder(res.path);
  return res;
}

async function chooseSaveFile(opts) {
  const defaultPath = opts.defaultPath || lastBrowsedFolder || '';
  const res = await callHost('chooseSaveFile', { ...opts, defaultPath });
  if (res.path) rememberBrowsedFolder(res.path);
  return res;
}

/* ---- Combine Direction (per-machine preference, not saved in the project) ----
 *
 * Which way the action-gutter's quick combine button merges a cell -- with
 * the row below (Next) or above (Previous). Different people working on the
 * same project can have opposite habits here, so like the last-browsed-
 * folder this is persisted per-machine (%APPDATA%), not saved into the
 * project file itself -- opening someone else's project shouldn't flip your
 * own preference, and vice versa. */

let combineDirection = 'next'; // 'next' | 'previous'
let combineDirectionPath = null;

async function loadCombineDirection() {
  try {
    const { path } = await callHost('getCombineDirectionPath', {});
    combineDirectionPath = path;
    const { exists } = await callHost('fileExists', { path });
    if (exists) {
      const { text } = await callHost('readTextFile', { path });
      const data = JSON.parse(text);
      if (data.direction === 'next' || data.direction === 'previous') combineDirection = data.direction;
    }
  } catch (err) {
    console.error('Failed to load combine direction setting', err);
  }
}

function setCombineDirection(dir) {
  if (dir !== 'next' && dir !== 'previous') return;
  combineDirection = dir;
  refreshCombineDirectionMenu();
  renderBodyAndTabs(); // every row's action-gutter arrow/enabled-state depends on this
  if (combineDirectionPath) {
    callHost('writeTextFile', { path: combineDirectionPath, text: JSON.stringify({ direction: dir }) })
      .catch((err) => console.error('Failed to save combine direction setting', err));
  }
}

function refreshCombineDirectionMenu() {
  const submenu = document.getElementById('combineDirectionSubmenu');
  if (!submenu) return;
  submenu.querySelectorAll('[data-combine-dir]').forEach((btn) => {
    const label = btn.dataset.combineDir === 'next' ? 'Combine with Next' : 'Combine with Previous';
    btn.textContent = (btn.dataset.combineDir === combineDirection ? '✓ ' : '') + label;
  });
}

document.getElementById('combineDirectionSubmenu')?.querySelectorAll('[data-combine-dir]').forEach((btn) => {
  btn.addEventListener('click', () => { closeAllMenus(); setCombineDirection(btn.dataset.combineDir); });
});

/* ---- Recent Projects ---- */

let recentProjects = []; // full paths, most-recently-used first
let recentProjectsPath = null;
const RECENT_PROJECTS_LIMIT = 10;

async function loadRecentProjects() {
  try {
    const { path } = await callHost('getRecentProjectsPath', {});
    recentProjectsPath = path;
    const { exists } = await callHost('fileExists', { path });
    if (exists) {
      const { text } = await callHost('readTextFile', { path });
      const data = JSON.parse(text);
      recentProjects = Array.isArray(data.recent) ? data.recent : [];
    }
  } catch (err) {
    console.error('Failed to load recent projects', err);
  }
}

async function saveRecentProjects() {
  if (!recentProjectsPath) return;
  try { await callHost('writeTextFile', { path: recentProjectsPath, text: JSON.stringify({ recent: recentProjects }, null, 2) }); }
  catch (err) { console.error('Failed to save recent projects', err); }
}

// Only called once a real .paraproj is known to exist on disk (a successful
// Open, or a successful Save/Save As) -- never for the auto-derived-but-not-
// yet-saved path, since clicking a recent entry that doesn't exist yet would
// just be a dead link.
function recordRecentProject(path) {
  recentProjects = recentProjects.filter((p) => p !== path);
  recentProjects.unshift(path);
  if (recentProjects.length > RECENT_PROJECTS_LIMIT) recentProjects.length = RECENT_PROJECTS_LIMIT;
  saveRecentProjects();
  refreshRecentProjectsMenu();
}

function refreshRecentProjectsMenu() {
  const submenu = document.getElementById('recentProjectsSubmenu');
  if (!submenu) return;
  if (recentProjects.length === 0) {
    submenu.innerHTML = '<button disabled>No recent projects</button>';
    return;
  }
  submenu.innerHTML = recentProjects.map((p, i) =>
    `<button data-recent-index="${i}" title="${escapeHtml(p)}">${escapeHtml(baseNameWithExt(p))}</button>`
  ).join('');
  submenu.querySelectorAll('[data-recent-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeAllMenus();
      openRecentProject(recentProjects[parseInt(btn.dataset.recentIndex, 10)]);
    });
  });
}

/* ---- Unsaved-changes confirmation (shared by New Project and Exit) ---- */

// Resolves to 'save' | 'discard' | 'cancel'.
function confirmUnsavedChanges(actionLabel) {
  return new Promise((resolve) => {
    document.getElementById('unsavedChangesText').textContent =
      `You have unsaved changes. Save them before ${actionLabel}?`;
    document.getElementById('unsavedChangesOverlay').hidden = false;

    const saveBtn = document.getElementById('unsavedSaveBtn');
    const discardBtn = document.getElementById('unsavedDiscardBtn');
    const cancelBtn = document.getElementById('unsavedCancelBtn');

    const cleanup = () => {
      document.getElementById('unsavedChangesOverlay').hidden = true;
      saveBtn.removeEventListener('click', onSave);
      discardBtn.removeEventListener('click', onDiscard);
      cancelBtn.removeEventListener('click', onCancel);
    };
    const onSave = () => { cleanup(); resolve('save'); };
    const onDiscard = () => { cleanup(); resolve('discard'); };
    const onCancel = () => { cleanup(); resolve('cancel'); };

    saveBtn.addEventListener('click', onSave);
    discardBtn.addEventListener('click', onDiscard);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Resolves to 'overwrite' | 'saveAs' | 'cancel'.
function confirmOverwrite(path) {
  return new Promise((resolve) => {
    document.getElementById('overwriteWarningText').textContent =
      `A project file already exists at "${path}" (from an earlier session -- ` +
      `this one hasn't explicitly saved to it yet). Overwrite it, or Save As to pick a different name?`;
    document.getElementById('overwriteWarningOverlay').hidden = false;

    const overwriteBtn = document.getElementById('overwriteOverwriteBtn');
    const saveAsBtn = document.getElementById('overwriteSaveAsBtn');
    const cancelBtn = document.getElementById('overwriteCancelBtn');

    const cleanup = () => {
      document.getElementById('overwriteWarningOverlay').hidden = true;
      overwriteBtn.removeEventListener('click', onOverwrite);
      saveAsBtn.removeEventListener('click', onSaveAs);
      cancelBtn.removeEventListener('click', onCancel);
    };
    const onOverwrite = () => { cleanup(); resolve('overwrite'); };
    const onSaveAs = () => { cleanup(); resolve('saveAs'); };
    const onCancel = () => { cleanup(); resolve('cancel'); };

    overwriteBtn.addEventListener('click', onOverwrite);
    saveAsBtn.addEventListener('click', onSaveAs);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Runs the confirm-if-dirty flow, then calls onProceed() only if it's safe
// to continue (nothing was dirty, the user chose to discard, or Save
// actually completed). Shared by New Project and Exit.
async function withUnsavedChangesGuard(actionLabel, onProceed) {
  if (state.dirty) {
    const choice = await confirmUnsavedChanges(actionLabel);
    if (choice === 'cancel') return;
    if (choice === 'save') {
      const saved = await saveProject(false);
      if (!saved) return; // Save As was cancelled, or it failed -- don't proceed
    }
  }
  await onProceed();
}

async function newProject() {
  await withUnsavedChangesGuard('starting a new project', async () => {
    state.projectPath = null;
    state.hasExplicitlySaved = false;
    state.sourceFilePath = null;
    state.sourceLines = [];
    state.targets = [];
    state.activeTargetIndex = -1;
    state.dirty = false;
    selection.mode = 'none';
    undoStack.length = 0;
    findState = null;
    if (quoteInsertMode) stopQuoteInsertMode();
    await deleteRecoveryFile();
    renderAll();
    showToast('New project started.');
  });
}

async function exitApp() {
  await withUnsavedChangesGuard('exiting', async () => {
    await callHost('exit', {});
  });
}

async function openProject() {
  const res = await chooseOpenFile({
    title: 'Open Project',
    filters: [{ name: 'ParallelizeTexts Project', extensions: ['paraproj'] }],
  });
  if (!res.path) return;
  await loadProjectFromPath(res.path);
}

// Shared by the Open Project dialog and clicking an entry in Recent Projects.
async function loadProjectFromPath(path) {
  const { text } = await callHost('readTextFile', { path });
  loadProjectData(JSON.parse(text));
  state.projectPath = path;
  state.hasExplicitlySaved = true; // opening a real, named file counts as an established save location
  state.dirty = false;
  selection.mode = 'none';
  undoStack.length = 0;
  renderAll();
  await deleteRecoveryFile();
  recordRecentProject(path);
  showToast(`Project opened from ${path}`);
}

async function openRecentProject(path) {
  try {
    await loadProjectFromPath(path);
  } catch (err) {
    showToast(`Couldn't open ${path}: ${(err && err.message) || err}`, true);
    // Stale entry (file moved/deleted since) -- drop it rather than leave a dead link.
    recentProjects = recentProjects.filter((p) => p !== path);
    saveRecentProjects();
    refreshRecentProjectsMenu();
  }
}

// Returns true once the project is actually written to disk, false if the
// user cancelled the Save As dialog -- New Project and Exit both need to
// know which happened, so they don't proceed to clear/close on a cancel.
async function saveProject(forceDialog) {
  // Once a Source (or Target) is imported, projectPath is already the
  // auto-derived <name>.paraproj -- plain Save just writes there with no
  // dialog. forceDialog (Save As) always prompts, defaulting to wherever the
  // project currently is/would be, so the user can redirect it elsewhere.
  let path = (!forceDialog) ? state.projectPath : null;
  if (!path) {
    const res = await chooseSaveFile({
      title: 'Save Project',
      defaultPath: state.projectPath || suggestedProjectPath(),
      filters: [{ name: 'ParallelizeTexts Project', extensions: ['paraproj'] }],
    });
    if (!res.path) return false;
    path = res.path;
  } else if (!state.hasExplicitlySaved) {
    // A plain Save going straight to an auto-derived path (e.g. right after
    // New Project + re-importing the same Source) that this session has
    // never actually confirmed -- if a file's already sitting there, that's
    // very likely an earlier session's real project, not a blank slate.
    // Without this check it gets silently overwritten with no dialog ever
    // shown, since Save only prompts when projectPath *isn't* already known.
    let exists = false;
    try { ({ exists } = await callHost('fileExists', { path })); } catch { /* best-effort */ }
    if (exists) {
      const choice = await confirmOverwrite(path);
      if (choice === 'cancel') return false;
      if (choice === 'saveAs') return await saveProject(true);
      // 'overwrite' -- fall through and save to `path` below as normal.
    }
  }
  await writeProjectTo(path);
  state.projectPath = path;
  state.hasExplicitlySaved = true;
  state.dirty = false;
  updateTitleInfo();
  await deleteRecoveryFile();
  recordRecentProject(path);
  showToast(`Project saved to ${path}`);
  return true;
}

function exportProjectPayload() {
  return {
    sourceLines: state.sourceLines,
    targets: state.targets.map((t) => ({ name: t.name, lines: t.lines })),
  };
}

async function saveAsComparisonJson() {
  const res = await chooseSaveFile({
    title: 'Save Comparison JSON',
    defaultPath: suggestedExportPath('json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!res.path) return;
  await callHost('writeComparisonJson', { path: res.path, project: exportProjectPayload() });
  showToast(`Comparison JSON saved to ${res.path}`);
}

async function saveAsCsv() {
  const res = await chooseSaveFile({
    title: 'Save CSV',
    defaultPath: suggestedExportPath('csv'),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!res.path) return;
  await callHost('writeCsv', { path: res.path, project: exportProjectPayload() });
  showToast(`CSV saved to ${res.path}`);
}

/* =========================================================================
 * Fonts
 * ========================================================================= */

function applyFontsToCss() {
  const root = document.documentElement.style;
  root.setProperty('--info-font-family', cssFontStack('info', state.fonts.info.family));
  root.setProperty('--info-font-size', state.fonts.info.size + 'px');
  root.setProperty('--source-font-family', cssFontStack('source', state.fonts.source.family));
  root.setProperty('--source-font-size', state.fonts.source.size + 'px');
  root.setProperty('--target-font-family', cssFontStack('target', state.fonts.target.family));
  root.setProperty('--target-font-size', state.fonts.target.size + 'px');
}

function openFontModal() {
  document.querySelectorAll('#fontModal .font-row').forEach((row) => {
    const col = row.dataset.col;
    row.querySelector('.font-family').value = state.fonts[col].family;
    row.querySelector('.font-size').value = state.fonts[col].size;
  });
  document.getElementById('modalOverlay').hidden = false;
}
function closeFontModal() { document.getElementById('modalOverlay').hidden = true; }

document.getElementById('fontApply').addEventListener('click', () => {
  document.querySelectorAll('#fontModal .font-row').forEach((row) => {
    const col = row.dataset.col;
    const family = row.querySelector('.font-family').value.trim() || state.fonts[col].family;
    const size = parseInt(row.querySelector('.font-size').value, 10) || state.fonts[col].size;
    state.fonts[col] = { family, size };
  });
  applyFontsToCss();
  markDirty();
  closeFontModal();
});
document.getElementById('fontCancel').addEventListener('click', closeFontModal);

/* =========================================================================
 * Autosave + crash recovery
 * ========================================================================= */

let autosaveTimer = null;
function markDirty() {
  state.dirty = true;
  scheduleAutosave();
  updateTitleInfo();
}

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(doAutosave, 5000);
}

async function doAutosave() {
  if (!state.dirty) return;
  // Once the user has done a real Save/Save As/Open, autosave keeps that
  // exact file current. Before that -- even though projectPath is usually
  // already known (auto-derived from the Source file's name) -- autosave
  // deliberately still only writes to the crash-recovery file, so it never
  // silently creates/overwrites the real .paraproj before the user has
  // explicitly chosen to save.
  if (state.hasExplicitlySaved && state.projectPath) {
    try {
      await writeProjectTo(state.projectPath);
      state.dirty = false;
      updateTitleInfo();
    } catch (err) {
      console.error('Autosave failed', err);
    }
    return;
  }
  if (!state.recoveryPath) return;
  try {
    await writeProjectTo(state.recoveryPath);
    // dirty stays true -- only the crash-recovery copy is current.
  } catch (err) {
    console.error('Autosave failed', err);
  }
}

async function deleteRecoveryFile() {
  if (!state.recoveryPath) return;
  try { await callHost('deleteFile', { path: state.recoveryPath }); } catch { /* best-effort */ }
}

// Returns whether a recovery file was found (and its banner shown), so
// init() can decide whether it's safe to auto-load the last project on top
// of it -- crash-recovered data is more recent than any saved project file,
// so the two are never offered at once (see init()).
async function checkForRecovery() {
  try {
    const { exists } = await callHost('fileExists', { path: state.recoveryPath });
    if (exists) document.getElementById('recoveryBanner').hidden = false;
    return exists;
  } catch {
    return false; /* best-effort */
  }
}

document.getElementById('recoveryRestore').addEventListener('click', async () => {
  document.getElementById('recoveryBanner').hidden = true;
  const { text } = await callHost('readTextFile', { path: state.recoveryPath });
  loadProjectData(JSON.parse(text));
  state.projectPath = suggestedProjectPath(); // re-derive from the restored Source's own name/folder
  state.hasExplicitlySaved = false; // still not confirmed by a real Save this session
  state.dirty = true; // recovered content has not yet been saved to a real project path
  selection.mode = 'none';
  undoStack.length = 0;
  renderAll();
});
document.getElementById('recoveryDiscard').addEventListener('click', async () => {
  document.getElementById('recoveryBanner').hidden = true;
  await deleteRecoveryFile();
});

/* =========================================================================
 * Toast
 * ========================================================================= */

let toastTimer = null;
function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  // Longer messages (a full saved-file path, an error) get more time to read.
  const duration = Math.min(9000, Math.max(3500, msg.length * 60));
  toastTimer = setTimeout(() => { el.hidden = true; }, duration);
}

/* =========================================================================
 * Init
 * ========================================================================= */

async function init() {
  applyFontsToCss();
  let hasRecovery = false;
  try {
    const { path } = await callHost('getRecoveryFilePath', {});
    state.recoveryPath = path;
    hasRecovery = await checkForRecovery();
  } catch (err) {
    console.error('Failed to get recovery file path', err);
  }
  await loadFindReplaceSettings();
  await loadRecentProjects();
  await loadLastBrowsedFolder();
  await loadCombineDirection();
  refreshDynamicColumnMenus();
  refreshRecentProjectsMenu();
  refreshCombineDirectionMenu();

  // Auto-load the last project worked on, so a fresh launch picks up right
  // where you left off -- but only when there's nothing to recover; a
  // pending crash-recovery file represents more recent unsaved work than
  // any saved project, so that banner takes priority and this is skipped
  // (Restore/Discard on it re-derives its own project path anyway).
  if (!hasRecovery && recentProjects.length > 0) {
    try {
      await loadProjectFromPath(recentProjects[0]);
      return;
    } catch (err) {
      console.error('Failed to auto-load last project', err);
      const stale = recentProjects[0];
      recentProjects = recentProjects.filter((p) => p !== stale);
      saveRecentProjects();
      refreshRecentProjectsMenu();
    }
  }
  renderAll();
}

init();
