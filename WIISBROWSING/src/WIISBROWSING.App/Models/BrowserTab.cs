using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Media;
using WIISBROWSING.App.Browser;
using WIISBROWSING.Core.Urls;

namespace WIISBROWSING.App.Models;

public enum SecurityState { Internal, Secure, Insecure, Local, Error }

public enum TabLifecycle { Active, Background, Sleeping, Crashed, Restoring }

public sealed record TabError(string Title, string Message, string Details, bool Retryable = true);

public sealed class PendingPrompt
{
    public required string Origin { get; init; }
    public required string Description { get; init; }
    public required string Kind { get; init; }
    public Action<string>? Decide { get; set; } // "allow-always" | "allow-once" | "block"
}

/// <summary>One browser tab. Identified by a stable id — never by its position in a list.</summary>
public sealed class BrowserTab : INotifyPropertyChanged
{
    private string _title = "";
    private string _url = "";
    private ImageSource? _favicon;
    private bool _isLoading, _isSelected, _isPinned, _isMuted, _isAudible, _canBack, _canForward, _sleepExempt;
    private string _marker = "";
    private string? _clusterId;
    private string _workspaceId = "general";
    private SecurityState _security = SecurityState.Internal;
    private TabLifecycle _lifecycle = TabLifecycle.Background;
    private TabError? _error;
    private PendingPrompt? _prompt;
    private int _blockedCount;
    private double _zoom = 1.0;
    private int _recentRank;
    private ImageSource? _preview;
    private Brush? _clusterBrush;

