namespace ParallelizeTexts.Services;

/// <summary>The subset of the project JSON (as held by the JS grid) that the
/// exporters need. System.Text.Json ignores the extra fields (fonts, file
/// paths, active-target index, etc.) that don't map onto these properties.</summary>
public sealed class ExportProjectDto
{
    public List<string> SourceLines { get; set; } = new();
    public List<ExportTargetDto> Targets { get; set; } = new();
}

public sealed class ExportTargetDto
{
    public string Name { get; set; } = "";
    public List<string> Lines { get; set; } = new();
}
