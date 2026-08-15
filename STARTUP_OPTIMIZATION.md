# Desktop App Startup Optimization — Final Solution

## Goal
Startup time ≤ 5s.

## Measured baseline (before)
- dsh backend boot: 12–14s warm, 50–94s cold (Windows Defender scanning ~34k vendor files)
- Total time-to-window: ~15s+ warm, minutes cold

## Fixes applied (in order of impact)

### 1. Windows Defender exclusions (~60s cold → ~13s, then warm ≈ 5s)
`scripts/add-defender-exclusions.ps1` adds exclusions for the vendor tree,
`~/.dsh` and the install dir via Add-MpPreference.

### 2. Persistent backend (re-launch ≈ 2.2s)
The dsh backend is detached, unref'd and file-logged, so it survives app
restarts. State is recorded in `%APPDATA%\deepseek-harness-desktop\server.json`
({url, pid}). On launch the app:
1. adopts the recorded backend if pid-alive + HTTP-responding (≈0.1s);
2. otherwise waits up to 25s for a "backend-booting" marker (see 3);
3. otherwise spawns a fresh backend.

Quit keeps the backend; tray menu has 退出（保持后台服务） and
停止后台服务并退出 (kills the backend, incl. adopted ones, via taskkill).

### 3. Logon pre-warm / autostart backend (first launch after reboot ≈ 2.2s)
`--backend-only` mode: at Windows logon the app starts silently (no tray, no
windows), boots the backend, writes server.json, exits (~5s, invisible).
Registered via app.setLoginItemSettings (HKCU Run), enabled by default,
toggled from the tray menu (开机自启后台服务). It does not take the
single-instance lock, so a user launching during pre-warm is never swallowed:
the UI app waits for the booting marker and adopts the warmed backend.
Race resolution in onServerReady guarantees exactly one backend survives.

## Measured (dev, warm cache, exclusions applied)
- fresh spawn, no backend: ~7.4s to window
- logon pre-warm backend-only: ~5.2s to server.json (invisible)
- launch adopting resident backend: ~2.2s to window ✓
- launch during pre-warm (worst race): ~9.5s to window

## Tradeoff
Backend stays resident (~150–250MB RAM). Opt-out in the tray menu.
