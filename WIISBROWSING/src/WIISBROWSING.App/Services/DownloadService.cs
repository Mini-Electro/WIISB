using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using Microsoft.Web.WebView2.Core;
using WIISBROWSING.App.Models;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

public sealed class DownloadItem : INotifyPropertyChanged
{
    private long _received, _total;
    private string _state = DownloadStates.InProgress;
    private double _speed;

    public long Id { get; init; }
    public string Url { get; init; } = "";
    public string FileName { get; init; } = "";
    public string Path { get; init; } = "";
    public string Mime { get; init; } = "";
    public bool IsRisky { get; init; }
    public CoreWebView2DownloadOperation? Operation { get; set; }
    public BrowserTab? Tab { get; init; }
    public long Received { get => _received; set { if (Set(ref _received, value)) { Notify(nameof(Fraction)); Notify(nameof(Summary)); } } }
    public long Total { get => _total; set { if (Set(ref _total, value)) { Notify(nameof(Fraction)); Notify(nameof(Summary)); } } }
    public string State { get => _state; set { if (Set(ref _state, value)) { Notify(nameof(IsActive)); Notify(nameof(Summary)); Notify(nameof(CanPause)); Notify(nameof(CanResume)); } } }
    public double Speed { get => _speed; set { if (Set(ref _speed, value)) Notify(nameof(Summary)); } }
    public bool IsActive => State is DownloadStates.InProgress or DownloadStates.Paused;
    public bool CanPause => State == DownloadStates.InProgress && Operation?.CanResume != false;
    public bool CanResume => State == DownloadStates.Paused;
    /// <summary>0..1, or -1 when the server didn't say how large the file is (shown as an indeterminate bar).</summary>
    public double Fraction => Total > 0 ? Math.Clamp((double)Received / Total, 0, 1) : -1;

    public string Summary => State switch
    {
        DownloadStates.Completed => Format(Total > 0 ? Total : Received),
        DownloadStates.Failed => "Download failed",
        DownloadStates.Cancelled => "Cancelled",
        DownloadStates.Paused => $"Paused — {Format(Received)}" + (Total > 0 ? $" of {Format(Total)}" : ""),
        _ => Total > 0
            ? $"{Format(Received)} of {Format(Total)}" + (Speed > 1 ? $" · {Format((long)Speed)}/s" : "") + EtaText()
            : $"{Format(Received)}" + (Speed > 1 ? $" · {Format((long)Speed)}/s" : ""),
    };

    private string EtaText()
    {
        if (Speed < 1 || Total <= Received) return "";
        var secs = (Total - Received) / Speed;
        if (secs > 3600 * 24) return "";
        return secs < 60 ? $" · {Math.Ceiling(secs)}s left" : secs < 3600 ? $" · {Math.Ceiling(secs / 60)} min left" : $" · {secs / 3600:0.#} h left";
    }

    public static string Format(long bytes) => bytes switch
    {
        < 1024 => bytes + " B",
        < 1024 * 1024 => $"{bytes / 1024.0:0.#} KB",
        < 1024L * 1024 * 1024 => $"{bytes / 1048576.0:0.#} MB",
        _ => $"{bytes / 1073741824.0:0.##} GB",
    };

    public event PropertyChangedEventHandler? PropertyChanged;
    private void Notify([CallerMemberName] string? n = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
    private bool Set<T>(ref T f, T v, [CallerMemberName] string? n = null) { if (EqualityComparer<T>.Default.Equals(f, v)) return false; f = v; Notify(n); return true; }
}

/// <summary>Real downloads, driven by the engine's own events — progress, speed and results are never invented.</summary>
public sealed class DownloadService
{
    private static readonly HashSet<string> RiskyExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".hta", ".lnk", ".jar", ".reg", ".msix", ".appx", ".cpl", ".dll",
    };

    private readonly ProfileData _data;
    public ObservableCollection<DownloadItem> Items { get; } = new();
    public event Action? Changed;

    public DownloadService(ProfileData data)
    {
        _data = data;
        if (!data.IsPrivate) data.Downloads.FailInterrupted();
    }

    public int ActiveCount => Items.Count(i => i.IsActive);
    public double? OverallFraction
    {
        get
        {
            var active = Items.Where(i => i.IsActive && i.Total > 0).ToList();
            if (active.Count == 0) return null;
            return (double)active.Sum(i => i.Received) / active.Sum(i => i.Total);
        }
    }

