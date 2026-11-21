using System.Security.Cryptography;
using System.Text.Json;

namespace WIISBROWSING.Core.Updates;

/// <summary>A newer release the browser may download. <see cref="Signature"/> is over the installer file's bytes.</summary>
public sealed record UpdateOffer(Version Version, string Url, byte[] Signature, string Notes);

/// <summary>Reads the <c>latest.json</c> published next to a release and decides whether it is worth, and safe, to act on.</summary>
public static class UpdateManifest
{
    /// <summary>
    /// Returns the offer only if the manifest is well formed, newer than <paramref name="current"/>, and its download
    /// address is a file of <paramref name="repo"/>'s own GitHub releases (a manifest can never send the browser elsewhere).
    /// </summary>
    public static UpdateOffer? Evaluate(string json, Version current, string repo) =>
        string.IsNullOrWhiteSpace(repo) || repo.Split('/').Length != 2 ? null : EvaluateWithPrefix(json, current, $"https://github.com/{repo}/releases/download/");

    /// <summary>Same checks, for a different download location (the self-test serves releases from a local test server).</summary>
    public static UpdateOffer? EvaluateWithPrefix(string json, Version current, string downloadPrefix)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("version", out var v) || v.ValueKind != JsonValueKind.String) return null;
            if (!Version.TryParse(v.GetString()!.TrimStart('v', 'V'), out var version) || version <= Normalize(current)) return null;
            if (!root.TryGetProperty("url", out var u) || u.ValueKind != JsonValueKind.String) return null;
            var url = u.GetString()!;
            if (!url.StartsWith(downloadPrefix, StringComparison.OrdinalIgnoreCase) || url.Contains("..") || !url.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return null;
            if (!root.TryGetProperty("signature", out var s) || s.ValueKind != JsonValueKind.String) return null;
            byte[] signature;
            try { signature = Convert.FromBase64String(s.GetString()!); } catch (FormatException) { return null; }
            if (signature.Length == 0) return null;
            var notes = root.TryGetProperty("notes", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()! : "";
            return new UpdateOffer(version, url, signature, notes);
        }
        catch (JsonException) { return null; }
    }

    // An assembly version is 4-part (0.1.0.0); a release version is 3-part. Compare them the same way.
    private static Version Normalize(Version v) => new(Math.Max(v.Major, 0), Math.Max(v.Minor, 0), Math.Max(v.Build, 0));
}

/// <summary>Signs and checks installers. ECDSA P-256 over SHA-256: the private key stays on the developer's PC, the public key is built into the browser.</summary>
public static class UpdateSigning
{
    public static (byte[] PrivatePkcs8, byte[] PublicSpki) NewKeyPair()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return (key.ExportPkcs8PrivateKey(), key.ExportSubjectPublicKeyInfo());
    }

    public static byte[] Sign(Stream data, byte[] privatePkcs8)
    {
        using var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(privatePkcs8, out _);
        return key.SignData(data, HashAlgorithmName.SHA256);
    }

    public static bool Verify(Stream data, byte[] signature, byte[] publicSpki)
    {
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(publicSpki, out _);
            return key.VerifyData(data, signature, HashAlgorithmName.SHA256);
        }
        catch (CryptographicException) { return false; }
        catch (ArgumentException) { return false; }
    }
}
