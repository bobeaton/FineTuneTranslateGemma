# ParallelizeTexts

A standalone desktop app for lining up a Source text file against one or more
Target (translation) text files line-by-line, fixing up cases where a
translator's line count doesn't match the source (split/merged sentences,
missing lines, etc.), and exporting the result either as a
[BuildComparisonJson](../BuildComparisonJson/)-compatible comparison file or a
`|`-delimited CSV.

It's a C#/.NET app with an HTML/CSS/JS front end rendered in a native webview
via [Photino.NET](https://www.tryphotino.io/) (WebView2 on Windows, WebKitGTK
on Linux, WKWebView on macOS) -- not a hosted web app; there's no server to
run, it's a single executable window. Everything but file dialogs and disk
I/O lives in the page's JavaScript; C# is just the native-dialog/file-I/O
bridge (see `Rpc/RpcRouter.cs`).

## Run

```powershell
cd comparison\ParallelizeTexts
dotnet run
```

Or build once and run the exe directly:

```powershell
dotnet build -c Release
.\bin\Release\net9.0\ParallelizeTexts.exe
```

## Sending this to someone else to run

To have someone else run this on their own Windows machine, with nothing to
install first (no .NET SDK/runtime, no `dotnet` on their PATH), publish a
self-contained single-file build:

```powershell
cd comparison\ParallelizeTexts
dotnet publish -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true
```

