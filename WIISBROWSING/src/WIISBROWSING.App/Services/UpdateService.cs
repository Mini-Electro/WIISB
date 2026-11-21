using System.Diagnostics;
using System.Reflection;
using System.Windows;
using Microsoft.Win32;
using WIISBROWSING.App.Views;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Updates;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

/// <summary>Where updates come from and which key their installers must be signed with.</summary>
public sealed record UpdateSource(string ManifestUrl, string DownloadPrefix, byte[] PublicKey);

public sealed record StagedUpdate(UpdateOffer Offer, string File);

/// <summary>What "Check for updates" tells the settings page. <c>Status</c> is upToDate, ready, unavailable or error.</summary>
public sealed record UpdateCheckResult(string Status, string? Version, string Message);

/// <summary>
/// Keeps an installed WIISBROWSING up to date from its GitHub releases.
///
/// A new version is looked for shortly after start and then every few hours (unless the person turned "Update
/// automatically" off in Settings; "Check for updates" looks on demand either way). It is downloaded in the background and its
/// signature is checked against the key built into this program — an installer that isn't signed by WIISB is deleted
/// and never offered. The person is asked once ("Restart now" / "Later"); if they say Later, it installs when they next
/// close the browser. A copy that isn't installed (a portable folder, a development build) never updates itself.
/// </summary>
public static class UpdateService
{
    /// <summary>The public half of the release signing key (the private half never leaves the developer's PC).</summary>
    private const string PublicKeyBase64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEE6wPiFSBCawWAfh6Wimg2oMgVDRzGAInrwXWwBkc0OVvI2zlFGCnlb/a5Q25L4tl0PQKektVaUAOhVa4/aaP3g==";
    private const long MaxInstallerBytes = 400L * 1024 * 1024;
    private static readonly HttpClient Http = CreateClient();
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static CancellationTokenSource? _cts;
    private static bool _installing;

    public static StagedUpdate? Staged { get; private set; }

