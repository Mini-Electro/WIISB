namespace WIISBROWSING.Core.Commands;

/// <summary>A keyboard shortcut such as Ctrl+Shift+T. Keys use WPF's <c>Key</c> names (T, F5, Tab, Left, OemPlus…).</summary>
public readonly record struct KeyChord(bool Ctrl, bool Shift, bool Alt, string Key)
{
    public static bool TryParse(string? text, out KeyChord chord)
    {
        chord = default;
        if (string.IsNullOrWhiteSpace(text)) return false;
        bool ctrl = false, shift = false, alt = false;
        string? key = null;
        foreach (var part in text.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl" or "control": ctrl = true; break;
                case "shift": shift = true; break;
                case "alt": alt = true; break;
                default:
                    if (key is not null) return false;
                    key = Normalize(part); break;
            }
        }
        if (key is null) return false;
        chord = new KeyChord(ctrl, shift, alt, key);
        return true;
    }

    private static string Normalize(string key) => key.ToLowerInvariant() switch
    {
        "plus" or "+" or "=" => "OemPlus",
        "minus" or "-" => "OemMinus",
        "0" => "D0", "1" => "D1", "2" => "D2", "3" => "D3", "4" => "D4",
        "5" => "D5", "6" => "D6", "7" => "D7", "8" => "D8", "9" => "D9",
        var k when k.Length == 1 && char.IsLetter(k[0]) => k.ToUpperInvariant(),
        var k => char.ToUpperInvariant(k[0]) + k[1..],
    };

    public override string ToString()
    {
        var parts = new List<string>(4);
        if (Ctrl) parts.Add("Ctrl");
        if (Shift) parts.Add("Shift");
        if (Alt) parts.Add("Alt");
        parts.Add(Key switch { "OemPlus" => "Plus", "OemMinus" => "Minus", var k when k.Length == 2 && k[0] == 'D' && char.IsDigit(k[1]) => k[1..], var k => k });
        return string.Join('+', parts);
    }
}

/// <summary>Maps keyboard shortcuts to command ids, with user overrides and conflict detection.</summary>
public sealed class ShortcutMap
{
    // Shortcuts Windows or the web page itself own; the browser never takes these over.
    private static readonly HashSet<KeyChord> Reserved = new()
    {
        new(false, false, true, "F4"), new(true, false, false, "C"), new(true, false, false, "V"),
        new(true, false, false, "X"), new(true, false, false, "A"), new(true, false, false, "Z"),
        new(true, false, false, "Y"), new(true, false, true, "Delete"),
    };

    private readonly Dictionary<KeyChord, string> _byChord = new();
    private readonly Dictionary<string, KeyChord> _byCommand = new();

    public static ShortcutMap WithDefaults(IEnumerable<BrowserCommand> commands, IReadOnlyDictionary<string, string>? overrides = null)
    {
        var map = new ShortcutMap();
        foreach (var c in commands)
        {
            string? text = overrides is not null && overrides.TryGetValue(c.Id, out var o) ? o : c.DefaultShortcut;
            if (KeyChord.TryParse(text, out var chord)) map.TryAssign(c.Id, chord, force: true);
        }
        return map;
    }

    public string? CommandFor(KeyChord chord) => _byChord.GetValueOrDefault(chord);
    public KeyChord? ChordFor(string commandId) => _byCommand.TryGetValue(commandId, out var c) ? c : null;
    public IEnumerable<KeyValuePair<string, KeyChord>> Bindings => _byCommand;

    /// <summary>The command already using this shortcut (other than <paramref name="exceptCommand"/>), if any.</summary>
    public string? FindConflict(KeyChord chord, string? exceptCommand = null) =>
        _byChord.TryGetValue(chord, out var id) && id != exceptCommand ? id : null;

    public static bool IsReserved(KeyChord chord) => Reserved.Contains(chord);

    public bool TryAssign(string commandId, KeyChord chord, bool force = false)
    {
        if (!force && (IsReserved(chord) || FindConflict(chord, commandId) is not null)) return false;
        if (_byCommand.TryGetValue(commandId, out var old)) _byChord.Remove(old);
        if (_byChord.TryGetValue(chord, out var other)) _byCommand.Remove(other);
        _byChord[chord] = commandId;
        _byCommand[commandId] = chord;
        return true;
    }

    public void Clear(string commandId)
    {
        if (_byCommand.Remove(commandId, out var chord)) _byChord.Remove(chord);
    }
}