This produces `bin\Release\net9.0\win-x64\publish\`, containing
`ParallelizeTexts.exe` (~35 MB -- the whole .NET runtime plus every managed
dependency bundled in) and a `wwwroot\` folder next to it. `wwwroot` has to
stay a sibling of the exe (it's loaded by relative path at startup, same as
in `dotnet run`) -- delete the `.pdb` if present (debug symbols only, not
needed to run) and zip the `publish` folder itself, so unzipping on their
end keeps the exe and `wwwroot` together. They:

1. Unzip it anywhere and double-click `ParallelizeTexts.exe`.
2. Use **File > Import Source...** / **Import Target...** to load whatever
   `.txt` file(s) you sent them, or **File > Open Project...** if you sent a
   `.paraproj` instead.
3. Do the alignment work, then **File > Save As > Comparison JSON...** (or
   CSV, or **Save**/**Save As > Project...** to send a `.paraproj` back for
   further editing) and send that file back to you.

If the window fails to open on their machine (rare -- most Windows 10/11
installs already have it via Edge), they need the free
[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
from Microsoft; Photino renders through it.

## File menu

In menu order (Project-related items first, Import below the separator;
items with a `▸` at the right edge open a sub-dropdown):

- **Recent Projects** -- the last 10 `.paraproj` files actually opened or
  saved (label = file name, full path on hover), click one to open it
  directly with no dialog. Only real, on-disk files land here -- never the
  auto-derived-but-not-yet-saved path from a fresh Import, since that isn't
  a file yet. Persists across launches in
  `%APPDATA%\ParallelizeTexts\recent-projects.json`; a stale entry (moved or
  deleted since) is dropped from the list automatically the first time you
  try to open it and it's not there.
- **New Project** -- clears Source, every Target, and the project path back
  to a blank slate. If there are unsaved changes, prompts **Save / Don't
  Save / Cancel** first (see "Unsaved changes" below).
- **Open Project...** -- loads a previously-saved `.paraproj` file (Source
  lines, every imported Target's lines, fonts, everything). Counts as an
  established save location immediately (like doing a Save As to it).
- **Save** (**Ctrl+S**) -- writes to the project's established `.paraproj`
  path with no dialog. As soon as a Source (or, absent that, a Target) is
  imported, that path is already known -- same base name, same folder,
  `.paraproj` extension -- so Save works right away without needing a Save As
  first. If you later import a *different* Source file, its name/folder
  becomes the new project path (a different Source = a different project
  file).
- **Save As** (**Ctrl+A**) **> Project...** -- always opens a real Save
  dialog (defaulting to wherever the project currently is), so you can
  redirect this session to a specific folder/name instead of the
  auto-derived default. Ctrl+A only does this outside of text-editing, so
  it's still normal select-all-in-this-cell while a cell is being edited.
  - **Comparison JSON...** -- the same `{Translators, Translations}` shape
    `BuildComparisonJson` produces, ready to drop into the
    [rating webapp](../rating_webapp/). Rows are aligned by index across
    Source and every Target; short columns are padded with empty strings.
  - **CSV (&#124; delimited)...** -- `Source` column followed by one column
    per target translator, `|` as the delimiter. A literal `|` or newline
    inside a cell is swapped out (full-width `｜`, or a space) so it can't
    silently break the column alignment.
- **Import Source...** -- pick a `.txt` file; each line becomes one row's
  Source cell.
- **Import Target...** -- pick a `.txt` file; the file's name (without
  extension) becomes the translator's name and its lines fill the Target
  column. Re-importing a file with a name that matches an already-imported
  target **replaces** that target's lines in place; a new name is appended as
  a new tab (see "Multiple targets" below).
- **Delete Target ▸** -- lists every imported target by name; picking one
  asks for confirmation, then removes that whole column (all its rows) from
  the current working copy so you can re-import and start it over. This
  doesn't touch anything on disk -- Import Target can always bring it back
  in -- but any unsaved edits made to it are lost, and it clears the undo
  stack (an undo entry tagged for a target that just got removed, or that
  shifted to a different index, can't be replayed correctly).
- **Exit** -- same unsaved-changes prompt as New Project, then closes the
  app (only after a real Save completes, or you choose Don't Save).
- Both `Import` and both text-based `Save As` targets are trimmed and
  blank-line-filtered exactly like `BuildComparisonJson` does, so a stray
  blank line never becomes an empty row.

### Remembering the last folder browsed

Every Open/Save dialog (Open Project, Import Source, Import Target, Save As
Project/Comparison JSON/CSV) starts in whichever folder the *last* dialog of
any kind actually resolved to -- handy since a Source file and its Target(s)
are usually siblings in one folder, so picking the Source once means Import
Target already starts in the right place. A dialog that already has a more
specific default (e.g. Save defaulting next to the currently-open project)
uses that instead. Persists across launches in
`%APPDATA%\ParallelizeTexts\last-folder.json`.

### Unsaved changes (New Project, Exit)

If there are unsaved changes when you choose **New Project** or **Exit**, a
prompt asks **Save** / **Don't Save** / **Cancel**. **Cancel** aborts the
action entirely (project stays open, app stays running); **Don't Save**
proceeds without writing anything; **Save** runs a normal Save first (which
may itself open a Save As dialog if nothing's been explicitly saved yet) and
only proceeds if that save actually completes -- cancelling *that* dialog
cancels New Project/Exit too, rather than silently discarding.

### Overwrite warning (New Project + re-Save)

A plain **Save** never shows a dialog once a Source/Target import has
auto-derived a project path (see Save, above) -- which is exactly what makes
**New Project followed by re-importing the same Source file** risky: the
freshly-derived path is identical to whatever you'd saved that source as
*before* New Project cleared things, so a plain Save would silently
overwrite that earlier file with no prompt at all. This is now caught: the
first Save to an auto-derived path that this session hasn't explicitly
confirmed yet checks whether a file is already sitting there, and if so
asks **Overwrite** / **Save As...** / **Cancel** instead of writing over it
blind. Once you've explicitly saved (or opened) a given path in this
session, further plain Saves to it go straight through as normal -- this
check only fires for the *first* write to a path the session hasn't
confirmed.

Every text file read/written (Import, Open/Save Project, Comparison JSON,
CSV) goes through native OS file dialogs (Photino's `ShowOpenFile`/
`ShowSaveFile`), not a browser download/upload -- there's no file-size or
sandboxing limitation.

**Autosave vs. a real Save are deliberately different files** until you've
saved for real at least once this session: even though the project's
eventual `.paraproj` path is already known (see Save, above), autosave keeps
writing to `%APPDATA%\ParallelizeTexts\autosave-recovery.paraproj` only,
never silently creating/overwriting the real file on its own. The title bar
says `will save as <name>.paraproj -- not yet saved -- autosaving to
recovery` in this state. The moment you do a real Save/Save As/Open, that
`.paraproj` becomes the autosave target too (and the recovery file is deleted,
since it's no longer needed) and the title bar switches to `<name>.paraproj
-- saved`/`unsaved changes`.

### A real, found-and-fixed bug: Save As silently doing nothing

Confirmed root cause: Photino.NET 4.0.16's native `ShowSaveFile` silently
fails -- returns empty in a few milliseconds, no dialog ever shown, no
exception, nothing to catch -- whenever its `defaultPath` argument points to
a file that doesn't exist yet. That's *always* true for a fresh Save As
(you're creating a new file), so it broke every time. Verified directly
against the real `RpcRouter.Dispatch("chooseSaveFile", ...)` code path (not
just a standalone repro): an empty `defaultPath`, or one pointing to a file
that already exists, both work correctly (the dialog opens and blocks
waiting for real input); a full path to a nonexistent file returns instantly
with no dialog.

Fixed in `RpcRouter.cs`'s `chooseSaveFile` handler: if `defaultPath` points
to a file that doesn't exist yet (and its folder does), an empty placeholder
is touched into existence first -- so the dialog opens with the suggested
filename pre-filled -- then deleted afterward if the user cancels or saves
somewhere else. **A file that already has real content is never touched**;
only a genuinely-missing target gets a placeholder, so this can't ever
overwrite existing data. `[chooseSaveFile]`/`[writeTextFile]` lines are also
printed to the console (visible via `dotnet run` in a terminal) showing the
exact path used and whether the write completed, if this ever needs
diagnosing again.

## The grid

- Source is always shown; the Target column only appears once at least one
  target has been imported (Source is full-width until then).
- **Multiple targets**: every imported target gets a tab above the grid
  (labeled with its name). Only one Target column is shown at a time --
  clicking a tab switches which target's lines are shown/edited without
  losing any other target's data; all of them are held in memory (and saved)
  regardless of which tab is active.
- **Row-number gutter** (leftmost column): click it to select the whole row.
- **Info column** (only shown once a target is active), two lines per row:
  1. `<source word count>:<target word count>`
  2. `<source sentence count>/<source comma count>/<source quote count>:
     <target sentence count>/<target comma count>/<target quote count>` --
     sentence-enders are `. ! ? । ॥` (both Latin and Devanagari
     danda/double-danda); the quote count is every opening/closing
     curly/straight single/double quote mark (`' " ‘ ’ “ ”`) added together
     regardless of style -- it's "does one side have quote marks the other
     doesn't", not matching specific quote styles against each other.
     Whichever of sentence/comma/quote count actually differs between
     Source and Target is shown **bold and underlined** (on both the
     Source-side and Target-side number for that one), so the mismatched
     figure jumps out instead of having to compare all three pairs by eye.
  Hover any Info cell for a tooltip spelling both lines out in full, e.g.
  `# of Words in Source (9):Target (8)` / `# of Sentences (2/3)/Commas
  (1/0)/Quotation marks (3/2) -- Source/Target`.

  Background color flags likely misalignment:
  - orange if word counts differ by more than 11
  - yellow if sentence or quote counts differ, **or** if the Target has
    *fewer* commas than the Source. A Target with *more* commas than the
    Source (and matching sentence/quote counts) is deliberately **not**
    flagged -- that's usually just the target language's own punctuation
    conventions, not a sign of a dropped clause, so it's shown in the bold
    comma count above without the yellow background nagging about it.
  - red if both

  It also carries a small **×** at its right edge -- a shortcut for
  **Delete row (both)** (same as the right-click menu / row-gutter-then-
  Delete).
