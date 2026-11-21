using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace WIISBROWSING.Core.Themes;

/// <summary>Design tokens. Every colour in the browser UI comes from here, so a theme change reaches everything.</summary>
public static class Tokens
{
    public const string BackgroundPrimary = "BackgroundPrimary";
    public const string BackgroundSecondary = "BackgroundSecondary";
    public const string Sidebar = "Sidebar";
    public const string Tab = "Tab";
    public const string TabActive = "TabActive";
    public const string SurfaceElevated = "SurfaceElevated";
    public const string AccentPrimary = "AccentPrimary";
    public const string AccentSecondary = "AccentSecondary";
    public const string Hover = "Hover";
    public const string TextPrimary = "TextPrimary";
    public const string TextMuted = "TextMuted";
    public const string BorderSubtle = "BorderSubtle";
    public const string AddressBar = "AddressBar";
    public const string Toolbar = "Toolbar";
    public const string NewTabBackground = "NewTabBackground";

    public static readonly IReadOnlyList<string> All = new[]
    {
        BackgroundPrimary, BackgroundSecondary, Sidebar, Tab, TabActive, SurfaceElevated, AccentPrimary, AccentSecondary,
        Hover, TextPrimary, TextMuted, BorderSubtle, AddressBar, Toolbar, NewTabBackground,
    };
}

public sealed class ThemeDef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool IsDark { get; set; } = true;
    public Dictionary<string, string> Colors { get; set; } = new();
    public double CornerRadius { get; set; } = 12;
    /// <summary>0.8 compact … 1.3 roomy.</summary>
    public double Density { get; set; } = 1.0;
    public double ShadowStrength { get; set; } = 0.5;
    public double AnimationScale { get; set; } = 1.0;
    public string FontFamily { get; set; } = "Segoe UI Variable Text";
    /// <summary>none | gradient | stars | particles — decorative background on the new-tab page.</summary>
    public string Animated { get; set; } = "none";
    [JsonIgnore] public bool BuiltIn { get; set; }

    public string Color(string token) => Colors.TryGetValue(token, out var c) ? c : "#FF00FF";

    public ThemeDef Clone() => new()
    {
        Id = Id, Name = Name, IsDark = IsDark, Colors = new(Colors), CornerRadius = CornerRadius, Density = Density,
        ShadowStrength = ShadowStrength, AnimationScale = AnimationScale, FontFamily = FontFamily, Animated = Animated,
    };
}

public static partial class ThemeCatalog
{
    private static ThemeDef T(string id, string name, bool dark, string bg, string bg2, string side, string tab, string tabActive, string elev,
        string accent, string accent2, string text, string muted, string border, string address, string toolbar, string newTab,
        double radius = 12, string animated = "none", string? font = null)
    {
        var d = new ThemeDef
        {
            Id = id, Name = name, IsDark = dark, CornerRadius = radius, Animated = animated, BuiltIn = true,
            Colors = new()
            {
                [Tokens.BackgroundPrimary] = bg, [Tokens.BackgroundSecondary] = bg2, [Tokens.Sidebar] = side, [Tokens.Tab] = tab,
                [Tokens.TabActive] = tabActive, [Tokens.SurfaceElevated] = elev, [Tokens.AccentPrimary] = accent, [Tokens.AccentSecondary] = accent2,
                [Tokens.Hover] = dark ? "#FFFFFF14" : "#00000010", [Tokens.TextPrimary] = text, [Tokens.TextMuted] = muted, [Tokens.BorderSubtle] = border,
                [Tokens.AddressBar] = address, [Tokens.Toolbar] = toolbar, [Tokens.NewTabBackground] = newTab,
            },
        };
        if (font is not null) d.FontFamily = font;
        return d;
    }

