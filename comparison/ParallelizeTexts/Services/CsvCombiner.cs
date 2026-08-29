using System.Text;

namespace ParallelizeTexts.Services;

/// <summary>Appends the current project's Source + (first) Target lines onto
/// an existing delimited CSV, for the workflow of opening one *.paraproj
/// after another and folding each into the same growing master file. The
/// existing file's own header decides both the delimiter (whichever of
/// "|", ",", ";", tab actually splits the header into 2 or 3 columns) and
/// the shape: 2 columns means Source|Target, 3 columns means
/// Number|Source|Target, using the four-digit number pulled from the
/// project's file name (e.g. "0050_...paraproj" -&gt; "0050"). Any other
/// column count is refused rather than guessed at.</summary>
public static class CsvCombiner
{
    public sealed class Result
    {
        public bool Ok { get; set; }
        public string? Error { get; set; }
        public string? ErrorType { get; set; }
        public int RowsAdded { get; set; }
    }

    // Tried in this order against the header row; the first one that splits
    // it into exactly 2 or 3 columns wins. "|" stays first since it's this
    // app's own export format.
    private static readonly char[] CandidateDelimiters = { '|', ',', ';', '\t' };

    // Backs up each target path exactly once per process run -- tracked in
    // memory (not "does a .bak already exist on disk") so a stale backup left
    // over from an earlier session is never mistaken for "already backed up
    // this run" and skipped.
    private static readonly HashSet<string> BackedUpPaths = new(StringComparer.OrdinalIgnoreCase);

    public static Result Combine(string path, ExportProjectDto project, string? numberValue)
    {
        string fullPath = Path.GetFullPath(path);
        if (!File.Exists(fullPath))
            return new Result { Ok = false, Error = $"File not found: {fullPath}", ErrorType = "notFound" };

        string existingText = File.ReadAllText(fullPath);
        string headerLine = existingText.Split('\n')[0].TrimEnd('\r');
        if (headerLine.Length == 0)
            return new Result { Ok = false, Error = "The selected CSV file is empty (no header row).", ErrorType = "badColumnCount" };

        char? delimiter = null;
        int columnCount = 0;
        foreach (char candidate in CandidateDelimiters)
        {
            int count = headerLine.Split(candidate).Length;
            if (count == 2 || count == 3)
            {
                delimiter = candidate;
                columnCount = count;
                break;
            }
        }

        if (delimiter == null)
        {
            return new Result
            {
                Ok = false,
                Error = $"Couldn't find a delimiter in \"{Path.GetFileName(fullPath)}\"'s header row that splits it into " +
                        "2 or 3 columns (tried |, comma, semicolon, tab). This feature only supports files shaped as " +
                        "Source|Target (2 columns) or Number|Source|Target (3 columns).",
                ErrorType = "badColumnCount",
            };
        }

        if (columnCount == 3 && string.IsNullOrEmpty(numberValue))
        {
            return new Result
            {
                Ok = false,
                Error = "The target CSV has 3 columns, expecting a four-digit number in column 1, but no " +
                        "four-digit number could be found in the current project's file name.",
                ErrorType = "missingNumber",
            };
        }

        var targetLines = project.Targets.Count > 0 ? project.Targets[0].Lines : new List<string>();
        int rowCount = Math.Max(project.SourceLines.Count, targetLines.Count);
        if (rowCount == 0)
            return new Result { Ok = false, Error = "Nothing to add: the project has no Source or Target lines.", ErrorType = "empty" };

        if (BackedUpPaths.Add(fullPath))
            File.Copy(fullPath, fullPath + ".bak", overwrite: true);

        char d = delimiter.Value;
        var sb = new StringBuilder();
        if (!existingText.EndsWith("\n"))
            sb.Append('\n');

        for (int i = 0; i < rowCount; i++)
        {
            string source = CleanField(i < project.SourceLines.Count ? project.SourceLines[i] : "", d);
            string target = CleanField(i < targetLines.Count ? targetLines[i] : "", d);
            if (columnCount == 3)
                sb.Append(numberValue).Append(d).Append(source).Append(d).Append(target);
            else
                sb.Append(source).Append(d).Append(target);
            sb.Append('\n');
        }

        File.AppendAllText(fullPath, sb.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return new Result { Ok = true, RowsAdded = rowCount };
    }

    // Same convention as CsvExporter, generalized to whatever delimiter this
    // file actually uses: a literal delimiter character or embedded line
    // break in a cell would corrupt column alignment, so it's swapped out --
    // for a printable ASCII delimiter (|, comma, semicolon, ...) that's its
    // fullwidth Unicode lookalike (e.g. "," -> "，"), which reads the same
    // but can never be re-split on; tab has no such lookalike so it's just
    // dropped to a space like newlines are.
    private static string CleanField(string text, char delimiter)
    {
        string cleaned = text.Replace("\r\n", " ").Replace('\n', ' ').Replace('\r', ' ');
        char replacement = (delimiter >= '!' && delimiter <= '~') ? (char)(delimiter + 0xFEE0) : ' ';
        return cleaned.Replace(delimiter, replacement);
    }
}