- **Action gutters** (only shown once a target is active): a narrow column
  immediately to the **left** of Source, and another immediately to the
  left of Target, each with two tiny shortcut buttons -- **×** (delete
  cell) and an arrow (combine cell) -- for that column. They lead their
  text column rather than trail it because deciding to delete or combine a
  cell is something you do while looking at the *beginning* of its text.
  These do exactly what the right-click menu's "Delete Source/Target cell"
  and "Combine Source/Target cell with next/previous" do (same undo entry,
  same toast) -- just one click instead of a right-click + menu pick. The
  combine arrow is greyed out wherever there's no row in that direction to
  merge with (e.g. the last row when combining with next). Which direction
  the arrow merges is a per-machine preference -- see **Settings > Combine
  Direction** below.

### Editing

Click any Source/Target cell to start editing it immediately, with the
cursor placed right where you clicked -- type normally, or press **Enter** to
split the cell at the cursor: the text before the cursor stays in this cell,
the text after it moves into a **new cell inserted directly below, in that
same column only** (Source and each Target are independent arrays -- editing
one never shifts the other). Pasting multi-line clipboard text does the same
kind of split across as many new rows as it has lines. Click-drag to select
a word/phrase with the mouse works normally too (a fixed bug: a drag-select
starting and ending in the same already-editing cell used to get collapsed
back to a single caret the instant you released the mouse button, because
the native "click" event that follows a same-element mousedown/mouseup was
re-running the click-to-edit logic and re-placing the caret at the drop
point; re-clicking/dragging within a cell already being edited is now left
alone so the browser's own selection handling stands).

**Deleting a whole cell or row** (not just a character) needs one extra step,
because a plain click always starts *editing* text (so Delete there means
"delete forward one character", exactly like a normal text box):

- Press **Escape** first to drop the cell out of edit mode into *selected*
  (blue outline, not editable) -- now **Delete** removes that single cell and
  shifts everything below it up one row, in that column only.
- Click the **row-number gutter** to select an entire row directly (no
  Escape needed) -- **Delete** there removes both the Source and Target cell
  at that row and shifts both columns up.

Both kinds of Delete can be undone with **Ctrl+Z** (Cmd+Z on macOS) or
**Edit > Undo**, which re-inserts the removed text at the same row --
restoring the correct target column even if you've switched tabs since
deleting. Undo only covers these Delete-triggered removals (not general
typing), and its history is cleared whenever you Import/Open something new
or delete a whole target. While a cell is actively being edited, Ctrl+Z is
left alone to do the browser's normal undo-typing instead -- **Edit > Undo**
always runs this app's own undo (committing whatever's being typed first),
since clicking a menu item isn't the same "let the browser handle it" case
the keyboard shortcut is carved out for.

