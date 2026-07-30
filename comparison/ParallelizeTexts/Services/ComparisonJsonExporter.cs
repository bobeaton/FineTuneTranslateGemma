using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace ParallelizeTexts.Services;

// Mirrors the shape BuildComparisonJson and the rating_webapp already read:
// a JSON array with one {Translators, Translations} set, Translations[i].Targets[j]
// corresponding to Translators[j].
public sealed class ComparisonTranslatorEntry { public string Translator { get; set; } = ""; }
public sealed class ComparisonTargetEntry { public string Target { get; set; } = ""; }
public sealed class ComparisonTranslationItem
{
    public string Source { get; set; } = "";
    public List<ComparisonTargetEntry> Targets { get; set; } = new();
}
public sealed class ComparisonTranslatorSet
{
    public List<ComparisonTranslatorEntry> Translators { get; set; } = new();
    public List<ComparisonTranslationItem> Translations { get; set; } = new();
}

/// <summary>Writes the grid's current Source/Targets as a BuildComparisonJson-
/// compatible file, so it can be dropped straight into the rating webapp.</summary>
public static class ComparisonJsonExporter
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static void Write(string path, ExportProjectDto project)
    {
        int rowCount = project.SourceLines.Count;
        foreach (var target in project.Targets)
            rowCount = Math.Max(rowCount, target.Lines.Count);

        var set = new ComparisonTranslatorSet
        {
            Translators = project.Targets.Select(t => new ComparisonTranslatorEntry { Translator = t.Name }).ToList(),
        };

        for (int i = 0; i < rowCount; i++)
        {
            var item = new ComparisonTranslationItem
            {
                Source = i < project.SourceLines.Count ? project.SourceLines[i] : "",
            };
            foreach (var target in project.Targets)
            {
                item.Targets.Add(new ComparisonTargetEntry
                {
                    Target = i < target.Lines.Count ? target.Lines[i] : "",
                });
            }
            set.Translations.Add(item);
        }

        string json = JsonSerializer.Serialize(new List<ComparisonTranslatorSet> { set }, JsonOptions);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllText(path, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }
}
