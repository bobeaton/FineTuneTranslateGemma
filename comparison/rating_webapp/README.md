# Translation preference rating tool

A local webpage for blind-comparing translations from multiple translators
and recording which one a human rater prefers.

## Run

```powershell
cd comparison\rating_webapp
..\..\.venv\Scripts\python.exe app.py
```

Browse to <http://localhost:5050/>.

## Data in / results out

- On startup, reads whichever comparison JSON was last opened (remembered in
  `last_file.txt` in this folder), or else `TranslationSamplesToCompare.json`
  from `C:\Users\pete_\Dropbox\NTprogress\TranslateGemma\` (path in
  `settings.py`, overridable with the `DATA_FILE` env var).
- **Load file...** in the page lets you switch to any other comparison JSON
  at any time -- paste its full path and click Load. The file is read fresh
  every time it's (re)loaded, so you can add more sets/translations to it
  without restarting the server.
- Expected shape: an array of `{Translators: [{Translator: name}, ...],
  Translations: [{Source, Targets: [{Target: text}, ...]}, ...]}` objects,
  where `Translations[i].Targets[j]` came from `Translators[j]`.
- Ratings are written back into the loaded file itself -- each rated
  `Translations[i]` gets a `Rating: {ranked, excluded}` field -- so reopening
  that same file (via Load file... or on the next server restart) resumes
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