### Target row-count warning

Since Source and every Target are independent arrays, editing Source (Delete/
Enter-split/paste/undo/Break into Sentences) can change its row count out
from under a Target you aligned earlier. Any target whose row count no
longer matches Source's gets a `*` on its tab plus an orange/red tint
(hover for a tooltip with the actual counts), and the moment an edit causes
this to newly happen to a target that matched a second ago, a toast names
which one(s) need re-checking. This is a coarse "row counts differ" signal
(same spirit as the Info column), not a deep alignment check -- two arrays
can coincidentally have equal length while still being misaligned in the
middle.

## Edit menu

### Find/Replace (Ctrl+F / Ctrl+H)

A floating panel (not a blocking dialog, so the grid stays visible/usable
behind it) that operates on one column at a time -- **Column** lists Source
plus every target by name, so you don't need to switch tabs first. Opening
it while a cell in Source or Target is selected/being edited preloads
**Column** with that cell's column (whichever target tab is active, for a
Target cell), instead of always defaulting to Source.

- **Find Next** jumps to (and selects) the next match, entering edit mode on
  that cell; **Wrap around** controls whether it loops back to the top when
  it runs out.
- **Replace** replaces the currently-found match, then advances to the next
  one (classic "replace-then-find-next" behavior). Clicking it with no
  active match just does a Find Next first.
