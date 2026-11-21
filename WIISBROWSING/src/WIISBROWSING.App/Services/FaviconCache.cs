using System.Security.Cryptography;
using System.Text;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

/// <summary>Small on-disk cache of site icons, keyed by host, with a size cap. Private windows keep theirs in memory only.</summary>
public sealed class FaviconCache
{
    private const int MaxFiles = 600;
    private readonly string _dir;
    private readonly Dictionary<string, ImageSource> _memory = new();

    public FaviconCache(string dir) { _dir = dir; Directory.CreateDirectory(dir); }

    private string PathFor(string host) =>
        Path.Combine(_dir, Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(host.ToLowerInvariant())))[..16] + ".png");

    public ImageSource? Get(string host)
    {
        if (string.IsNullOrEmpty(host)) return null;
        if (_memory.TryGetValue(host, out var m)) return m;
        var p = PathFor(host);
        if (!File.Exists(p)) return null;
        try
        {
            var img = Load(File.ReadAllBytes(p));
            _memory[host] = img;
            return img;
        }
        catch (Exception ex) when (ex is IOException or NotSupportedException or FileFormatException) { return null; }
    }

    public byte[]? GetBytes(string host)
    {
        if (string.IsNullOrEmpty(host) || host.Length > 253 || host.Any(c => !(char.IsLetterOrDigit(c) || c is '.' or '-'))) return null;
        try { var p = PathFor(host); return File.Exists(p) ? File.ReadAllBytes(p) : null; }
        catch (IOException) { return null; }
    }

    public ImageSource? Store(string host, byte[] png, bool persist)
    {
        if (string.IsNullOrEmpty(host) || png.Length == 0 || png.Length > 256 * 1024) return null;
        ImageSource img;
        try { img = Load(png); } catch (Exception ex) when (ex is NotSupportedException or FileFormatException) { return null; }
        _memory[host] = img;
        if (persist)
        {
            try { File.WriteAllBytes(PathFor(host), png); Trim(); }
            catch (IOException ex) { AppLog.Warn("favicon cache write failed: " + ex.Message); }
        }
        return img;
    }

    private static BitmapImage Load(byte[] bytes)
    {
        var bmp = new BitmapImage();
        bmp.BeginInit();
        bmp.CacheOption = BitmapCacheOption.OnLoad;
        bmp.DecodePixelWidth = 32;
        bmp.StreamSource = new MemoryStream(bytes);
        bmp.EndInit();
        bmp.Freeze();
        return bmp;
    }

    private void Trim()
    {
        var files = new DirectoryInfo(_dir).GetFiles("*.png");
        if (files.Length <= MaxFiles) return;
        foreach (var f in files.OrderBy(f => f.LastWriteTimeUtc).Take(files.Length - MaxFiles + 50))
        {
            try { f.Delete(); } catch (IOException) { }
        }
    }

    public void ClearAll()
    {
        _memory.Clear();
        foreach (var f in Directory.GetFiles(_dir, "*.png")) { try { File.Delete(f); } catch (IOException) { } }
    }
}