    public static readonly IReadOnlyList<ThemeDef> BuiltIn = new[]
    {
        T("midnight", "WIISB Midnight", true, "#090A0F", "#11131B", "#0E1018", "#191C27", "#252A3D", "#202433", "#8B5CF6", "#A78BFA", "#F8FAFC", "#94A3B8", "#FFFFFF1F", "#161926", "#0E1018", "#0B0C14", 14, "gradient"),
        T("opera-purple", "Opera-Inspired Purple", true, "#0C0A14", "#15121F", "#100D1A", "#1D1830", "#2B2347", "#241E3A", "#A855F7", "#C084FC", "#FAF5FF", "#A599C4", "#FFFFFF1F", "#1A1528", "#100D1A", "#0E0B18", 14),
        T("oled", "OLED Black", true, "#000000", "#080808", "#000000", "#101010", "#1C1C1C", "#141414", "#8B5CF6", "#6366F1", "#FFFFFF", "#8A8A8A", "#FFFFFF1A", "#0C0C0C", "#000000", "#000000", 12),
        T("arctic", "Arctic White", false, "#EEF2F7", "#F7F9FC", "#E3E9F1", "#EAEFF6", "#FFFFFF", "#FFFFFF", "#4F6BED", "#7C93F5", "#0F172A", "#5B6779", "#0F172A1F", "#FFFFFF", "#F2F5FA", "#F4F7FB", 12),
        T("cyber-blue", "Cyber Blue", true, "#050B16", "#0A1426", "#07101F", "#0F1D36", "#17315C", "#12264A", "#22D3EE", "#38BDF8", "#E6F7FF", "#7FA6C4", "#22D3EE33", "#0C1A31", "#07101F", "#060D1B", 10, "stars"),
        T("crimson", "Crimson", true, "#0F0507", "#190A0E", "#13070A", "#251015", "#3A1820", "#2E131A", "#F43F5E", "#FB7185", "#FFF1F2", "#C49AA2", "#FFFFFF1F", "#200D12", "#13070A", "#0F0507", 12),
        T("emerald", "Emerald", true, "#04100C", "#08201A", "#06150F", "#0E2A21", "#16402F", "#12332A", "#10B981", "#34D399", "#ECFDF5", "#8FB9A8", "#FFFFFF1F", "#0A241C", "#06150F", "#04100C", 12),
        T("sakura", "Sakura", false, "#FDF2F6", "#FFF8FA", "#F9E4EC", "#FBEAF1", "#FFFFFF", "#FFFFFF", "#EC4899", "#F472B6", "#4A1D32", "#9A6A80", "#4A1D321F", "#FFFFFF", "#FCEFF4", "#FFF5F8", 16),
        T("sunset", "Sunset", true, "#140A0A", "#201010", "#190C0C", "#2D1816", "#43241C", "#37201A", "#FB923C", "#FBBF24", "#FFF7ED", "#C9A58C", "#FFFFFF1F", "#271412", "#190C0C", "#140A0A", 14, "gradient"),
        T("graphite", "Graphite", true, "#121315", "#1A1C1F", "#151618", "#212327", "#2D3036", "#272A2F", "#94A3B8", "#CBD5E1", "#F1F5F9", "#8B95A5", "#FFFFFF1F", "#1E2024", "#151618", "#121315", 8),
        T("neon-gaming", "Neon Gaming", true, "#05030A", "#0B0716", "#080512", "#130C26", "#201240", "#190F33", "#FA1E4E", "#FF6B9D", "#FFFFFF", "#A89CC8", "#FA1E4E40", "#0F0A1F", "#080512", "#05030A", 6, "particles", "Bahnschrift"),
        T("frosted", "Frosted Glass", true, "#10141C", "#1A202C", "#141922", "#232B3A", "#344058", "#2B3548", "#7DD3FC", "#BAE6FD", "#F0F9FF", "#9DB2C8", "#FFFFFF33", "#1E2636", "#141922", "#10141C", 18, "gradient"),
        T("minimal-light", "Minimal Light", false, "#F5F5F4", "#FAFAF9", "#ECECEA", "#EFEFED", "#FFFFFF", "#FFFFFF", "#111827", "#374151", "#111827", "#6B7280", "#1118271F", "#FFFFFF", "#F0F0EE", "#FAFAF9", 10),
        T("retro-dark", "Retro Dark", true, "#0B0F0A", "#121A11", "#0E140D", "#18231A", "#233523", "#1C2A1C", "#A3E635", "#BEF264", "#ECFCCB", "#8BA377", "#A3E63533", "#0F170F", "#0E140D", "#0B0F0A", 2, "none", "Consolas"),
    };