- **Replace All** rewrites every matching occurrence across the whole
  column in one pass and reports how many replacements/rows changed.
- **Regular expression** treats Find what as a JS regex (supports groups and
  `$1`/`$&`/`$<name>` back-references in Replace with -- useful for things
  like a lookahead/lookbehind that inserts a comma next to certain words
  without consuming any text). **Whole word** wraps a literal search in
  `\b...\b` and is ignored/disabled in meaning once Regular expression is
  checked (your pattern controls its own boundaries then). **Case
  sensitive** adds/omits the `i` flag.
- **Find what** remembers your last 50 searches (a dropdown on that field);
  picking one from history also restores the Replace with text and all the
  checkboxes it was last used with, since "which Replace goes with which
  Find" is exactly what's remembered.
- **Add to Edit menu**: if checked when you search, that Find/Replace/flags
  combination is also pinned into **Saved Searches**.

History and pinned searches persist across launches in
`%APPDATA%\ParallelizeTexts\find-replace-history.json`.

### Saved Searches

Lists every pinned search, each with **Source** / **Target(s)** checkboxes
and a **Run** button. Since Source and Target(s) are usually different
languages, a given search is generally only meaningful for one side or the
other, so a newly-pinned search defaults to just whichever column it was
run against at the time -- Source alone, or all Target(s) together -- and
you can check the other box too (or switch which is checked) at any time;
that choice is remembered per search.

