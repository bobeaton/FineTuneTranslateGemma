using System.Text.Json;

namespace ParallelizeTexts.Rpc;

/// <summary>One call from the JS side of the webview: {id, action, payload}.</summary>
public sealed class RpcRequest
{
    public string Id { get; set; } = "";
    public string Action { get; set; } = "";
    public JsonElement Payload { get; set; }
}

/// <summary>The matching reply sent back over the same WebMessage channel.</summary>
public sealed class RpcResponse
{
    public string Id { get; set; } = "";
    public bool Ok { get; set; }
    public object? Result { get; set; }
    public string? Error { get; set; }
}