    private static HttpClient CreateClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("WIISBROWSING-updater");
        return c;
    }

    /// <summary>"owner/repo", compiled in by the release script (<c>-p:UpdateRepo=owner/repo</c>); empty in development builds.</summary>
    private static string Repo =>
        Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "UpdateRepo")?.Value?.Trim() ?? "";

    public static Version CurrentVersion => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0);

    public static UpdateSource? ProductionSource()
    {
        // "owner/repo@tag": the release called `tag` always holds the newest installer and latest.json.
        var spec = Repo;
        var at = spec.IndexOf('@');
        var repo = at < 0 ? spec : spec[..at];
        var tag = at < 0 ? "" : spec[(at + 1)..];
        static bool Plain(string part) => part.Length > 0 && part is not ("." or "..") && part.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');
        var parts = repo.Split('/');
        if (parts.Length != 2 || !parts.All(Plain) || (tag.Length > 0 && !Plain(tag))) return null;
        var manifest = tag.Length == 0 ? $"https://github.com/{repo}/releases/latest/download/latest.json" : $"https://github.com/{repo}/releases/download/{tag}/latest.json";
        return new UpdateSource(manifest, $"https://github.com/{repo}/releases/download/", Convert.FromBase64String(PublicKeyBase64));
    }

    private static string? ExePath => Environment.ProcessPath;

    /// <summary>True when this program is the installed copy (the one the installer would replace).</summary>
    private static bool IsInstalledCopy()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\WIISBROWSING");
            var location = (key?.GetValue("InstallLocation") as string)?.Trim().Trim('"');
            var exeDir = Path.GetDirectoryName(ExePath);
            return !string.IsNullOrEmpty(location) && !string.IsNullOrEmpty(exeDir) &&
                   string.Equals(Path.GetFullPath(location).TrimEnd('\\'), Path.GetFullPath(exeDir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return false; }
    }

    // ---- background checking ---------------------------------------------------------------------------------------------

    /// <summary>The "Update automatically" preference (on unless the person turned it off).</summary>
    public static bool AutoEnabled => AppHost.AppSettings.GetBool(SettingKeys.AutoUpdate, true);

    public static void SetAuto(bool on) => AppHost.AppSettings.SetBool(SettingKeys.AutoUpdate, on);

    public static void Start()
    {
        if (AppHost.SelfTestDir is not null) return;
        var source = ProductionSource();
        if (source is null) { AppLog.Info("updates: off (no update source in this build)"); return; }
        if (!IsInstalledCopy()) { AppLog.Info("updates: off (this is not the installed copy)"); return; }
        _cts = new CancellationTokenSource();
        var token = _cts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(45), token);
                var next = DateTime.UtcNow;
                while (!token.IsCancellationRequested)
                {
                    // The preference is asked again every half minute, so turning it on or off needs no restart.
                    if (DateTime.UtcNow >= next && AutoEnabled)
                    {
                        try { await CheckAsync(source, CurrentVersion, token); next = DateTime.UtcNow.AddHours(6); }
                        catch (Exception ex) when (ex is not OperationCanceledException) { AppLog.Warn("updates: check failed: " + ex.Message); next = DateTime.UtcNow.AddMinutes(30); }
                    }
                    await Task.Delay(TimeSpan.FromSeconds(30), token);
                }
            }
            catch (OperationCanceledException) { }
        });
    }

    /// <summary>"Check for updates": looks right now, whatever the automatic preference says, and says what it found.</summary>
    public static async Task<UpdateCheckResult> CheckNowAsync()
    {
        var source = ProductionSource();
        if (source is null) return new("unavailable", null, "This copy of WIISBROWSING has no update source built in, so it can't look for updates.");
        if (!IsInstalledCopy()) return new("unavailable", null, "Only the installed copy of WIISBROWSING updates itself. This is a portable or development copy.");
        try
        {
            var before = Staged;
            var staged = await CheckAsync(source, CurrentVersion, CancellationToken.None, wait: true);
            if (staged is null)
                return _rejected ? new("error", null, "A newer version was found, but it isn't signed by WIISB, so it was discarded.") : new("upToDate", null, "You're on the latest version.");
            // A freshly downloaded one is offered by CheckAsync itself; one found earlier is offered again because the person asked.
            if (before is not null) _ = Application.Current?.Dispatcher.BeginInvoke(() => Offer(staged));
            return new("ready", staged.Offer.Version.ToString(), $"Version {staged.Offer.Version} is downloaded. Restart to update.");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or InvalidDataException or System.Text.Json.JsonException)
        {
            AppLog.Warn("updates: manual check failed: " + ex.Message);
            return new("error", null, "Couldn't check for updates. Check your internet connection and try again.");
        }
    }

    /// <summary>Set when the last check found a release whose signature was wrong.</summary>
    private static bool _rejected;

    /// <summary>Looks for a newer release and, if there is one, downloads and verifies it. Returns what is staged (or null).</summary>
    public static async Task<StagedUpdate?> CheckAsync(UpdateSource source, Version current, CancellationToken ct, bool wait = false)
    {
        if (!await Gate.WaitAsync(wait ? Timeout.Infinite : 0, ct)) return Staged;
        try
        {
            _rejected = false;
            if (Staged is not null) return Staged;
            var json = await Http.GetStringAsync(source.ManifestUrl, ct);
            if (json.Length > 64 * 1024) return null;
            var offer = UpdateManifest.EvaluateWithPrefix(json, current, source.DownloadPrefix);
            if (offer is null) { AppLog.Info("updates: up to date"); return null; }
            AppLog.Info($"updates: {offer.Version} is available; downloading");

            var dir = Path.Combine(Path.GetTempPath(), "WIISBROWSING-update");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, Path.GetFileName(new Uri(offer.Url).LocalPath));
            using (var response = await Http.GetAsync(offer.Url, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > MaxInstallerBytes) throw new InvalidDataException("The installer is larger than expected.");
                await using var net = await response.Content.ReadAsStreamAsync(ct);
                await using var fs = File.Create(file);
                var buffer = new byte[81920]; long total = 0; int n;
                while ((n = await net.ReadAsync(buffer, ct)) > 0)
                {
                    total += n;
                    if (total > MaxInstallerBytes) throw new InvalidDataException("The installer is larger than expected.");
                    await fs.WriteAsync(buffer.AsMemory(0, n), ct);
                }
            }
            bool genuine;
            await using (var check = File.OpenRead(file)) genuine = UpdateSigning.Verify(check, offer.Signature, source.PublicKey);
            if (!genuine)
            {
                try { File.Delete(file); } catch (IOException) { }
                AppLog.Warn($"updates: {offer.Version} was NOT signed with the WIISB key; discarded");
                _rejected = true;
                return null;
            }
            Staged = new StagedUpdate(offer, file);
            AppLog.Info($"updates: {offer.Version} downloaded and verified");
            var staged = Staged;
            if (AppHost.SelfTestDir is null) Application.Current?.Dispatcher.BeginInvoke(() => Offer(staged));
            return staged;
        }
        finally { Gate.Release(); }
    }

    // ---- telling the person, installing --------------------------------------------------------------------------------------

    private static void Offer(StagedUpdate update)
    {
        var window = AppHost.Windows.FirstOrDefault(w => !w.IsPrivate && w.IsActive) ?? AppHost.Windows.FirstOrDefault(w => !w.IsPrivate);
        if (window is null) return;
        var notes = string.IsNullOrWhiteSpace(update.Offer.Notes) ? "" : "\n\n" + update.Offer.Notes;
        if (Dialogs.Confirm(window, $"WIISBROWSING {update.Offer.Version} is ready", "Restart now to get the latest version. Your tabs come back exactly as they were." + notes + "\n\nChoose Later and it installs when you next close the browser.", "Restart now", "Later"))
            InstallAndRestart();
    }

    /// <summary>Closes the browser, installs the staged update, and opens the browser again.</summary>
    public static void InstallAndRestart()
    {
        if (!StartInstaller(relaunch: true)) return;
        Application.Current.Shutdown();
    }

    /// <summary>If an update was downloaded and the person said "Later", install it now that they are closing the browser.</summary>
    public static void InstallOnExitIfStaged() => StartInstaller(relaunch: false);

    private static bool StartInstaller(bool relaunch)
    {
        var staged = Staged;
        var exe = ExePath;
        if (staged is null || exe is null || _installing || !File.Exists(staged.File)) return false;
        _installing = true;
        try
        {
            // The installer refuses to run while the browser is open, so a small script waits for it to close first.
            var script = Path.Combine(Path.GetTempPath(), "WIISBROWSING-update", "apply-update.cmd");
            File.WriteAllText(script, string.Join("\r\n",
                "@echo off",
                "set /a tries=0",
                ":wait",
                "tasklist /FI \"IMAGENAME eq WIISBROWSING.exe\" 2>nul | find /I \"WIISBROWSING.exe\" >nul",
                "if errorlevel 1 goto install",
                "set /a tries+=1",
                "if %tries% GEQ 90 exit /b 1",
                "ping -n 2 127.0.0.1 >nul",
                "goto wait",
                ":install",
                $"\"{staged.File}\" /S",
                relaunch ? $"start \"\" \"{exe}\"" : "rem not restarting: the browser was being closed",
                $"del \"{staged.File}\" >nul 2>&1",
                ""));
            Process.Start(new ProcessStartInfo("cmd.exe", $"/c \"\"{script}\"\"") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
            AppLog.Info($"updates: installing {staged.Offer.Version} (relaunch={relaunch})");
            return true;
        }
        catch (Exception ex) when (ex is IOException or System.ComponentModel.Win32Exception or UnauthorizedAccessException)
        {
            _installing = false;
            AppLog.Warn("updates: couldn't start the installer: " + ex.Message);
            return false;
        }
    }

    public static void Stop() => _cts?.Cancel();

    /// <summary>Forgets the staged update and deletes its installer (used by the self-test).</summary>
    public static void Discard()
    {
        var staged = Staged;
        Staged = null;
        if (staged is not null) { try { File.Delete(staged.File); } catch (IOException) { } }
    }
}
