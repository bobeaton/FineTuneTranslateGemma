# Translation preference rating tool

A local webpage for blind-comparing translations from multiple translators
and recording which one a human rater prefers.

## Run

```powershell
cd comparison\rating_webapp
..\..\.venv\Scripts\python.exe app.py
```

A browser tab opens automatically at <http://localhost:5050/>.

## Data in / results out

- On startup, reopens whichever comparison JSON was last opened (remembered
  in `last_file.txt` in this folder), or else `TranslationSamplesToCompare.json`
  from `C:\Users\pete_\Dropbox\NTprogress\TranslateGemma\` (path in
  `settings.py`, overridable with the `DATA_FILE` env var). If neither
  exists, the page starts empty with a prompt to open a file.
- **Open file...** in the page pops a native file-open dialog to switch to
  any other comparison JSON at any time. The file is read fresh every time
  it's (re)loaded, so you can add more sets/translations to it without
  restarting the server.
- **Show in folder** opens Windows Explorer with the currently-loaded file
  selected -- handy for finding it again afterwards (e.g. to email it back).
- Expected shape: an array of `{Translators: [{Translator: name}, ...],
  Translations: [{Source, Targets: [{Target: text}, ...]}, ...]}` objects,
  where `Translations[i].Targets[j]` came from `Translators[j]`.
- Ratings are written back into the loaded file itself -- each rated
  `Translations[i]` gets a `Rating: {ranked, excluded}` field -- so reopening
  that same file (via Open file... or on the next server restart) resumes
  exactly where rating left off, with every earlier choice intact and
  re-viewable.

## How it works

- One `Source` sentence is shown at a time, with its `Target` translations
  below as unlabeled cards (translator identity is hidden while rating, so
  the choice is blind). If two translators produced the exact same text for
  an item, they're merged into a single card and both get credited whatever
  rank that card ends up at.
- Drag a card by its &#9863; handle to reorder (best on top), or use the
  &#9650;/&#9660; buttons. Click **&#10005;** to mark a translation "bad" —
  it moves to an Excluded section and won't count in the summary. Click
  **&#8617;** on an excluded card to restore it.
- **Back** / **Next** move between items (Back doesn't lose your work —
  everything autosaves as you interact). **Finish** on the last item opens
  the summary. **View Summary** is available at any time.
- Summary shows, per translator: average rank received (lower = more
  preferred), how many times it was ranked #1, how many times it was marked
  bad, and how many items it was rated in.

Reloading the page resumes at the first not-yet-rated item.

## Sending this to someone else to run

To have someone else do rating on their own Windows machine (rather than
hosting this somewhere and having them connect to it over the network),
package it as a single standalone `.exe` -- no Python install needed on
their end:

```powershell
cd comparison\rating_webapp
..\..\.venv\Scripts\python.exe -m pip install pyinstaller
..\..\.venv\Scripts\pyinstaller.exe --onefile --name TranslationRatingTool `
    --add-data "templates;templates" app.py
```

This produces `dist\TranslationRatingTool.exe` (~15 MB, fully self-contained).
Send them that one file plus whichever comparison JSON(s) you want rated
(anywhere on their machine, e.g. their Desktop or Downloads folder). They:

1. Double-click `TranslationRatingTool.exe` (a console window opens -- leave
   it running in the background; a browser tab opens automatically).
2. Click **Open file...** and pick the JSON file you sent them.
3. Rate away -- ratings autosave into that same file as they go.
4. Click **Show in folder** at any point to jump straight to the file in
   Explorer, so they can attach/send it back to you (email, etc.).
5. Close the console window when done.

Since ratings are written directly into whatever file was opened, `last_file.txt`
(created next to the exe) just remembers what to reopen if they relaunch it --
nothing needs to be hardcoded or pre-configured, and it works for as many
different comparison files as you send them, one at a time.

`build\` and `TranslationRatingTool.spec` are left behind by the build --
the `.spec` file is reusable in the same command; `build\` is a temporary
cache and can be deleted freely.
