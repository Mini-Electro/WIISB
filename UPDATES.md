# Automatic updates for the WIISB apps

WIISB Chat, WIISB Launcher and WIISBROWSING check GitHub for a newer version a few seconds after they start and then every
6 hours. A new version is downloaded quietly, its signature is checked, and the app then offers **Restart to update**
(WIISBROWSING installs it when you next close it if you pick *Later*). Nothing closes or restarts without that choice.

An update is only ever accepted if it is **signed with your private key**. Anyone can read the public half (it is built into
the apps), but only you can make a release the apps will accept - so even a hijacked download link can't push a fake update.

## One-time setup (about 5 minutes)

Everything lives in one GitHub repo: <https://github.com/Mini-Electro/WIISB> (already set in `scripts\update-config.json`).

1. The repo must be **Public**. The apps download updates without logging in, so a private repo (or one that doesn't
   exist yet) makes every update check fail quietly. Repo -> Settings -> General -> Danger Zone -> Change visibility.
2. Create three releases in it, one per app, with exactly these tags (the title can be anything, no files needed yet):
   `chat-latest`, `launcher-latest`, `browser-latest`.
   Each app only ever looks inside its own release, and that release always holds that app's newest files.
3. **Back up `C:\Users\<you>\.wiisb-keys\`** (a USB stick or a cloud drive you trust).
   If those two private key files are lost, every installed copy is stuck on its current version forever.
   Never post them anywhere or put them in the repository.

## Publishing an update

From `E:\Development\Physical App Development`:

```powershell
.\scripts\Release-App.ps1 -App chat     -Version 0.1.1 -Notes "Voice chat fix"
.\scripts\Release-App.ps1 -App browser  -Version 0.1.1 -Notes "Tabs can be dragged out"
.\scripts\Release-App.ps1 -App launcher -Version 1.0.1          # do chat and browser first: the launcher bundles their installers
```

Each run bumps the version, builds, signs, and puts the files in `releases\<app>\v<version>\`.
Then on GitHub open that app's release (`chat-latest`, `browser-latest` or `launcher-latest`), **delete its old files**,
drag in **every file from that folder** (including `latest.json`), and save. Within about 6 hours everybody's copy updates itself.

Rule: the version number must go **up** each time.

## Things to know

- **Each app has an on/off switch and a button.** WIISB Launcher: Settings > General > *Automatic updates* and *Check for updates*. WIISB Chat: Settings > Connection > *Update WIISB Chat automatically* and *Check for updates*. WIISBROWSING: Settings > General > *Update automatically* and *Check for updates*. With the switch off nothing is looked up in the background; the button still checks on demand, and nothing ever restarts without you choosing "Restart to update".
- **The apps you already have installed will not update yet.** The update address is compiled in by `Release-App.ps1`.
  Build one release per app with it and install that once (for you and your friends); every later update is automatic.
- **WIISBROWSING only updates the *installed* copy** (from its setup file). The portable folder
  `WIISBROWSING\release\WIISBROWSING` never updates itself.
- **Windows SmartScreen** may say "unknown publisher" the first time someone installs, because the installers aren't
  code-signed with a paid certificate. The *update signature* above is separate and always checked.
- **The chat server is not updated by this.** It runs on your PC: rebuild it (`npm run build`) and restart
  `Start WIISB Chat Server.cmd` when you change `apps\server`. The database upgrades itself on start.
- Update activity is logged: Chat/Launcher in `updates.log` inside their data folder
  (`%LOCALAPPDATA%\com.wiisb.chat`, `%LOCALAPPDATA%\com.wiisb.games`); the browser in its normal log.
