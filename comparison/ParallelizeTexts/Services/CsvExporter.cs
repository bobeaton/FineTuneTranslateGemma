using System.Text;

namespace ParallelizeTexts.Services;

/// <summary>Writes the grid as a "|"-delimited CSV: Source column, then one
/// column per target translator, one row per aligned line.</summary>
public static class CsvExporter
{
    public static void Write(string path, ExportProjectDto project)
    {
        int rowCount = project.SourceLines.Count;
        foreach (var target in project.Targets)
            rowCount = Math.Max(rowCount, target.Lines.Count);

        var sb = new StringBuilder();

        sb.Append("Source");
        foreach (var target in project.Targets)
        {
            sb.Append('|');
            sb.Append(CleanField(target.Name));
        }
        sb.Append('\n');

        for (int i = 0; i < rowCount; i++)
        {
            sb.Append(CleanField(i < project.SourceLines.Count ? project.SourceLines[i] : ""));
            foreach (var target in project.Targets)
            {
                sb.Append('|');
                sb.Append(CleanField(i < target.Lines.Count ? target.Lines[i] : ""));
            }
            sb.Append('\n');
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllText(path, sb.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    // The delimiter is "|", so any literal "|" or embedded line break in a cell
    // would silently corrupt the column alignment -- neither is expected in this
    // text's Devanagari prose, but they're swapped out defensively rather than
    // left to break the format if one ever sneaks in.
    private static string CleanField(string text) =>
        text.Replace('|', '｜').Replace("\r\n", " ").Replace('\n', ' ').Replace('\r', ' ');
}
