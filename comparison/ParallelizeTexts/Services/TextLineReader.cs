namespace ParallelizeTexts.Services;

public sealed record LineReadResult(string[] Lines, int BlankSkipped);

/// <summary>Reads a plain-text file's lines, trimmed, skipping any that are blank
/// (whitespace-only) -- same convention as BuildComparisonJson's -Source/-Target
/// import, so a stray blank line never turns into an empty grid row.</summary>
public static class TextLineReader
{
    public static LineReadResult ReadLines(string path)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"File not found: {path}");

        string[] rawLines = File.ReadAllLines(path);
        string[] lines = rawLines.Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
        return new LineReadResult(lines, rawLines.Length - lines.Length);
    }
}