    public string Id { get; }
    public BrowserTab(string? id = null) { Id = string.IsNullOrEmpty(id) ? Guid.NewGuid().ToString("N") : id; }
    public string? OpenerId { get; set; }
    public DateTime LastActive { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAt { get; } = DateTime.UtcNow;
    /// <summary>The live web view, or null while the tab is asleep / not yet created.</summary>
    public TabWebView? View { get; set; }
    public double SavedScrollY { get; set; }
    public int ActiveDownloads { get; set; }
    public bool IsPrivate { get; init; }
    /// <summary>True while the page may be using the camera, microphone or screen; such tabs never go to sleep.</summary>
    public bool HasMediaCapture { get; set; }
    public bool IsInternal => UrlClassifier.IsInternal(Url);

    public string Title { get => _title; set { if (Set(ref _title, value ?? "")) Notify(nameof(DisplayTitle)); } }
    public string Url
    {
        get => _url;
        set
        {
            if (!Set(ref _url, value ?? "")) return;
            Notify(nameof(DisplayTitle)); Notify(nameof(Host)); Notify(nameof(DisplayUrl)); Notify(nameof(IsInternal));
        }
    }

    public ImageSource? Favicon { get => _favicon; set => Set(ref _favicon, value); }
    public Brush? ClusterBrush { get => _clusterBrush; set => Set(ref _clusterBrush, value); }
    public ImageSource? Preview { get => _preview; set => Set(ref _preview, value); }
    public bool IsLoading { get => _isLoading; set => Set(ref _isLoading, value); }
    public bool IsSelected { get => _isSelected; set => Set(ref _isSelected, value); }
    public bool IsPinned { get => _isPinned; set => Set(ref _isPinned, value); }
    public bool IsMuted { get => _isMuted; set { if (Set(ref _isMuted, value)) Notify(nameof(ShowAudioIcon)); } }
    public bool IsAudible { get => _isAudible; set { if (Set(ref _isAudible, value)) Notify(nameof(ShowAudioIcon)); } }
    public bool ShowAudioIcon => IsAudible || IsMuted;
    public bool CanGoBack { get => _canBack; set => Set(ref _canBack, value); }
    public bool CanGoForward { get => _canForward; set => Set(ref _canForward, value); }
    public bool SleepExempt { get => _sleepExempt; set => Set(ref _sleepExempt, value); }
    public string Marker { get => _marker; set { if (Set(ref _marker, value ?? "")) Notify(nameof(HasMarker)); } }
    public bool HasMarker => Marker.Length > 0;
    public string? ClusterId { get => _clusterId; set { if (Set(ref _clusterId, value)) Notify(nameof(IsClustered)); } }
    public bool IsClustered => ClusterId is not null;
    public string WorkspaceId { get => _workspaceId; set => Set(ref _workspaceId, value); }
    public SecurityState Security { get => _security; set => Set(ref _security, value); }
    public TabLifecycle Lifecycle { get => _lifecycle; set { if (Set(ref _lifecycle, value)) { Notify(nameof(IsSleeping)); Notify(nameof(IsCrashed)); } } }
    public bool IsSleeping => Lifecycle == TabLifecycle.Sleeping;
    public bool IsCrashed => Lifecycle == TabLifecycle.Crashed;
    public TabError? Error { get => _error; set { if (Set(ref _error, value)) Notify(nameof(HasError)); } }
    public bool HasError => Error is not null;
    public PendingPrompt? Prompt { get => _prompt; set { if (Set(ref _prompt, value)) Notify(nameof(HasPrompt)); } }
    public bool HasPrompt => Prompt is not null;
    public int BlockedCount { get => _blockedCount; set => Set(ref _blockedCount, value); }
    public double Zoom { get => _zoom; set { if (Set(ref _zoom, value)) Notify(nameof(ZoomText)); } }
    public string ZoomText => $"{Math.Round(Zoom * 100)}%";
    /// <summary>1 = the tab you were just in, 2 = the one before; 0 otherwise. Drives the subtle "recent" highlight.</summary>
    public int RecentRank { get => _recentRank; set => Set(ref _recentRank, value); }

    public string Host => UrlClassifier.HostOf(Url);
    public string DisplayUrl => IsInternal ? Url : (Url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? Url[8..] : Url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ? Url[7..] : Url).TrimEnd('/');
    public string DisplayTitle => !string.IsNullOrWhiteSpace(Title) ? Title : (string.IsNullOrEmpty(Url) || Url == "wiisb://newtab" ? "New tab" : DisplayUrl);

    public event PropertyChangedEventHandler? PropertyChanged;
    private void Notify([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    private bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Notify(name);
        return true;
    }
}

public sealed class Workspace : INotifyPropertyChanged
{
    private string _name = "", _icon = "●", _color = "#8B5CF6";
    private bool _isActive, _hidden;
    public string Id { get; init; } = Guid.NewGuid().ToString("N")[..10];
    public string Name { get => _name; set => Set(ref _name, value); }
    public string Icon { get => _icon; set => Set(ref _icon, value); }
    public string Color { get => _color; set => Set(ref _color, value); }
    public bool IsActive { get => _isActive; set => Set(ref _isActive, value); }
    public bool Hidden { get => _hidden; set => Set(ref _hidden, value); }
    public string? ActiveTabId { get; set; }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }
}

public sealed class TabCluster : INotifyPropertyChanged
{
    private string _name = "", _color = "#8B5CF6", _emoji = "";
    private bool _collapsed;
    private int _count;
    public string Id { get; init; } = Guid.NewGuid().ToString("N")[..10];
    public string WorkspaceId { get; set; } = "general";
    public string Name { get => _name; set => Set(ref _name, value); }
    public string Color { get => _color; set { if (Set(ref _color, value)) Notify(nameof(Brush)); } }
    public string Emoji { get => _emoji; set { if (Set(ref _emoji, value)) Notify(nameof(HasEmoji)); } }
    public bool HasEmoji => Emoji.Length > 0;
    public bool Collapsed { get => _collapsed; set { if (Set(ref _collapsed, value)) Notify(nameof(Chevron)); } }
    public int Count { get => _count; set => Set(ref _count, value); }
    public string Chevron => Collapsed ? "" : "";
    public Brush Brush => new SolidColorBrush(Helpers.ColorOf(Color));

    public event PropertyChangedEventHandler? PropertyChanged;
    private void Notify([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    private bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        Notify(name);
        return true;
    }
}

/// <summary>A row in the vertical tab list: a cluster header or a tab.</summary>
public static class Helpers
{
    public static System.Windows.Media.Color ColorOf(string hex)
    {
        try { var (a, r, g, b) = Core.Themes.ThemeCatalog.ParseColor(hex); return System.Windows.Media.Color.FromArgb(a, r, g, b); }
        catch (Exception) { return System.Windows.Media.Colors.MediumPurple; }
    }
}
