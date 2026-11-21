using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Themes;

namespace WIISBROWSING.App.Services;

/// <summary>
/// Turns a <see cref="ThemeDef"/> into WPF resources. Brushes are created once and their colours are animated,
/// so every control bound with DynamicResource follows a theme change instantly and without a restart.
/// </summary>
public sealed class ThemeManager
{
    private readonly SettingsStore _settings;
    // WPF freezes anything placed in application resources, so a theme change swaps in new frozen brushes
    // (every DynamicResource follows) and animates by stepping the colours once per rendered frame.
    private readonly Dictionary<string, Color> _colors = new();
    private System.Diagnostics.Stopwatch? _tween;
    private Dictionary<string, Color> _from = new(), _to = new();
    private TimeSpan _tweenLength;

    public ThemeDef Current { get; private set; } = ThemeCatalog.Default;
    public event Action<ThemeDef>? Changed;

    public ThemeManager(SettingsStore appSettings)
    {
        _settings = appSettings;
        foreach (var token in Tokens.All) { _colors[token] = Colors.Magenta; SetBrush(token, Colors.Magenta); }
        Apply(Find(_settings.Get(SettingKeys.ThemeId)), animate: false);
    }

    public IReadOnlyList<ThemeDef> Custom
    {
        get
        {
            var list = _settings.GetJson<List<ThemeDef>>(SettingKeys.CustomThemes) ?? new();
            return list.Where(t => ThemeCatalog.TryValidate(t, out _)).ToList();
        }
    }

    public IEnumerable<ThemeDef> All => ThemeCatalog.BuiltIn.Concat(Custom);

    public ThemeDef Find(string? id) => All.FirstOrDefault(t => t.Id == id) ?? ThemeCatalog.Default;

    public void Select(string id)
    {
        _settings.Set(SettingKeys.ThemeId, id);
        Apply(Find(id), animate: true);
    }

    public ThemeDef SaveCustom(ThemeDef theme)
    {
        if (!ThemeCatalog.TryValidate(theme, out var err)) throw new ArgumentException(err);
        var list = Custom.ToList();
        if (string.IsNullOrEmpty(theme.Id) || ThemeCatalog.FindBuiltIn(theme.Id) is not null) theme.Id = "custom-" + Guid.NewGuid().ToString("N")[..8];
        theme.BuiltIn = false;
        int i = list.FindIndex(t => t.Id == theme.Id);
        if (i >= 0) list[i] = theme; else list.Add(theme);
        _settings.SetJson(SettingKeys.CustomThemes, list);
        return theme;
    }

    public void DeleteCustom(string id)
    {
        var list = Custom.Where(t => t.Id != id).ToList();
        _settings.SetJson(SettingKeys.CustomThemes, list);
        if (Current.Id == id) Select(ThemeCatalog.Default.Id);
    }

    public bool ReduceMotion { get; set; }

    public void Apply(ThemeDef theme, bool animate)
    {
        Current = theme;
        var res = Application.Current.Resources;
        var duration = TimeSpan.FromMilliseconds(220 * Math.Max(0.1, theme.AnimationScale));
        animate &= !ReduceMotion && theme.AnimationScale > 0.01;

        var target = new Dictionary<string, Color>();
        foreach (var token in Tokens.All)
        {
            var (a, r, g, b) = ThemeCatalog.ParseColor(theme.Color(token));
            target[token] = Color.FromArgb(a, r, g, b);
        }
        StartTween(target, animate ? duration : TimeSpan.Zero);

        double radius = theme.CornerRadius;
        res["CornerLarge"] = new CornerRadius(radius);
        res["CornerMedium"] = new CornerRadius(Math.Max(0, radius * 0.7));
        res["CornerSmall"] = new CornerRadius(Math.Max(0, radius * 0.45));
        res["CornerTop"] = new CornerRadius(Math.Max(0, radius * 0.7), Math.Max(0, radius * 0.7), 0, 0);
        res["CornerValueLarge"] = radius;
        res["TabItemHeight"] = Math.Round(36 * theme.Density);
        res["TabItemSpacing"] = new Thickness(0, Math.Round(2 * theme.Density), 0, Math.Round(2 * theme.Density));
        res["UiFontFamily"] = new FontFamily(theme.FontFamily + ", Segoe UI Variable Text, Segoe UI");
        res["AnimationFactor"] = ReduceMotion ? 0.0 : theme.AnimationScale;

        var shadowColor = theme.IsDark ? Colors.Black : Color.FromRgb(0x20, 0x28, 0x40);
        var shadow = new DropShadowEffect { Color = shadowColor, BlurRadius = 24, ShadowDepth = 6, Direction = 270, Opacity = 0.55 * theme.ShadowStrength * 1.6 };
        shadow.Freeze();
        res["PanelShadow"] = shadow;
        Changed?.Invoke(theme);
    }

    private static void SetBrush(string token, Color c)
    {
        var brush = new SolidColorBrush(c);
        brush.Freeze();
        Application.Current.Resources[token + "Brush"] = brush;
    }

    private void StartTween(Dictionary<string, Color> target, TimeSpan length)
    {
        if (_tween is not null) { CompositionTarget.Rendering -= OnRender; _tween = null; }
        if (length <= TimeSpan.Zero)
        {
            foreach (var (token, c) in target) { _colors[token] = c; SetBrush(token, c); }
            return;
        }
        _from = new Dictionary<string, Color>(_colors);
        _to = target;
        _tweenLength = length;
        _tween = System.Diagnostics.Stopwatch.StartNew();
        CompositionTarget.Rendering += OnRender;
    }

    private void OnRender(object? sender, EventArgs e)
    {
        if (_tween is null) return;
        double t = Math.Min(1.0, _tween.Elapsed.TotalMilliseconds / _tweenLength.TotalMilliseconds);
        double eased = 1 - Math.Pow(1 - t, 3);   // ease-out
        foreach (var (token, to) in _to)
        {
            var from = _from[token];
            var c = Color.FromArgb(Lerp(from.A, to.A, eased), Lerp(from.R, to.R, eased), Lerp(from.G, to.G, eased), Lerp(from.B, to.B, eased));
            _colors[token] = c;
            SetBrush(token, c);
        }
        if (t >= 1.0) { CompositionTarget.Rendering -= OnRender; _tween = null; }
    }

    private static byte Lerp(byte a, byte b, double t) => (byte)Math.Round(a + (b - a) * t);

    /// <summary>The tokens as CSS custom properties, for the internal pages (wiisb://…).</summary>
    public Dictionary<string, string> CssVariables(ThemeDef? t = null)
    {
        t ??= Current;
        var vars = new Dictionary<string, string>();
        foreach (var token in Tokens.All) vars["--" + Kebab(token)] = t.Color(token);
        vars["--radius"] = t.CornerRadius + "px";
        vars["--font"] = $"'{t.FontFamily}', 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
        vars["--density"] = t.Density.ToString(System.Globalization.CultureInfo.InvariantCulture);
        vars["--anim"] = (ReduceMotion ? 0 : t.AnimationScale).ToString(System.Globalization.CultureInfo.InvariantCulture);
        vars["--scheme"] = t.IsDark ? "dark" : "light";
        return vars;
    }

    private static string Kebab(string s) =>
        string.Concat(s.Select((c, i) => i > 0 && char.IsUpper(c) ? "-" + char.ToLowerInvariant(c) : char.ToLowerInvariant(c).ToString()));
}
