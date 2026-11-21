namespace WIISBROWSING.Core.Util;

/// <summary>Small fuzzy matcher used by the command palette and tab search.</summary>
public static class Fuzzy
{
    /// <summary>Higher is better; null when <paramref name="query"/> doesn't match <paramref name="text"/>.</summary>
    public static int? Score(string query, string text)
    {
        query = query.Trim();
        if (query.Length == 0) return 0;
        if (string.IsNullOrEmpty(text)) return null;
        int total = 0;
        foreach (var token in query.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var s = ScoreToken(token, text);
            if (s is null) return null;
            total += s.Value;
        }
        return total;
    }

    private static int? ScoreToken(string token, string text)
    {
        int idx = text.IndexOf(token, StringComparison.OrdinalIgnoreCase);
        if (idx >= 0)
        {
            // A contiguous match beats a scattered one; starts of words and of the text beat the middle.
            int score = 100 + token.Length * 4;
            if (idx == 0) score += 40;
            else if (IsBoundary(text, idx)) score += 25;
            if (text.Length == token.Length) score += 30;
            return score - Math.Min(idx, 30);
        }
        // Subsequence: every character in order.
        int ti = 0, run = 0, best = 0, points = 0;
        foreach (var qc in token)
        {
            bool found = false;
            while (ti < text.Length)
            {
                if (char.ToLowerInvariant(text[ti]) == char.ToLowerInvariant(qc))
                {
                    run++;
                    best = Math.Max(best, run);
                    points += 6 + (IsBoundary(text, ti) ? 8 : 0) + run * 2;
                    ti++; found = true; break;
                }
                run = 0; ti++;
            }
            if (!found) return null;
        }
        return points + best * 3;
    }

    private static bool IsBoundary(string text, int i) =>
        i == 0 || !char.IsLetterOrDigit(text[i - 1]) || (char.IsUpper(text[i]) && char.IsLower(text[i - 1]));
}