**Run** does *not* silently replace every match -- a saved search's Find
text doesn't always need changing at every occurrence it happens to match.
Instead it loads the search into the Find/Replace panel (same as
**Edit...**, below) starting on the first column its checkboxes cover, so
you step through it there: **Find Next** to skip an occurrence, **Replace**
to approve just that one, or **Replace All** to apply it to the whole
column in one pass -- your call per occurrence, or per column. If both
Source and Target(s) are checked (or there's more than one target), a toast
says so and you switch columns yourself with Find/Replace's **Column**
dropdown once you're done with the current one.

Each row also has an **Edit...** button, which loads that search back into
the Find/Replace panel (Find, Replace, and all its checkboxes, with "Add to
Edit menu" left checked) so you can tweak it first -- rather than
un-pinning and re-creating it from scratch; unlike **Run**, it leaves
**Column** wherever it already was. Running Find Next/Replace/Replace All
from the panel (whether opened via **Run** or **Edit...**) updates this
same pinned entry in place (scope included) unless the *Find* text itself
is changed, which creates a new pinned entry instead (pinned/history
entries are both keyed by Find text) and leaves the original one for its
own `×` if it's no longer wanted. Each row also has a `×` to unpin it
directly.

### Break into Sentences

Rewrites a column so every row holds exactly one sentence, splitting
wherever it finds sentence-ending punctuation (`. ! ? : । ؟ ۔ ። ｡ 。`)
optionally followed by a closing quote (straight or curly) and/or a closing
parenthesis `)` -- e.g. a whole parenthetical paragraph ending `....)` stays
on one row, as does a sentence ending `?"`. If there's a single space
between the punctuation and its closer (e.g. `? "`), that space is removed
and the closer still stays on the same row -- it's a typesetting gap, not a
sentence break. A row that's blank -- or was nothing but punctuation/
whitespace and split down to nothing -- is **purged** entirely rather than
left behind as an empty row,
the same trim-and-skip-blank convention Import already applies. Reports how
many rows were split, how many were purged, and the resulting row count.
This renumbers the whole column, so it clears undo history the same way
Import/Open does.

- Click the **Break into Sentences** label itself to split **both** Source
  and the currently-active Target together in one pass (each column purged
  independently -- their row counts can end up different, which is exactly
  what the row-count drift warning above is for).
- Hover it to open the submenu and pick **Source** or one specific target by
  name to split only that column.

### Join into Single Paragraph

The reverse of Break into Sentences: collapses every row of a column back
down into one, joining them with a single space (blank/whitespace-only rows
are dropped rather than leaving stray extra spaces behind). Reports how many
rows were joined. This renumbers the whole column, so it clears undo history
the same way Break into Sentences/Import/Open does.

- Click the **Join into Single Paragraph** label itself to join **both**
  Source and the currently-active Target together in one pass.
- Hover it to open the submenu and pick **Source** or one specific target by
  name to join only that column.

## Right-click on a row

Right-click a cell for a context menu. What you see depends on which column
you clicked:

- Right-click a **Source** or **Target** cell and the menu narrows to just
  that column's items, with the column name dropped from the label (since
  it's now obvious from where you clicked) -- e.g. **Combine with previous**
  instead of "Combine Source cell with previous". The other column's items
  aren't shown at all.
- Right-click the **Info** column or the row-number gutter -- still
  ambiguous as to which column you mean -- and you get everything, labeled
  with the column name (**Delete Source cell** / **Delete Target cell**,
  etc.), same as before.

**Delete row (both)** and **Click to insert quotes...** aren't column-
specific, so they always show regardless of which column you clicked.

- **Delete Source cell** / **Delete Target cell** (shown as **Delete cell**
  when right-clicking that column directly) -- same as Escape-then-Delete on
  that column, without leaving edit mode first.
- **Delete row (both)** -- same as clicking the row-number gutter then
  Delete.
- **Combine Source cell with previous** / **Combine Target cell with previous**
  (shown as **Combine with previous** when right-clicking that column
  directly) -- merges that column's cell in the row above into the clicked
  row (joined with a single space), then removes the now-emptied clicked
  row, shifting every later row up one. Only affects that one column -- the
  other column's rows are untouched. Disabled if there's no previous row in
  that column. (Same merge as "with next" below, just triggered from the
  second of the two cells instead of the first.)
- **Combine Source cell with next** / **Combine Target cell with next**
  (shown as **Combine with next** when right-clicking that column directly)
  -- merges that column's cell in the row below into the clicked row
  (joined with a single space), then removes the now-emptied row below it,
  shifting every later row up one. Only affects that one column -- the other
  column's rows are untouched. Disabled if there's no next row in that
  column.
- **Click to insert quotes (Left)/Commas (Right)...** -- a mode for placing
  quote marks and commas at a specific spot. After choosing it, in a Source
  or Target cell **in that same row**: **left-click** inserts a smart quote
  right there (`“` if the character right before the click is
  whitespace/start-of-line, `”` if it's preceded by actual text);
  **right-click** inserts a plain `,` there instead, without bringing up the
  context menu. Stays active for repeated clicks of either kind (e.g. one
  left-click for the opening quote, a right-click for a missing comma, then
  another left-click for the closing quote) until you press **Esc** or click
  (either button) a **different** row -- that click still behaves normally,
  it just also ends the mode. The status bar shows which row the mode is
  scoped to, and the cursor becomes a crosshair over Source/Target cells
  while it's on.

All of these are undoable with Ctrl+Z. (An earlier version of this menu also
had "Copy boundary punctuation: Source ↔ Target" commands, since removed.
If you're editing `index.html` by hand to change what's in this menu: any
`data-ctx` button referenced by `showContextMenu()` in `app.js` -- currently
`deleteTargetCell` and `deleteRow`, to grey them out when no Target is
loaded -- needs to keep existing there, or be removed from that function
too, or the lookup returns null and throws, which previously broke the
*entire* menu (it never appeared at all, not just that one item). Also, any
Source/Target-specific button needs `data-col="source"` or `data-col=
"target"` plus `data-label-both`/`data-label-only` attributes -- those drive
the column-narrowing and label-shortening behavior described above.)

## Settings > Fonts...

Set an independent font family + size for the Info, Source, and Target
columns (a `<datalist>` suggests a few Devanagari-friendly fonts -- Nirmala
UI, Noto Sans Devanagari, Mangal, Aparajita -- but any font name your system
has is fine). Takes effect immediately and is saved with the project.

Each font field takes just the plain font name (e.g. `Nirmala UI`, no quotes
or fallback keyword) -- a generic fallback (`sans-serif` for Source/Target,
`monospace` for Info) is appended automatically, so there's no CSS syntax to
get right by hand. Projects saved by an earlier version (which stored the
full CSS value, quotes and all) still load correctly -- it's normalized back
to a plain name the first time such a project is opened.

## Settings > Combine Direction

Picks which way the action gutter's combine arrow merges a cell: **Combine
with Next** (default -- merges the row below into this one, arrow points
down) or **Combine with Previous** (merges the row above into this one,
arrow points up). A checkmark on the current choice.

This is a per-machine setting (saved to `%APPDATA%\ParallelizeTexts\
combine-direction.json`, like the last-browsed-folder setting), not part of
the project file -- two people working on the same project from their own
machines can each pick whichever direction matches how they habitually
work, without affecting each other or needing to change it back and forth
per-project. The right-click menu is unaffected either way -- it still
always offers both **Combine with previous** and **Combine with next**
regardless of this setting.

## Startup: last project auto-loads

On launch, if there's no crash-recovery file pending (see below -- that
banner takes priority, since it represents more recent unsaved work), the
most recent entry in Recent Projects is loaded automatically, so the app
opens right back where you left off. If that file's gone missing since
(moved/deleted), it's silently dropped from Recent Projects and the app just
starts empty instead of erroring.

## Autosave / crash recovery

Every ~5 seconds after an edit:
- If the project has already been saved at least once, it's silently
  re-saved to that same `.paraproj` path (no dialog).
- If it hasn't been saved yet, a recovery copy is written instead to
  `%APPDATA%\ParallelizeTexts\autosave-recovery.paraproj` (Windows) / the
  platform equivalent of `ApplicationData` elsewhere. On next launch, if that
  file exists, a banner offers to **Restore** or **Discard** it. The recovery
  file is deleted as soon as you do a real Save/Open (it's only there to
  cover the "app crashed before I saved" case).

## Project file format (`.paraproj`)

Plain indented JSON, written/read verbatim by the JS side (`writeTextFile`/
`readTextFile` RPC actions) -- C# doesn't need to understand its shape at all
for Save/Open, only for the two exporters:

```json
{
  "formatVersion": 1,
  "sourceFilePath": "C:\\path\\to\\Genesis.txt",
  "sourceLines": ["...", "..."],
  "targets": [
    { "name": "NLLB-From-HCL", "filePath": "C:\\path\\to\\NLLB-From-HCL.txt", "lines": ["...", "..."] }
  ],
  "activeTargetIndex": 0,
  "fonts": {
    "info":   { "family": "Consolas, monospace", "size": 12 },
    "source": { "family": "\"Nirmala UI\", sans-serif", "size": 16 },
    "target": { "family": "\"Nirmala UI\", sans-serif", "size": 16 }
  }
}
```

## Status bar

Shows source/target row counts and how many rows are currently displayed
(the max of the two, since Source and Target can have different lengths --
see "The grid" above). A fixed bug: cell/row deletes, Enter-splits,
paste-splits, single Replace, and per-column Break into Sentences all
re-render through a path (`renderBodyAndTabs`) that used to skip refreshing
this bar, so after any of those it could keep showing stale counts from
whenever the full grid had last re-rendered (e.g. at Import) even though the
grid itself was already showing the current, correct data. It's not a
miscalculation -- `rowCount()` shown is genuinely `max(source, target)` --
just a display that wasn't being told to update as often as the data
actually changed; it now refreshes on every one of those operations.

## Testing notes

The C# side (`TextLineReader`, `ComparisonJsonExporter`, `CsvExporter`) was
verified directly (a scratch console app referencing this project's classes)
against a file with leading/trailing whitespace and both a whitespace-only
and a truly empty line: both were trimmed and skipped correctly, and the
comparison-JSON/CSV exports padded uneven-length target columns and
preserved Devanagari text correctly.

The app itself was launched and confirmed to open its window and complete a
round trip over the RPC channel (recovery-path lookup/exists check,
find-replace-history path/exists check) without errors. The sentence-boundary
regex (Latin/Devanagari/Arabic/Ethiopic/CJK terminators + straight/curly
closing quotes) was verified against sample text with .NET's regex engine
(same Unicode character-class semantics as JS for this pattern) -- it
correctly grouped a period + straight quote + curly quote together as one
boundary and split the next sentence after it. Worth noting for future edits
to that character class: writing it as a `/regex/` literal once silently
flattened the curly quotes to straight ones somewhere in the editing
pipeline; it's now built via `new RegExp('...')` from a string, which
round-tripped correctly, and it's worth re-verifying with a codepoint dump
(`ord()` per character) after any edit that touches it.

The grid/editing/menu behavior (click-to-edit, Enter-split, Escape-then-
Delete, row-gutter delete, right-click context menu, target tabs, font
settings, Find/Replace, Saved Searches, Break into Sentences, the row-count
drift warning, Save/Open) is implemented per the spec above but has **not**
been exercised through actual mouse/keyboard interaction in the running
window -- that requires a human at the keyboard. Please click through the
golden paths (import a source + target with mismatched line counts,
split/delete a few cells, switch target tabs, run a Find/Replace including a
regex with a lookahead, pin and re-run a saved search, break a multi-sentence
row apart, right-click a row and copy boundary punctuation between columns,
edit Source and confirm a previously-matching target gets flagged, save and
reopen a project, export both formats) before relying on it, and let me know
what breaks.

The `copyPunctuation` fill-in logic (opening quote, plus terminator/closing
quote checked and filled in *independently*) was verified against your exact
reported example -- `"तेरे पिता के पुत्र तुझे दण्डवत करेंगे।"` (Source) vs
`तेरे पिता देआं पुत्तरां तिज्‍जो चरण बंदना ह़ै।` (Target, already ending in
danda but with no quotes) -- via a PowerShell regex simulation of the same
pattern, producing `"तेरे पिता देआं पुत्तरां तिज्‍जो चरण बंदना ह़ै।"` (opening
and closing quotes added, existing danda left alone, nothing duplicated).
The first draft of this logic had a real bug caught by this same test: it
treated "terminator + optional closing quote" as one bundled check, so a
target already ending in danda (matching the pattern on its own, since the
quote part is optional) looked "already fine" and the missing closing quote
never got added -- fixed by checking the terminator and the closing quote
separately.

The Save As bug is now confirmed root-caused and fixed (see "A real,
found-and-fixed bug" above) -- verified against the actual
`RpcRouter.Dispatch("chooseSaveFile", ...)` code path, not a standalone
reimplementation: with the placeholder-touch fix, the native dialog now
opens and blocks waiting for real input in every case tested, where it
previously returned instantly with nothing. Along the way I also found and
reproduced a real native crash (`0xC0000005` access violation) in Photino's
dialog binding, but only when called *before* the window's message loop is
running -- not how this app calls it (every dialog call happens inside
`WebMessageReceived`, while the loop is already active) -- so that one
doesn't apply here.
