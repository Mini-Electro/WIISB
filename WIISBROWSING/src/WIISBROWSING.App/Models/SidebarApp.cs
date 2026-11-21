using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Media;

namespace WIISBROWSING.App.Models;

/// <summary>Stored in settings (JSON). Only a name and an https address — never credentials.</summary>
public sealed class SidebarAppRecord
{
    public string Name { get; set; } = "";
    public string Url { get; set; } = "";
    public string Color { get; set; } = "#6366F1";
}

/// <summary>A web app shortcut in the sidebar. Its icon is the site's own favicon, cached after the first visit.</summary>
public sealed class SidebarApp : INotifyPropertyChanged
{
    private ImageSource? _icon;
    public string Name { get; set; } = "";
    public string Url { get; set; } = "";
    public string ColorHex { get; set; } = "#6366F1";
    public string Letter => Name.Length == 0 ? "?" : Name[..1].ToUpperInvariant();
    public Brush Brush => new SolidColorBrush(Helpers.ColorOf(ColorHex));
    public ImageSource? Icon { get => _icon; set { _icon = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Icon))); PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(HasIcon))); } }
    public bool HasIcon => _icon is not null;
    public string Host => Core.Urls.UrlClassifier.HostOf(Url);

    public event PropertyChangedEventHandler? PropertyChanged;

    public static List<SidebarAppRecord> Defaults() => new()
    {
        new() { Name = "WhatsApp", Url = "https://web.whatsapp.com/", Color = "#16A34A" },
        new() { Name = "Discord", Url = "https://discord.com/app", Color = "#5865F2" },
        new() { Name = "YouTube", Url = "https://www.youtube.com/", Color = "#DC2626" },
        new() { Name = "Spotify", Url = "https://open.spotify.com/", Color = "#16A34A" },
        new() { Name = "Gmail", Url = "https://mail.google.com/", Color = "#EA4335" },
        new() { Name = "GitHub", Url = "https://github.com/", Color = "#475569" },
        new() { Name = "Reddit", Url = "https://www.reddit.com/", Color = "#EA580C" },
        new() { Name = "Twitch", Url = "https://www.twitch.tv/", Color = "#9146FF" },
    };
}
