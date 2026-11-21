using WIISBROWSING.Core.Util;

namespace WIISBROWSING.Core.Commands;

/// <summary>One thing the command palette (Ctrl+K) and the keyboard can do.</summary>
public sealed class BrowserCommand
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Category { get; init; }
    public string Keywords { get; init; } = "";
    public string? DefaultShortcut { get; init; }
    /// <summary>Aliases (a second shortcut for the same action) are bound to keys but not listed in the palette.</summary>
    public bool Hidden { get; init; }
    public Action? Execute { get; set; }
    public Func<bool>? IsAvailable { get; set; }
    public bool Available => Execute is not null && (IsAvailable?.Invoke() ?? true);
}

public sealed class CommandRegistry
{
    private readonly Dictionary<string, BrowserCommand> _commands = new();
    private readonly Dictionary<string, int> _useCount = new();

    public IReadOnlyCollection<BrowserCommand> All => _commands.Values;

    public void Register(BrowserCommand command)
    {
        if (!_commands.TryAdd(command.Id, command))
            throw new InvalidOperationException($"Duplicate command id {command.Id}");
    }

    public BrowserCommand? Get(string id) => _commands.GetValueOrDefault(id);

    public bool Execute(string id)
    {
        if (!_commands.TryGetValue(id, out var c) || !c.Available) return false;
        _useCount[id] = _useCount.GetValueOrDefault(id) + 1;
        c.Execute!.Invoke();
        return true;
    }

    /// <summary>Fuzzy search over name, category and keywords; unavailable commands are left out.</summary>
    public IReadOnlyList<BrowserCommand> Search(string query, int limit = 12)
    {
        query = (query ?? "").Trim();
        if (query.StartsWith('>')) query = query[1..].Trim();
        var pool = _commands.Values.Where(c => c.Available && !c.Hidden);
        if (query.Length == 0)
            return pool.OrderByDescending(c => _useCount.GetValueOrDefault(c.Id)).ThenBy(c => c.Name).Take(limit).ToList();

        return pool
            .Select(c => (c, score: BestScore(query, c)))
            .Where(x => x.score is not null)
            .OrderByDescending(x => x.score + _useCount.GetValueOrDefault(x.c.Id) * 3)
            .ThenBy(x => x.c.Name.Length)
            .Take(limit)
            .Select(x => x.c)
            .ToList();
    }

    private static int? BestScore(string query, BrowserCommand c)
    {
        int? name = Fuzzy.Score(query, c.Name);
        int? words = Fuzzy.Score(query, c.Name + " " + c.Keywords + " " + c.Category);
        if (name is null && words is null) return null;
        return Math.Max(name is null ? 0 : name.Value + 30, words ?? 0);
    }
}
