using System.Text;
using System.Text.Json;
using Photino.NET;
using ParallelizeTexts.Services;

namespace ParallelizeTexts.Rpc;

/// <summary>Dispatches JS-initiated RPC calls to the small set of things the
/// webview can't do itself: native file/save dialogs, disk I/O, and the
/// project-shape-aware exporters. Everything else (grid state, editing,
/// rendering) lives entirely in JS; C# never reaches back into the page.</summary>
public static class RpcRouter
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private sealed class FilterDto { public string Name { get; set; } = ""; public string[] Extensions { get; set; } = Array.Empty<string>(); }
    private sealed class DialogPayload
    {
        public string Title { get; set; } = "";
        public string? DefaultPath { get; set; }
        public bool MultiSelect { get; set; }
        public List<FilterDto> Filters { get; set; } = new();
    }
    private sealed class PathPayload { public string Path { get; set; } = ""; }
    private sealed class TextFilePayload { public string Path { get; set; } = ""; public string Text { get; set; } = ""; }
    private sealed class ExportPayload { public string Path { get; set; } = ""; public ExportProjectDto Project { get; set; } = new(); }
    private sealed class MessagePayload { public string Title { get; set; } = ""; public string Text { get; set; } = ""; public string Icon { get; set; } = "info"; }

    public static object? Dispatch(PhotinoWindow window, string action, JsonElement payload)
    {
        switch (action)
        {
            case "chooseOpenFile":
            {
                var p = payload.Deserialize<DialogPayload>(JsonOptions)!;
                var filters = p.Filters.Select(f => (f.Name, f.Extensions)).ToArray();
                Console.WriteLine($"[chooseOpenFile] title=\"{p.Title}\" defaultPath=\"{p.DefaultPath}\"");
                string[] chosen = window.ShowOpenFile(p.Title, p.DefaultPath ?? "", p.MultiSelect, filters);
                Console.WriteLine($"[chooseOpenFile] user picked: {(chosen.Length > 0 ? chosen[0] : "(cancelled)")}");
                return new { path = chosen.Length > 0 ? chosen[0] : null };
            }
            case "chooseSaveFile":
            {
                var p = payload.Deserialize<DialogPayload>(JsonOptions)!;
                var filters = p.Filters.Select(f => (f.Name, f.Extensions)).ToArray();

                // Photino's native ShowSaveFile silently fails -- returns empty
                // in a few milliseconds, no dialog ever shown -- whenever
                // defaultPath points to a file that doesn't exist yet, which is
                // always true for a fresh Save As. Confirmed by direct testing:
                // an empty defaultPath or one pointing to an EXISTING file both
                // work correctly; a nonexistent full file path doesn't.
                // Work around it by touching an empty placeholder into existence
                // first (only when nothing is there yet -- never touch a file
                // that already has real content), so the dialog still opens
                // with the suggested filename pre-filled, then clean the
                // placeholder back up if the user cancels or saves elsewhere.
                string defaultPath = p.DefaultPath ?? "";
                string? placeholderCreated = null;
                if (!string.IsNullOrEmpty(defaultPath))
                {
                    string fullPath = Path.GetFullPath(defaultPath);
                    if (Directory.Exists(fullPath))
                    {
                        // defaultPath is a bare folder (e.g. "start in the last
                        // browsed folder" with no specific file suggested) --
                        // that's a valid starting directory for Photino as-is,
                        // no filename to preserve, so skip the placeholder
                        // workaround below (which exists only for that case).
                        defaultPath = fullPath;
                    }
                    else
                    {
                        string? dir = Path.GetDirectoryName(fullPath);
                        if (dir != null && Directory.Exists(dir) && !File.Exists(fullPath))
                        {
                            File.WriteAllText(fullPath, "");
                            placeholderCreated = fullPath;
                            defaultPath = fullPath;
                        }
                        else if (dir == null || !Directory.Exists(dir))
                        {
                            defaultPath = "";
                        }
                    }
                }

                Console.WriteLine($"[chooseSaveFile] title=\"{p.Title}\" defaultPath=\"{defaultPath}\"" + (placeholderCreated != null ? " (placeholder touched)" : ""));
                string chosen = window.ShowSaveFile(p.Title, defaultPath, filters);
                Console.WriteLine($"[chooseSaveFile] user picked: {(string.IsNullOrEmpty(chosen) ? "(cancelled)" : chosen)}");

                if (placeholderCreated != null && placeholderCreated != chosen && File.Exists(placeholderCreated))
                {
                    try { File.Delete(placeholderCreated); } catch { /* best-effort cleanup */ }
                }

                return new { path = string.IsNullOrEmpty(chosen) ? null : chosen };
            }
            case "readLines":
            {
                var p = payload.Deserialize<PathPayload>(JsonOptions)!;
                var result = TextLineReader.ReadLines(p.Path);
                return new { lines = result.Lines, blankSkipped = result.BlankSkipped };
            }
            case "readTextFile":
            {
                var p = payload.Deserialize<PathPayload>(JsonOptions)!;
                if (!File.Exists(p.Path))
                    throw new FileNotFoundException($"File not found: {p.Path}");
                return new { text = File.ReadAllText(p.Path) };
            }
            case "writeTextFile":
            {
                var p = payload.Deserialize<TextFilePayload>(JsonOptions)!;
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(p.Path))!);
                File.WriteAllText(p.Path, p.Text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
                Console.WriteLine($"[writeTextFile] wrote {p.Text.Length} char(s) to \"{p.Path}\" (exists now: {File.Exists(p.Path)})");
                return new { ok = true };
            }
            case "writeComparisonJson":
            {
                var p = payload.Deserialize<ExportPayload>(JsonOptions)!;
                ComparisonJsonExporter.Write(p.Path, p.Project);
                return new { ok = true };
            }
            case "writeCsv":
            {
                var p = payload.Deserialize<ExportPayload>(JsonOptions)!;
                CsvExporter.Write(p.Path, p.Project);
                return new { ok = true };
            }
            case "showMessage":
            {
                var p = payload.Deserialize<MessagePayload>(JsonOptions)!;
                var icon = p.Icon.ToLowerInvariant() switch
                {
                    "error" => PhotinoDialogIcon.Error,
                    "warning" => PhotinoDialogIcon.Warning,
                    "question" => PhotinoDialogIcon.Question,
                    _ => PhotinoDialogIcon.Info,
                };
                window.ShowMessage(p.Title, p.Text, PhotinoDialogButtons.Ok, icon);
                return new { ok = true };
            }
            case "fileExists":
            {
                var p = payload.Deserialize<PathPayload>(JsonOptions)!;
                return new { exists = File.Exists(p.Path) };
            }
            case "deleteFile":
            {
                var p = payload.Deserialize<PathPayload>(JsonOptions)!;
                if (File.Exists(p.Path)) File.Delete(p.Path);
                return new { ok = true };
            }
            case "getRecoveryFilePath":
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ParallelizeTexts");
                Directory.CreateDirectory(dir);
                return new { path = Path.Combine(dir, "autosave-recovery.paraproj") };
            }
            case "getFindReplaceHistoryPath":
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ParallelizeTexts");
                Directory.CreateDirectory(dir);
                return new { path = Path.Combine(dir, "find-replace-history.json") };
            }
            case "getRecentProjectsPath":
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ParallelizeTexts");
                Directory.CreateDirectory(dir);
                return new { path = Path.Combine(dir, "recent-projects.json") };
            }
            case "getLastFolderPath":
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ParallelizeTexts");
                Directory.CreateDirectory(dir);
                return new { path = Path.Combine(dir, "last-folder.json") };
            }
            case "getCombineDirectionPath":
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ParallelizeTexts");
                Directory.CreateDirectory(dir);
                return new { path = Path.Combine(dir, "combine-direction.json") };
            }
            case "exit":
            {
                Environment.Exit(0);
                return null;
            }
            default:
                throw new InvalidOperationException($"Unknown RPC action: {action}");
        }
    }
}
