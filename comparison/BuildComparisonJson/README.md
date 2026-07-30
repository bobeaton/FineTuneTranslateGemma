# BuildComparisonJson

Builds/updates a translation-comparison JSON file (the format the
[rating webapp](../rating_webapp/) reads) from plain text files, one
line/paragraph per translation.

## Usage

```powershell
dotnet run -- -Source "C:\path\to\Genesis5-21-6-3.txt"
dotnet run -- -Target "C:\path\to\NLLB-From-HCL.txt"      -Json "C:\path\to\Genesis5-21-6-3.json"
dotnet run -- -Target "C:\path\to\TranslateGemma-From-HCL.txt" -Json "C:\path\to\Genesis5-21-6-3.json"
```

Or build once and run the exe directly:

```powershell
dotnet build -c Release
.\bin\Release\net9.0\BuildComparisonJson.exe -Source "C:\path\to\Genesis5-21-6-3.txt"
```

- `-Source <file>`: each line becomes `Translations[i].Source`.
- `-Target <file>`: the file name (without extension) is the translator's
  name. It's looked up in the `Translators` array -- added at the end if
  new -- and each line becomes that translator's `Targets[i]` entry.
- Exactly one of `-Source` / `-Target` per run.
- Re-running with the same source or target file name **replaces** that
  file's previously-written data in place; it does not duplicate entries.
- `-Json <file>` (optional): the comparison JSON to read/write. Defaults to
  the same folder and base file name as whichever of `-Source`/`-Target` was
  given, with a `.json` extension -- e.g. `-Source Genesis5-21-6-3.txt` alone
  writes `Genesis5-21-6-3.json` next to it. Pass `-Json` explicitly on later
  `-Target` runs so they add to that same file instead of each creating
  their own.

## Notes

- Lines are trimmed, and blank (whitespace-only) lines are skipped -- so a
  stray blank line in the .txt doesn't turn into an empty `Translations`
  entry. This is applied the same way to every `-Source`/`-Target` file, so
  their line-to-item positions still line up with each other.
- If a file has fewer lines than the number of existing `Translations`
  items, the extra items are left untouched (a console note says so) rather
  than being deleted.
- If a file has more lines than currently exist, new `Translations` items
  are added as needed, and every item's `Targets` array is kept the same
  length as `Translators` (padded with empty entries) so the two arrays
  always stay parallel.
