using System.Text.Json;
using Photino.NET;
using ParallelizeTexts.Rpc;

namespace ParallelizeTexts;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var window = new PhotinoWindow()
            .SetTitle("ParallelizeTexts")
            .SetUseOsDefaultSize(false)
            .SetSize(1500, 950)
            .SetResizable(true)
            .SetContextMenuEnabled(false)
            .RegisterWebMessageReceivedHandler(OnWebMessageReceived)
            .Load("wwwroot/index.html");

        window.WaitForClose();
    }

    private static void OnWebMessageReceived(object? sender, string message)
    {
        var window = (PhotinoWindow)sender!;
        string id = "";
        try
        {
            var request = JsonSerializer.Deserialize<RpcRequest>(message, RpcRouter.JsonOptions);
            if (request is null) return;
            id = request.Id;
            object? result = RpcRouter.Dispatch(window, request.Action, request.Payload);
            SendResponse(window, id, ok: true, result, error: null);
        }
        catch (Exception ex)
        {
            SendResponse(window, id, ok: false, result: null, error: ex.Message);
        }
    }

    private static void SendResponse(PhotinoWindow window, string id, bool ok, object? result, string? error)
    {
        var response = new RpcResponse { Id = id, Ok = ok, Result = result, Error = error };
        window.SendWebMessage(JsonSerializer.Serialize(response, RpcRouter.JsonOptions));
    }
}
