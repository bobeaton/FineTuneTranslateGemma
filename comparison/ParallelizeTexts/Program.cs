using System.Text.Json;
using Photino.NET;
using ParallelizeTexts.Rpc;

namespace ParallelizeTexts;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Without an explicit path, Photino points WebView2 at a profile
        // shared by EVERY Photino app on the machine (%LocalAppData%\Photino
        // \EBWebView), which caches wwwroot's HTML/CSS/JS by their file://
        // URL across launches -- so a `dotnet build` + `dotnet run` during
        // development can silently keep showing a stale cached copy of an
        // edited file instead of what's actually on disk. Giving this app
        // its own profile folder at least stops it sharing cache/state with
        // unrelated Photino apps; wiping that folder before every Debug
        // launch additionally guarantees each dev run picks up whatever's
        // actually on disk. Release builds keep the profile persistent
        // (faster subsequent launches -- end users aren't editing wwwroot
        // between runs, so there's nothing to go stale on them).
        string webViewDataPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ParallelizeTexts", "WebView2");
#if DEBUG
        try { if (Directory.Exists(webViewDataPath)) Directory.Delete(webViewDataPath, recursive: true); }
        catch { /* best-effort -- a locked file here isn't worth failing startup over */ }
#endif

        var window = new PhotinoWindow()
            .SetTitle("ParallelizeTexts")
            .SetUseOsDefaultSize(false)
            .SetSize(1500, 950)
            .SetResizable(true)
            .SetContextMenuEnabled(false)
            .SetTemporaryFilesPath(webViewDataPath)
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
