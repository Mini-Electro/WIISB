using System.Diagnostics;
using System.IO;
using System.Windows;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Services;
using WIISBROWSING.Core.Commands;
using WIISBROWSING.Core.Data;

namespace WIISBROWSING.App.Views;

public partial class MainWindow
{
    public bool StatusPanelVisible => StatusPanel.Visibility == Visibility.Visible;
    public void FlushSession() { _saveTimer.Stop(); SaveSessionNow(); }

    public void OnInternalMessage(BrowserTab tab, string json) => _ = InternalApi.HandleAsync(this, tab, json);

    // ---- opening downloaded files / folders ---------------------------------------------------------------------------------

    private static readonly HashSet<string> RiskyExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".hta", ".lnk", ".jar", ".reg", ".msix", ".appx", ".cpl", ".dll" };

    public void OpenDownloadedFile(string path, string name)
    {
        if (RiskyExtensions.Contains(Path.GetExtension(path)) &&
            !Dialogs.Confirm(this, "Open this file?", $"{name} is a program or script. Only open it if you trust where it came from.\n\nWIISBROWSING never runs downloads on its own.", "Open anyway", "Cancel"))
            return;
        try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { ShowToast("Windows couldn't open that file."); }
    }

    public void ShowInFolder(string? path)
    {
        if (string.IsNullOrEmpty(path)) return;
        try
        {
            if (File.Exists(path)) Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            else if (Directory.Exists(Path.GetDirectoryName(path))) Process.Start(new ProcessStartInfo("explorer.exe", $"\"{Path.GetDirectoryName(path)}\"") { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { }
    }

    // ---- editing keyboard shortcuts -------------------------------------------------------------------------------------------

    public object SetShortcut(string commandId, string chordText)
    {
        var cmd = Commands.Get(commandId);
        if (cmd is null) return new { ok = false, error = "Unknown command." };
        var overrides = Data.Settings.GetJson<Dictionary<string, string>>(SettingKeys.Shortcuts) ?? new();
        if (string.IsNullOrWhiteSpace(chordText))
        {
            overrides[commandId] = "";
        }
        else
        {
            if (!KeyChord.TryParse(chordText, out var chord)) return new { ok = false, error = "That isn't a valid shortcut." };
            if (ShortcutMap.IsReserved(chord)) return new { ok = false, error = "That shortcut is used by Windows or by text editing, so it can't be reassigned." };
            var conflict = Shortcuts.FindConflict(chord, commandId);
            if (conflict is not null) return new { ok = false, error = $"“{Commands.Get(conflict)?.Name}” already uses {chord}. Remove that one first." };
            overrides[commandId] = chord.ToString();
        }
        Data.Settings.SetJson(SettingKeys.Shortcuts, overrides);
        Shortcuts = ShortcutMap.WithDefaults(Commands.All, overrides);
        return new { ok = true };
    }

    public void ResetShortcuts()
    {
        Data.Settings.Remove(SettingKeys.Shortcuts);
        Shortcuts = ShortcutMap.WithDefaults(Commands.All);
    }
}
