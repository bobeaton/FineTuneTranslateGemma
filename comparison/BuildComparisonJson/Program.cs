using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace BuildComparisonJson;

/// <summary>One line of the "Translators" array.</summary>
public sealed class TranslatorEntry
{
    public string Translator { get; set; } = string.Empty;
}

/// <summary>One line of a "Targets" array; Targets[j] corresponds to Translators[j].</summary>
public sealed class TargetEntry
{
    public string Target { get; set; } = string.Empty;
}

/// <summary>One line of the "Translations" array: a Source sentence plus its Targets,
/// one per translator (in the same order as the enclosing set's Translators array).</summary>
public sealed class TranslationItem
{
    public string Source { get; set; } = string.Empty;
    public List<TargetEntry> Targets { get; set; } = new();
}

/// <summary>The whole comparison file is a JSON array of these; this tool always
/// operates on element [0], creating it if the file doesn't exist yet.</summary>
public sealed class TranslatorSet
{
    public List<TranslatorEntry> Translators { get; set; } = new();
    public List<TranslationItem> Translations { get; set; } = new();
}

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static int Main(string[] args)
    {
        string? sourcePath = null;
        string? targetPath = null;
        string? explicitJsonPath = null;

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i].ToLowerInvariant())
            {
                case "-source":
                    sourcePath = RequireValue(args, ref i, "-Source");
                    break;
                case "-target":
                    targetPath = RequireValue(args, ref i, "-Target");
                    break;
                case "-json":
                    explicitJsonPath = RequireValue(args, ref i, "-Json");
                    break;
                default:
                    Console.Error.WriteLine($"Unrecognized argument: {args[i]}");
                    return PrintUsage();
            }
        }

        if (sourcePath is null == targetPath is null)
        {
            Console.Error.WriteLine("Specify exactly one of -Source or -Target.");
            return PrintUsage();
        }

        // Default output: same folder and base name as whichever input file this run
        // was given, with a .json extension -- so "-Source Genesis.txt" alone produces
        // "Genesis.json" next to it. Pass -Json explicitly to add a -Target translator
        // to that same file on a later run.
        string jsonPath = explicitJsonPath ?? DefaultJsonPathFor(sourcePath ?? targetPath!);

        try
        {
            var set = Load(jsonPath);

            if (sourcePath is not null)
                ApplySource(set, sourcePath);
            else
                ApplyTarget(set, targetPath!);

            NormalizeTargetLengths(set);
            Save(jsonPath, set);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            return 1;
        }
    }

    private static string DefaultJsonPathFor(string inputPath)
    {
        string fullInputPath = Path.GetFullPath(inputPath);
        string directory = Path.GetDirectoryName(fullInputPath)!;
        string baseName = Path.GetFileNameWithoutExtension(fullInputPath);
        return Path.Combine(directory, baseName + ".json");
    }

    private static string RequireValue(string[] args, ref int i, string switchName)
    {
        if (i + 1 >= args.Length)
            throw new ArgumentException($"{switchName} requires a file path argument.");
        return args[++i];
    }

    private static int PrintUsage()
    {
        Console.Error.WriteLine();
        Console.Error.WriteLine("Usage:");
        Console.Error.WriteLine("  BuildComparisonJson -Source <path-to-txt>  [-Json <path-to-comparison-json>]");
        Console.Error.WriteLine("  BuildComparisonJson -Target <path-to-txt>  [-Json <path-to-comparison-json>]");
        Console.Error.WriteLine();
        Console.Error.WriteLine("-Source sets Translations[i].Source from each line of the txt file.");
        Console.Error.WriteLine("-Target's file name (without extension) is looked up in the Translators");
        Console.Error.WriteLine("  array (added at the end if new), and each line becomes that translator's");
        Console.Error.WriteLine("  Targets[i] entry. Re-running with the same file name replaces its data.");
        Console.Error.WriteLine("-Json defaults to <same folder and base name as the -Source/-Target file>.json");
        Console.Error.WriteLine("  -- pass it explicitly on a later -Target run to add to that same file.");
        return 1;
    }

    private static TranslatorSet Load(string jsonPath)
    {
        if (!File.Exists(jsonPath))
        {
            Console.WriteLine($"{jsonPath} does not exist yet; starting a new file.");
            return new TranslatorSet();
        }

        string json = File.ReadAllText(jsonPath);
        var sets = JsonSerializer.Deserialize<List<TranslatorSet>>(json, JsonOptions);
        if (sets is null || sets.Count == 0)
            return new TranslatorSet();

        return sets[0];
    }

    private static void Save(string jsonPath, TranslatorSet set)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(jsonPath))!);
        string json = JsonSerializer.Serialize(new List<TranslatorSet> { set }, JsonOptions);
        File.WriteAllText(jsonPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        Console.WriteLine($"Saved {jsonPath}");
        Console.WriteLine($"  {set.Translators.Count} translator(s), {set.Translations.Count} translation item(s).");
    }

    /// <summary>Reads a text file's lines, trimmed, skipping any that are blank
    /// (whitespace-only) so stray blank lines in the source .txt don't turn into
    /// empty Translations entries. Applied the same way to -Source and -Target files
    /// so their line-to-item positions still line up with each other.</summary>
    private static string[] ReadLines(string path)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"File not found: {path}");

        string[] rawLines = File.ReadAllLines(path);
        string[] lines = rawLines.Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();

        int blankCount = rawLines.Length - lines.Length;
        if (blankCount > 0)
            Console.WriteLine($"  ({blankCount} blank line(s) skipped)");

        return lines;
    }

    private static void EnsureTranslationCount(TranslatorSet set, int count)
    {
        while (set.Translations.Count < count)
        {
            set.Translations.Add(new TranslationItem
            {
                Targets = Enumerable.Range(0, set.Translators.Count)
                                     .Select(_ => new TargetEntry())
                                     .ToList(),
            });
        }
    }

    private static void ApplySource(TranslatorSet set, string sourcePath)
    {
        string[] lines = ReadLines(sourcePath);
        Console.WriteLine($"-Source {sourcePath}: {lines.Length} line(s).");

        if (lines.Length < set.Translations.Count)
        {
            Console.WriteLine(
                $"  Note: file has fewer lines ({lines.Length}) than existing Translations items " +
                $"({set.Translations.Count}); items {lines.Length}..{set.Translations.Count - 1} were left untouched.");
        }

        EnsureTranslationCount(set, lines.Length);
        for (int i = 0; i < lines.Length; i++)
            set.Translations[i].Source = lines[i];
    }

    private static void ApplyTarget(TranslatorSet set, string targetPath)
    {
        string translatorName = Path.GetFileNameWithoutExtension(targetPath);
        string[] lines = ReadLines(targetPath);
        Console.WriteLine($"-Target {targetPath}: translator \"{translatorName}\", {lines.Length} line(s).");

        int translatorIndex = set.Translators.FindIndex(t => t.Translator == translatorName);
        if (translatorIndex < 0)
        {
            set.Translators.Add(new TranslatorEntry { Translator = translatorName });
            translatorIndex = set.Translators.Count - 1;
            Console.WriteLine($"  New translator added at index {translatorIndex}.");
        }
        else
        {
            Console.WriteLine($"  Existing translator found at index {translatorIndex}; replacing its Targets.");
        }

        if (lines.Length < set.Translations.Count)
        {
            Console.WriteLine(
                $"  Note: file has fewer lines ({lines.Length}) than existing Translations items " +
                $"({set.Translations.Count}); items {lines.Length}..{set.Translations.Count - 1} were left untouched for this translator.");
        }

        EnsureTranslationCount(set, lines.Length);
        for (int i = 0; i < lines.Length; i++)
        {
            var targets = set.Translations[i].Targets;
            while (targets.Count <= translatorIndex)
                targets.Add(new TargetEntry());
            targets[translatorIndex].Target = lines[i];
        }
    }

    /// <summary>Guarantees every Translations[i].Targets has exactly Translators.Count
    /// entries (padding with empty ones), so the two arrays always stay parallel --
    /// needed because adding a translator or growing Translations can happen in either
    /// order across separate runs of this tool.</summary>
    private static void NormalizeTargetLengths(TranslatorSet set)
    {
        foreach (var item in set.Translations)
        {
            while (item.Targets.Count < set.Translators.Count)
                item.Targets.Add(new TargetEntry());
        }
    }
}
