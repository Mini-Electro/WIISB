// Release tool for WIISBROWSING's updates.
//   genkey <folder>                                     create the signing key pair once (private key stays in <folder>)
//   sign --file <setup.exe> --key <private.key> --version 0.1.1 --repo owner/repo [--notes "text"] --out <folder>
//        signs the installer and writes latest.json next to it (the file the browser looks for)
using System.Text.Json;
using WIISBROWSING.Core.Updates;

static string Arg(string[] a, string name) => a.SkipWhile(x => x != name).Skip(1).FirstOrDefault() ?? throw new ArgumentException($"Missing {name}");

try
{
    switch (args.FirstOrDefault())
    {
        case "genkey":
        {
            var dir = args.ElementAtOrDefault(1) ?? throw new ArgumentException("Give the folder for the key files.");
            Directory.CreateDirectory(dir);
            var priv = Path.Combine(dir, "browser-update.key"); var pub = Path.Combine(dir, "browser-update.pub");
            if (File.Exists(priv)) { Console.WriteLine("A browser signing key already exists; not overwriting it."); Console.WriteLine(File.ReadAllText(pub)); return 0; }
            var (p, s) = UpdateSigning.NewKeyPair();
            File.WriteAllText(priv, Convert.ToBase64String(p));
            File.WriteAllText(pub, Convert.ToBase64String(s));
            Console.WriteLine(Convert.ToBase64String(s));
            return 0;
        }
        case "sign":
        {
            var file = Arg(args, "--file"); var keyFile = Arg(args, "--key"); var version = Arg(args, "--version").TrimStart('v'); var repo = Arg(args, "--repo");
            var notes = args.Contains("--notes") ? Arg(args, "--notes") : ""; var tag = args.Contains("--tag") ? Arg(args, "--tag") : $"v{version}"; var outDir = Arg(args, "--out");
            var priv = Convert.FromBase64String(File.ReadAllText(keyFile).Trim());
            byte[] signature;
            using (var fs = File.OpenRead(file)) signature = UpdateSigning.Sign(fs, priv);
            // Prove it verifies with the matching public key before anything is published.
            using (var k = System.Security.Cryptography.ECDsa.Create()) { k.ImportPkcs8PrivateKey(priv, out _); using var fs = File.OpenRead(file); if (!UpdateSigning.Verify(fs, signature, k.ExportSubjectPublicKeyInfo())) throw new InvalidOperationException("Signature self-check failed."); }
            Directory.CreateDirectory(outDir);
            var name = Path.GetFileName(file);
            var manifest = new { version, url = $"https://github.com/{repo}/releases/download/{tag}/{name}", signature = Convert.ToBase64String(signature), notes };
            File.WriteAllText(Path.Combine(outDir, "latest.json"), JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Signed {name} and wrote latest.json to {outDir}");
            return 0;
        }
        default:
            Console.Error.WriteLine("Usage: genkey <folder> | sign --file F --key K --version V --repo owner/repo [--tag release-tag] [--notes N] --out DIR");
            return 2;
    }
}
catch (Exception ex) { Console.Error.WriteLine("Error: " + ex.Message); return 1; }
