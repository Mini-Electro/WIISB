namespace WIISBROWSING.App.Services;

/// <summary>Where WIISBROWSING keeps its data. Never inside Program Files and never inside the source tree.</summary>
public sealed class AppPaths
{
    public string Root { get; }
    public string Profiles => Path.Combine(Root, "profiles");
    public string Logs => Path.Combine(Root, "logs");
    public string Cache => Path.Combine(Root, "cache");
    public string Favicons => Path.Combine(Cache, "favicons");
    public string PrivateTemp => Path.Combine(Root, "private-temp");
    public string Themes => Path.Combine(Root, "themes");
    public string Backups => Path.Combine(Root, "backups");
    public string AdBlockLists => Path.Combine(Root, "adblock");
    public string AppDb => Path.Combine(Root, "app.db");
    public string Screenshots { get; }

    public AppPaths(string? overrideRoot = null)
    {
        Root = overrideRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WIISBROWSING");
        Screenshots = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "WIISBROWSING");
        foreach (var d in new[] { Root, Profiles, Logs, Cache, Favicons, Themes, Backups, AdBlockLists })
            Directory.CreateDirectory(d);
        CleanPrivateLeftovers();
    }

    /// <summary>Private windows use throw-away folders; remove any a crash left behind.</summary>
    private void CleanPrivateLeftovers()
    {
        try
        {
            if (!Directory.Exists(PrivateTemp)) return;
            foreach (var dir in Directory.GetDirectories(PrivateTemp))
            {
                try { Directory.Delete(dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
        catch (IOException) { }
    }
}
