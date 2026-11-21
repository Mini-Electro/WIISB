using System.Text;

namespace WIISBROWSING.Core.Util;

/// <summary>Small local log. Nothing is ever sent anywhere; URLs and page content are not logged.</summary>
public static class AppLog
{
    private static readonly object Gate = new();
    private static string? _path;

    public static void Init(string logsFolder)
    {
        Directory.CreateDirectory(logsFolder);
        _path = Path.Combine(logsFolder, "wiisbrowsing.log");
        try
        {
            if (File.Exists(_path) && new FileInfo(_path).Length > 1_000_000)
                File.Move(_path, Path.Combine(logsFolder, "wiisbrowsing.old.log"), overwrite: true);
        }
        catch (IOException) { }
    }

    public static void Info(string message) => Write("INFO", message);
    public static void Warn(string message) => Write("WARN", message);
    public static void Error(string message, Exception? ex = null) =>
        Write("ERROR", ex is null ? message : $"{message}: {ex.GetType().Name}: {ex.Message}" + Environment.NewLine + string.Join(Environment.NewLine, (ex.StackTrace ?? "").Split('\n').Take(6)));

    private static void Write(string level, string message)
    {
        var line = $"{DateTime.UtcNow:O} {level} {message}{Environment.NewLine}";
        System.Diagnostics.Debug.Write(line);
        if (_path is null) return;
        try { lock (Gate) File.AppendAllText(_path, line, Encoding.UTF8); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