    public static ThemeDef Default => BuiltIn[0];

    public static ThemeDef? FindBuiltIn(string? id) => BuiltIn.FirstOrDefault(t => t.Id == id);

    // ---- validation of imported / edited themes -----------------------------------------------------------

    [GeneratedRegex(@"^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")]
    private static partial Regex HexColor();

    [GeneratedRegex(@"^[\p{L}\p{N} ._\-]{1,40}$")]
    private static partial Regex SafeName();

    public const int MaxThemeJsonBytes = 64 * 1024;

    /// <summary>Themes are plain data. Anything that isn't a known token, a valid colour or a bounded number is rejected.</summary>
    public static bool TryValidate(ThemeDef t, out string error)
    {
        error = "";
        if (string.IsNullOrWhiteSpace(t.Name) || !SafeName().IsMatch(t.Name)) { error = "Theme names can use letters, numbers, spaces and . _ - (up to 40)."; return false; }
        if (t.Colors.Count > Tokens.All.Count) { error = "The theme has unknown colour entries."; return false; }
        foreach (var (k, v) in t.Colors)
        {
            if (!Tokens.All.Contains(k)) { error = $"Unknown colour \"{k}\"."; return false; }
            if (!HexColor().IsMatch(v)) { error = $"\"{v}\" is not a colour like #1A2B3C."; return false; }
        }
        foreach (var token in Tokens.All)
            if (!t.Colors.ContainsKey(token)) { error = $"The colour \"{token}\" is missing."; return false; }
        if (t.CornerRadius is < 0 or > 32) { error = "Corner radius must be between 0 and 32."; return false; }
        if (t.Density is < 0.7 or > 1.4) { error = "Density must be between 0.7 and 1.4."; return false; }
        if (t.ShadowStrength is < 0 or > 1) { error = "Shadow strength must be between 0 and 1."; return false; }
        if (t.AnimationScale is < 0 or > 2) { error = "Animation speed must be between 0 and 2."; return false; }
        if (t.Animated is not ("none" or "gradient" or "stars" or "particles")) { error = "Unknown animated background."; return false; }
        if (string.IsNullOrWhiteSpace(t.FontFamily) || t.FontFamily.Length > 60 || t.FontFamily.Any(char.IsControl) || t.FontFamily.Contains('{') || t.FontFamily.Contains('<'))
        { error = "That font name isn't valid."; return false; }
        return true;
    }

    public static string Export(ThemeDef t) => JsonSerializer.Serialize(t, new JsonSerializerOptions { WriteIndented = true });

    public static bool TryImport(string json, out ThemeDef? theme, out string error)
    {
        theme = null; error = "";
        if (json.Length > MaxThemeJsonBytes) { error = "That theme file is too large."; return false; }
        try
        {
            var t = JsonSerializer.Deserialize<ThemeDef>(json);
            if (t is null) { error = "That file isn't a theme."; return false; }
            if (!TryValidate(t, out error)) return false;
            t.Id = "custom-" + Guid.NewGuid().ToString("N")[..8];
            t.BuiltIn = false;
            theme = t;
            return true;
        }
        catch (JsonException) { error = "That file isn't a valid theme."; return false; }
    }

    public static (byte A, byte R, byte G, byte B) ParseColor(string hex)
    {
        hex = hex.TrimStart('#');
        if (hex.Length == 6) return (255, B(0), B(2), B(4));
        return (B(6), B(0), B(2), B(4));
        byte B(int i) => byte.Parse(hex.AsSpan(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
    }
}
