using Microsoft.Web.WebView2.Core;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

/// <summary>
/// One WebView2 environment per profile (and one throw-away environment per private window). Tabs of the same
/// profile share an environment, so they share one browser process group and one cookie jar — and tabs of
/// different profiles can never see each other's data.
/// </summary>
public sealed class WebEnvironments
{
    private readonly Dictionary<string, Task<CoreWebView2Environment>> _envs = new();
    private readonly SettingsStore _appSettings;

    public WebEnvironments(SettingsStore appSettings) => _appSettings = appSettings;

    public static bool IsRuntimeInstalled(out string version)
    {
        try { version = CoreWebView2Environment.GetAvailableBrowserVersionString(); return !string.IsNullOrEmpty(version); }
        catch (Exception) { version = ""; return false; }
    }

    public Task<CoreWebView2Environment> GetAsync(string key, string userDataFolder, ProfileData data)
    {
        lock (_envs)
        {
            if (!_envs.TryGetValue(key, out var task))
            {
                Directory.CreateDirectory(userDataFolder);
                task = Create(userDataFolder, data);
                _envs[key] = task;
            }
            return task;
        }
    }

    public void Forget(string key) { lock (_envs) _envs.Remove(key); }

    private static Task<CoreWebView2Environment> Create(string folder, ProfileData data)
    {
        // wiisb:// pages are our own internal pages (new tab, settings…); the scheme must be registered when the environment is created.
        var schemes = new List<CoreWebView2CustomSchemeRegistration>
        {
            new("wiisb") { TreatAsSecure = true, HasAuthorityComponent = true },
        };
        var options = new CoreWebView2EnvironmentOptions(null, null, null, false, schemes)
        {
            // Native tracking prevention; the level is applied per profile below.
            EnableTrackingPrevention = data.Settings.Get(SettingKeys.TrackingMode) != "off",
            ScrollBarStyle = CoreWebView2ScrollbarStyle.FluentOverlay,
            AreBrowserExtensionsEnabled = true,
        };

        // Proxy: only what the user configured; nothing is changed without being asked.
        var proxyMode = data.Settings.Get(SettingKeys.ProxyMode);
        var proxyServer = data.Settings.Get(SettingKeys.ProxyServer);
        if (proxyMode == "none") options.AdditionalBrowserArguments = "--no-proxy-server";
        else if (proxyMode == "custom" && ProxyServerIsValid(proxyServer)) options.AdditionalBrowserArguments = $"--proxy-server=\"{proxyServer}\"";

        return CoreWebView2Environment.CreateAsync(null, folder, options);
    }

    public static bool ProxyServerIsValid(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 255 || value.Any(c => char.IsWhiteSpace(c) || c == '"' || c == '\'' || c == ';' || c == ',')) return false;
        var text = value.Contains("://") ? value : "http://" + value;
        return Uri.TryCreate(text, UriKind.Absolute, out var u) && u.Scheme is "http" or "https" or "socks4" or "socks5" && !string.IsNullOrEmpty(u.Host) && u.Port > 0;
    }

    public static CoreWebView2TrackingPreventionLevel TrackingLevel(string mode) => mode switch
    {
        "off" => CoreWebView2TrackingPreventionLevel.None,
        "strict" => CoreWebView2TrackingPreventionLevel.Strict,
        _ => CoreWebView2TrackingPreventionLevel.Balanced,
    };
}