    [System.Runtime.InteropServices.DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPStruct)] Guid rfid, uint flags, IntPtr token, out IntPtr path);

    /// <summary>The user's real Downloads folder (it can be moved or renamed in Windows), falling back to %USERPROFILE%\Downloads.</summary>
    public static string DefaultDownloadFolder()
    {
        try
        {
            if (SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-83DAF8E6F50F"), 0, IntPtr.Zero, out var p) == 0 && p != IntPtr.Zero)
            {
                var s = System.Runtime.InteropServices.Marshal.PtrToStringUni(p);
                System.Runtime.InteropServices.Marshal.FreeCoTaskMem(p);
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or System.Runtime.InteropServices.COMException) { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
    }

    public string Folder
    {
        get
        {
            var chosen = _data.Settings.Get(SettingKeys.DownloadDir);
            return string.IsNullOrWhiteSpace(chosen) ? DefaultDownloadFolder() : Path.GetFullPath(chosen);
        }
    }

    public static string SanitizeFileName(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        name = name.Trim().TrimEnd('.');
        if (name.Length == 0) name = "download";
        return name.Length > 150 ? name[..150] : name;
    }

    /// <summary>"file.zip" → "file (1).zip" when it already exists. Existing files are never overwritten silently.</summary>
    public static string UniquePath(string folder, string fileName)
    {
        var path = Path.Combine(folder, fileName);
        if (!File.Exists(path)) return path;
        var stem = Path.GetFileNameWithoutExtension(fileName);
        var ext = Path.GetExtension(fileName);
        for (int i = 1; i < 10_000; i++)
        {
            path = Path.Combine(folder, $"{stem} ({i}){ext}");
            if (!File.Exists(path)) return path;
        }
        return Path.Combine(folder, $"{stem} ({Guid.NewGuid():N}){ext}");
    }

    /// <param name="askWhere">Shows a save dialog when "ask where to save" is on; returns null if the user cancels.</param>
    public void Start(BrowserTab tab, CoreWebView2DownloadStartingEventArgs e, Func<string, string, string?> askWhere)
    {
        var suggested = SanitizeFileName(Path.GetFileName(e.ResultFilePath));
        string? target;
        try
        {
            if (_data.Settings.GetBool(SettingKeys.DownloadAsk))
            {
                target = askWhere(suggested, Folder);
                if (target is null) { e.Cancel = true; e.Handled = true; return; }
            }
            else
            {
                Directory.CreateDirectory(Folder);
                target = UniquePath(Folder, suggested);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            AppLog.Error("download destination", ex);
            e.Cancel = true;
            e.Handled = true;
            Failed?.Invoke("The download folder isn't available. Choose another folder in Settings → Downloads.");
            return;
        }

        target = Path.GetFullPath(target);   // the engine never starts a download to a path containing ".."
        e.ResultFilePath = target;
        e.Handled = true;           // we show our own download UI
        var op = e.DownloadOperation;
        long total = (long)(op.TotalBytesToReceive ?? 0);
        var fileName = Path.GetFileName(target);
        long id = _data.Downloads.Insert(op.Uri, fileName, target, op.MimeType ?? "", total);
        var item = new DownloadItem
        {
            Id = id, Url = op.Uri, FileName = fileName, Path = target, Mime = op.MimeType ?? "", Total = total, Operation = op, Tab = tab,
            IsRisky = RiskyExtensions.Contains(Path.GetExtension(fileName)),
        };
        tab.ActiveDownloads++;
        Items.Insert(0, item);

        var clock = Stopwatch.StartNew();
        long lastBytes = 0; double lastT = 0; double smooth = 0;
        op.BytesReceivedChanged += (_, _) =>
        {
            item.Received = (long)op.BytesReceived;
            item.Total = (long)(op.TotalBytesToReceive ?? 0);
            double now = clock.Elapsed.TotalSeconds;
            if (now - lastT >= 0.5)
            {
                double inst = ((long)op.BytesReceived - lastBytes) / Math.Max(0.001, now - lastT);
                smooth = smooth == 0 ? inst : smooth * 0.7 + inst * 0.3;
                item.Speed = smooth;
                lastBytes = (long)op.BytesReceived; lastT = now;
                _data.Downloads.UpdateProgress(id, item.Received, item.Total);
                Changed?.Invoke();
            }
        };
        op.StateChanged += (_, _) =>
        {
            switch (op.State)
            {
                case CoreWebView2DownloadState.InProgress:
                    item.State = DownloadStates.InProgress; break;
                case CoreWebView2DownloadState.Interrupted:
                    if (op.CanResume) item.State = DownloadStates.Paused;
                    else { Finish(item, tab, DownloadStates.Failed); }
                    break;
                case CoreWebView2DownloadState.Completed:
                    item.Received = item.Total = Math.Max(item.Total, (long)op.BytesReceived);
                    MarkFromInternet(item);
                    Finish(item, tab, DownloadStates.Completed);
                    Completed?.Invoke(item);
                    break;
            }
            Changed?.Invoke();
        };
        Changed?.Invoke();
        Started?.Invoke(item);
    }

    public event Action<DownloadItem>? Started;
    public event Action<DownloadItem>? Completed;
    public event Action<string>? Failed;

    private void Finish(DownloadItem item, BrowserTab tab, string state)
    {
        item.State = state;
        item.Speed = 0;
        tab.ActiveDownloads = Math.Max(0, tab.ActiveDownloads - 1);
        _data.Downloads.SetState(item.Id, state, item.Received);
        if (state == DownloadStates.Failed) Failed?.Invoke($"The download of {item.FileName} failed.");
    }

    /// <summary>Marks the file as coming from the internet (Mark-of-the-Web) so Windows applies its usual warnings.</summary>
    private static void MarkFromInternet(DownloadItem item)
    {
        try
        {
            File.WriteAllText(item.Path + ":Zone.Identifier", $"[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={item.Url}\r\n");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            AppLog.Warn("could not write Mark-of-the-Web: " + ex.Message);
        }
    }

    public void Pause(DownloadItem i) { try { i.Operation?.Pause(); } catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { } }
    public void Resume(DownloadItem i) { try { i.Operation?.Resume(); } catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { } }

    public void Cancel(DownloadItem i)
    {
        try { i.Operation?.Cancel(); } catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { }
        if (i.IsActive && i.Tab is not null) Finish(i, i.Tab, DownloadStates.Cancelled);
        Changed?.Invoke();
    }

    public void Remove(DownloadItem i) { if (i.IsActive) Cancel(i); Items.Remove(i); _data.Downloads.Remove(i.Id); Changed?.Invoke(); }

    public void ClearFinished()
    {
        foreach (var i in Items.Where(x => !x.IsActive).ToList()) Items.Remove(i);
        _data.Downloads.ClearFinished();
        Changed?.Invoke();
    }

    public void CancelAll() { foreach (var i in Items.Where(x => x.IsActive).ToList()) Cancel(i); }
}
