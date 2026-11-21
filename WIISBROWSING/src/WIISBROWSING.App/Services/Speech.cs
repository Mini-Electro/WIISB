using System.Speech.Synthesis;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

/// <summary>Read aloud using the voices already installed in Windows. No cloud service is involved.</summary>
public static class Speech
{
    private static SpeechSynthesizer? _synth;

    public static IReadOnlyList<string> Voices()
    {
        try { using var s = new SpeechSynthesizer(); return s.GetInstalledVoices().Where(v => v.Enabled).Select(v => v.VoiceInfo.Name).ToList(); }
        catch (Exception ex) when (ex is InvalidOperationException or PlatformNotSupportedException) { return Array.Empty<string>(); }
    }

    public static bool Speak(string text, string? voice = null, int rate = 0)
    {
        try
        {
            Stop();
            _synth ??= new SpeechSynthesizer();
            if (!string.IsNullOrEmpty(voice)) { try { _synth.SelectVoice(voice); } catch (ArgumentException) { } }
            _synth.Rate = Math.Clamp(rate, -5, 5);
            _synth.SpeakAsync(text.Length > 40_000 ? text[..40_000] : text);
            return true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or PlatformNotSupportedException)
        {
            AppLog.Warn("speech unavailable: " + ex.Message);
            return false;
        }
    }

    public static void Pause() { try { _synth?.Pause(); } catch (InvalidOperationException) { } }
    public static void Resume() { try { _synth?.Resume(); } catch (InvalidOperationException) { } }
    public static void Stop() { try { _synth?.SpeakAsyncCancelAll(); } catch (InvalidOperationException) { } }
}
