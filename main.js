'use strict'

/*
 * DeepSeek Harness — desktop shell.
 *
 * Wraps the bundled `dsh web` (self-contained node + dsh) in an Electron shell:
 *   - a frameless splash (no min/max/close buttons) shows the DeepSeek animation;
 *     double-clicking the blank area hides it
 *   - once the server is ready, the main window fades in gradually
 *   - keeps a system-tray icon for show/hide/open-in-browser/quit
 */

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, nativeTheme, screen, Notification } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const PRODUCT_NAME = 'DeepSeek Harness'
const LOOPBACK_HOST = '127.0.0.1'
const READY_LINE = /dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+)/i
const READY_TIMEOUT_MS = 90 * 1000
const SPLASH_SIZE = { width: 560, height: 420 }

let mainWindow = null
let splashWindow = null
let menuWindow = null
let tray = null
let dshProc = null
/** Timestamp of the last tray-icon click: clicking the tray must not count
 *  as "switching to another app" for the splash auto-minimize. */
let lastTrayClickTime = 0
let splashBlurTimer = null
/** When the user restored/shown the splash via the taskbar (Date.now()). */
let splashRestoreTime = 0
let webUrl = null
let isQuitting = false
let splashExited = false
let pageLoaded = false
let revealed = false
let trayIconEmpty = true
let balanceText = '余额：查询中…'
let balanceTimer = null
let lastBalanceData = { total: '查询中…', detail: '', error: false, low: false }

/** --backend-only: silent logon pre-warm; start the backend, record it, exit. */
const backendOnly = process.argv.includes('--backend-only')
/** Whether "start backend at logon" is enabled (tray-menu toggle). */
let autostartBackend = true

const assetsDir = path.join(__dirname, 'assets')

/** Track the web UI's active theme so the window background matches it. */
let uiTheme = 'light'

/** Window background: white for light UI, the splash navy for dark UI. */
function uiBackgroundColor() {
  return uiTheme === 'dark' ? '#0b1536' : '#ffffff'
}

function log() {
  const parts = Array.prototype.slice.call(arguments).map(function (p) {
    return typeof p === 'string' ? p : JSON.stringify(p)
  })
  process.stdout.write('[desktop] ' + parts.join(' ') + '\n')
}

// ---------------------------------------------------------------------------
// dsh discovery + spawn
// ---------------------------------------------------------------------------

function findOnPath(name) {
  const pathVar = process.env.PATH || ''
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  const names = [name].concat(exts.map(function (e) { return e ? name + e.toLowerCase() : name }))
  const dirs = pathVar.split(path.delimiter)
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]
    if (!dir) continue
    for (let j = 0; j < names.length; j++) {
      const candidate = path.join(dir, names[j])
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch (err) { /* keep looking */ }
    }
  }
  return null
}

function npmGlobalRoots() {
  const roots = []
  if (process.env.DSH_ROOT) roots.push(path.join(process.env.DSH_ROOT, 'node_modules'))
  if (process.env.NODE_PATH) {
    process.env.NODE_PATH.split(path.delimiter).forEach(function (p) { if (p) roots.push(p) })
  }
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true })
    if (r && r.status === 0 && r.stdout) roots.push(r.stdout.trim())
  } catch (err) { /* ignore */ }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  return roots
}

function resolveDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN
  const roots = npmGlobalRoots()
  for (let i = 0; i < roots.length; i++) {
    const bin = path.join(roots[i], '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(bin)) return bin
  }
  return findOnPath('dsh.cmd') || findOnPath('dsh.ps1') || findOnPath('dsh')
}

function findNode() {
  return findOnPath('node.exe') || findOnPath('node')
}

/** Bundled Node runtime (dev: <app>/vendor; packaged: resources/vendor via extraResources). */
function bundledNodeExe() {
  const candidates = [
    path.join(__dirname, 'vendor', 'node', 'node.exe'),
    path.join(process.resourcesPath, 'vendor', 'node', 'node.exe')
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return null
}

/** Bundled dsh CLI entry + its complete dependency tree (vendor/dsh/node_modules). */
function bundledDshBin() {
  const candidates = [
    path.join(__dirname, 'vendor', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(process.resourcesPath, 'vendor', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return null
}

function buildDshSpawn() {
  const args = ['web', '--host', LOOPBACK_HOST, '--port', '0']
  const nodeExe = bundledNodeExe()
  const bundledBin = bundledDshBin()
  if (nodeExe && bundledBin) {
    return { command: nodeExe, args: [bundledBin].concat(args), shell: false, asNode: false, bundled: true }
  }
  const bin = resolveDshBin()
  if (!bin) return null
  const lower = bin.toLowerCase()
  if (lower.endsWith('.js')) {
    const node = findNode()
    if (node) return { command: node, args: [bin].concat(args), shell: false, asNode: false, bundled: false }
    return { command: process.execPath, args: [bin].concat(args), shell: false, asNode: true, bundled: false }
  }
  return { command: bin, args: args, shell: process.platform === 'win32', asNode: false, bundled: false }
}

function killDsh() {
  const proc = dshProc
  dshProc = null
  // Adoption mode: dshProc is null, kill the backend recorded in server.json.
  let pid = proc ? proc.pid : null
  if (!pid) {
    const state = readServerState()
    if (state) pid = state.pid
  }
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc ? proc.kill('SIGTERM') : process.kill(pid, 'SIGTERM')
    }
  } catch (err) {
    log('kill error', String(err))
  }
}

// ---------------------------------------------------------------------------
// persistent backend: keep the dsh server alive across app restarts so the
// next launch adopts it and starts in seconds
// ---------------------------------------------------------------------------

let readyLogPath = null
let readyPollTimer = null

function serverStateFile() {
  return path.join(app.getPath('userData'), 'server.json')
}

function readServerState() {
  try {
    const data = JSON.parse(fs.readFileSync(serverStateFile(), 'utf8'))
    if (data && typeof data.url === 'string' && typeof data.pid === 'number') return data
  } catch (err) { /* ignore */ }
  return null
}

function writeServerState(url, pid) {
  try {
    fs.mkdirSync(path.dirname(serverStateFile()), { recursive: true })
    fs.writeFileSync(serverStateFile(), JSON.stringify({ url: url, pid: pid, startedAt: Date.now() }))
  } catch (err) { /* ignore */ }
}

function clearServerState() {
  try { fs.unlinkSync(serverStateFile()) } catch (err) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// prefs + booting marker
// ---------------------------------------------------------------------------

function prefsFile() {
  return path.join(app.getPath('userData'), 'prefs.json')
}

function readPrefs() {
  try {
    const data = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))
    if (data && typeof data === 'object') return data
  } catch (err) { /* ignore */ }
  return {}
}

function writePrefs(p) {
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true })
    fs.writeFileSync(prefsFile(), JSON.stringify(p))
  } catch (err) { /* ignore */ }
}

function backendBootingFile() {
  return path.join(app.getPath('userData'), 'backend-booting.json')
}

/** Mark "a backend is booting right now" so concurrent launches wait instead of spawning a second one. */
function writeBootingMarker() {
  try {
    fs.mkdirSync(path.dirname(backendBootingFile()), { recursive: true })
    fs.writeFileSync(backendBootingFile(), JSON.stringify({ at: Date.now() }))
  } catch (err) { /* ignore */ }
}

function clearBootingMarker() {
  try { fs.unlinkSync(backendBootingFile()) } catch (err) { /* ignore */ }
}

function bootingMarkerFresh() {
  try {
    return Date.now() - fs.statSync(backendBootingFile()).mtimeMs < 90000
  } catch (err) { return false }
}

/** Toggle the "start backend at logon" setting: persist + Windows Run entry. */
function applyAutostart(enabled) {
  autostartBackend = !!enabled
  const prefs = readPrefs()
  prefs.autostartBackend = autostartBackend
  writePrefs(prefs)
  if (process.platform === 'win32') {
    try {
      app.setLoginItemSettings({ openAtLogin: autostartBackend, args: ['--backend-only'] })
      log('autostart backend', autostartBackend ? 'on' : 'off')
    } catch (err) {
      log('autostart error', String(err))
    }
  }
  sendMenuData()
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

async function serverResponds(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2500) })
    return true
  } catch (err) {
    return false
  }
}

async function tryAdoptServer() {
  const state = readServerState()
  if (!state) return false
  if (!pidAlive(state.pid)) { clearServerState(); return false }
  if (!(await serverResponds(state.url))) return false
  log('adopt existing server', state.url)
  onServerReady(state.url)
  return true
}

function stopReadyPoll() {
  if (readyPollTimer) { clearInterval(readyPollTimer); readyPollTimer = null }
}

function startDsh() {
  const spec = buildDshSpawn()
  if (!spec) {
    showStartupError('未找到 dsh 命令。请先安装 DeepSeek Harness（npx @deepseek-ai/dsh web），或设置 DSH_BIN 环境变量指向 dsh。')
    return
  }
  // Instant startup: adopt an already-running backend if one exists.
  tryAdoptServer().then(function (adopted) {
    if (adopted) return
    // A backend may be mid-boot (logon pre-warm): wait for it instead of
    // spawning a duplicate.
    waitForBootingBackend().then(function (found) {
      if (!found) spawnDsh(spec)
    })
  })
}

/** Wait up to 25s for a backend that is currently booting (booting marker present). */
function waitForBootingBackend() {
  return new Promise(function (resolve) {
    if (!bootingMarkerFresh()) { resolve(false); return }
    let checking = false
    const deadline = Date.now() + 25000
    const timer = setInterval(function () {
      if (isQuitting || Date.now() > deadline || !bootingMarkerFresh()) {
        clearInterval(timer)
        resolve(false)
        return
      }
      if (checking) return
      checking = true
      const state = readServerState()
      if (state && pidAlive(state.pid)) {
        serverResponds(state.url).then(function (ok) {
          checking = false
          if (ok) {
            clearInterval(timer)
            log('adopt warmed backend', state.url)
            onServerReady(state.url)
            resolve(true)
          }
        })
      } else {
        checking = false
      }
    }, 400)
  })
}

function spawnDsh(spec) {
  const env = Object.assign({}, process.env)
  if (spec.asNode) env.ELECTRON_RUN_AS_NODE = '1'
  if (spec.bundled) {
    delete env.NODE_PATH
    delete env.DSH_BIN
  }
  const logDir = path.join(app.getPath('userData'), 'logs')
  try { fs.mkdirSync(logDir, { recursive: true }) } catch (err) { /* ignore */ }
  const outLog = path.join(logDir, 'dsh-out.log')
  const errLog = path.join(logDir, 'dsh-err.log')
  let outFd = 'ignore'
  let errFd = 'ignore'
  try {
    outFd = fs.openSync(outLog, 'w')
    errFd = fs.openSync(errLog, 'w')
  } catch (err) { /* keep 'ignore' */ }
  log('spawn', spec.command, spec.args.join(' '))
  let proc
  try {
    // Detached so the backend survives app restarts; output goes to log files
    // (pipes would break when this process exits).
    proc = spawn(spec.command, spec.args, { env: env, shell: spec.shell, detached: true, windowsHide: true, stdio: ['ignore', outFd, errFd] })
  } catch (err) {
    showStartupError('无法启动 dsh：' + String(err && err.message ? err.message : err))
    return
  }
  if (outFd !== 'ignore') { try { fs.closeSync(outFd) } catch (err) { /* ignore */ } }
  if (errFd !== 'ignore') { try { fs.closeSync(errFd) } catch (err) { /* ignore */ } }
  proc.unref()
  dshProc = proc
  readyLogPath = outLog
  writeBootingMarker()

  proc.on('error', function (err) {
    showStartupError('dsh 启动失败：' + String(err && err.message ? err.message : err))
  })
  proc.on('exit', function (code, signal) {
    log('dsh exited', code, signal)
    dshProc = null
    if (!isQuitting && !webUrl) {
      showStartupError('dsh 进程意外退出（退出码 ' + String(code) + '）')
    }
  })

  // Readiness: poll the stdout log file for the URL line.
  const deadline = Date.now() + READY_TIMEOUT_MS
  readyPollTimer = setInterval(function () {
    if (webUrl) { stopReadyPoll(); return }
    if (Date.now() > deadline) {
      stopReadyPoll()
      if (!isQuitting) showStartupError('等待 dsh web 就绪超时。')
      return
    }
    let text = ''
    try { text = fs.readFileSync(readyLogPath, 'utf8') } catch (err) { return }
    const m = READY_LINE.exec(text)
    if (m && !webUrl) onServerReady(m[1])
  }, 150)
}

/** Kill the backend and forget its state (explicit stop). */
function stopServer() {
  stopReadyPoll()
  killDsh()
  clearServerState()
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: SPLASH_SIZE.width,
    height: SPLASH_SIZE.height,
    frame: false,
    transparent: false,
    backgroundColor: '#0b1536',
    resizable: true,
    minWidth: 380,
    minHeight: 300,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    icon: path.join(assetsDir, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  splashWindow.loadFile(path.join(__dirname, 'splash.html'))
  splashWindow.once('ready-to-show', function () { splashWindow.show(); splashWindow.focus() })
  // Track taskbar restore/show: never re-minimize right after a manual
  // restore (that made the window bounce between desktop and taskbar).
  splashWindow.on('restore', function () { splashRestoreTime = Date.now() })
  splashWindow.on('show', function () { splashRestoreTime = Date.now() })
  // Auto-minimize to the taskbar when switching to another app, but NOT
  // when the tray icon is clicked (blur order vs. tray click is racy on
  // Windows, so delay and check whether a tray click happened nearby).
  splashWindow.on('blur', function () {
    if (splashBlurTimer) return
    splashBlurTimer = setTimeout(function () {
      splashBlurTimer = null
      if (!splashWindow || splashWindow.isDestroyed()) return
      if (Date.now() - lastTrayClickTime < 400) return
      // The user just brought the window back via the taskbar: keep it.
      if (Date.now() - splashRestoreTime < 600) return
      // Already minimized or refocused in the meantime: nothing to do.
      if (splashWindow.isMinimized() || splashWindow.isFocused()) return
      splashWindow.minimize()
    }, 250)
  })
  splashWindow.on('closed', function () { splashWindow = null })
}

/** Force the harness web UI to the dark navy theme matching the splash. */
function injectUiTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const navyCss = [
    'body[data-ds-dark-theme]{',
    '--dsw-alias-bg-base:#0b1536!important;',
    '--dsw-alias-bg-layer-1:#0f1d47!important;',
    '--dsw-alias-bg-layer-2:#142650!important;',
    '--dsw-alias-bg-layer-3:#182c5c!important;',
    '--dsw-specific-sidebar-fill:#0a1228!important;',
    '--dsw-specific-selector:#142650!important;',
    '--dsw-specific-input-major:#0f1d47!important;',
    '}'
  ].join('')
  mainWindow.webContents.insertCSS(navyCss).catch(function () {})
  // Starfield + meteor shower floating over the dark navy background.
  const skyCss = [
    '#ds-star-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:2147483000}',
    '#ds-star-layer .ds-star{position:absolute;background:#fff;border-radius:50%;animation:dsTwinkle 3s ease-in-out infinite}',
    '@keyframes dsTwinkle{0%,100%{opacity:.12}50%{opacity:.9}}',
    '#ds-star-layer .ds-meteor{position:absolute;width:130px;height:1.6px;border-radius:2px;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(190,215,255,.95));box-shadow:0 0 6px rgba(180,210,255,.7);transform:rotate(-38deg);opacity:0;animation:dsMeteor 8s linear infinite}',
    '@keyframes dsMeteor{0%{transform:translate3d(0,0,0) rotate(-38deg);opacity:0}2%{opacity:1}10%{transform:translate3d(110vw,55vh,0) rotate(-38deg);opacity:0}100%{transform:translate3d(110vw,55vh,0) rotate(-38deg);opacity:0}}'
  ].join('')
  mainWindow.webContents.insertCSS(skyCss).catch(function () {})
  const skyScript = [
    '(function(){',
    'if(window.__dsSkyInjected)return;window.__dsSkyInjected=true;',
    'function build(){',
    'if(!document.body){setTimeout(build,200);return}',
    'var layer=document.createElement("div");layer.id="ds-star-layer";',
    'for(var i=0;i<70;i++){var s=document.createElement("i");s.className="ds-star";',
    'var sz=(0.8+Math.random()*1.8).toFixed(1);s.style.width=s.style.height=sz+"px";',
    's.style.left=(Math.random()*100).toFixed(2)+"%";s.style.top=(Math.random()*100).toFixed(2)+"%";',
    's.style.animationDuration=(2+Math.random()*4).toFixed(1)+"s";s.style.animationDelay=(-Math.random()*5).toFixed(1)+"s";',
    's.style.opacity=(0.3+Math.random()*0.6).toFixed(2);layer.appendChild(s);}',
    'var delays=[0,7,14,21];',
    'for(var j=0;j<delays.length;j++){var m=document.createElement("i");m.className="ds-meteor";',
    'm.style.top=(5+Math.random()*30).toFixed(0)+"vh";m.style.left=(-15-Math.random()*10).toFixed(0)+"vw";',
    'm.style.animationDelay=delays[j]+"s";layer.appendChild(m);}',
    'document.body.appendChild(layer);',
    'var sync=function(){layer.style.display=document.body.hasAttribute("data-ds-dark-theme")?"":"none"};sync();',
    'if(window.MutationObserver){new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:["data-ds-dark-theme"]});}',
    '}',
    'build();',
    '})();'
  ].join('')
  mainWindow.webContents.executeJavaScript(skyScript).catch(function () {})
  // Report the active theme (light/dark) to the main process so the window
  // background follows the UI's own toggle; dark mode additionally gets the
  // navy palette matching the splash.
  const script = [
    '(function(){',
    'var A="data-ds-dark-theme";',
    'function report(){if(document.body&&window.desktop&&window.desktop.setUiTheme){window.desktop.setUiTheme(document.body.hasAttribute(A)?"dark":"light");}}',
    'report();',
    'var g=new MutationObserver(report);',
    'function start(){if(document.body){g.observe(document.body,{attributes:true,attributeFilter:[A]});}}',
    'if(document.body){start();}',
    'else{var w=new MutationObserver(function(){report();if(document.body){start();w.disconnect();}});w.observe(document.documentElement,{childList:true,subtree:true});}',
    '})();'
  ].join('')
  mainWindow.webContents.executeJavaScript(script).catch(function () {})
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: uiBackgroundColor(),
    autoHideMenuBar: true,
    icon: path.join(assetsDir, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.setMenuBarVisibility(false)

  // Apply the dark navy theme as early as the document exists.
  mainWindow.webContents.on('dom-ready', function () { injectUiTheme() })

  mainWindow.webContents.on('did-finish-load', function () {
    injectUiTheme()
    pageLoaded = true
    maybeReveal()
  })

  mainWindow.webContents.on('did-fail-load', function (event, code, desc, url, isMainFrame) {
    if (!isMainFrame || code === -3) return
    if (webUrl && url.indexOf(webUrl) === 0) {
      log('did-fail-load', code, desc)
      showStartupError('Web UI 加载失败（' + String(code) + ' ' + String(desc) + '）')
    }
  })

  mainWindow.webContents.setWindowOpenHandler(function (detail) {
    if (detail.url.indexOf(webUrl || '') === 0) return { action: 'allow' }
    shell.openExternal(detail.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', function (event, target) {
    if (webUrl && target.indexOf(webUrl) !== 0) {
      event.preventDefault()
      shell.openExternal(target)
    }
  })

  mainWindow.on('close', function (event) {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', function () { mainWindow = null })

  if (url) mainWindow.loadURL(url)
}

function revealMain() {
  if (revealed || !mainWindow || mainWindow.isDestroyed()) return
  revealed = true
  mainWindow.setOpacity(0)
  mainWindow.show()
  mainWindow.focus()
  // Paint one invisible frame first, then fade in gradually (slow start).
  setTimeout(function () {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const duration = 450
    const start = Date.now()
    const timer = setInterval(function () {
      if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(timer); return }
      const t = Math.min(1, (Date.now() - start) / duration)
      const eased = t * t
      mainWindow.setOpacity(eased)
      if (t >= 1) {
        mainWindow.setOpacity(1)
        clearInterval(timer)
      }
    }, 16)
  }, 60)

  if (process.env.DSH_DESKTOP_SMOKE === '1') {
    setTimeout(function () {
      log('SMOKE_OK url=' + webUrl)
      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'dsh-desktop-smoke.json'), JSON.stringify({ ok: true, url: webUrl, trayIconEmpty: trayIconEmpty }))
      } catch (err) { /* ignore */ }
      isQuitting = true
      app.quit()
    }, 2500)
  }
}

function maybeReveal() {
  if (pageLoaded) revealMain()
}

function showMain() {
  if (!mainWindow) {
    if (webUrl) { createMainWindow(webUrl); revealMain() }
    return
  }
  if (mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) {
    // restore() already brings the window back; an extra show() right after
    // can cause the visible-then-invisible flicker, so only call show when
    // the window is actually hidden (close-to-tray).
    mainWindow.restore()
    mainWindow.focus()
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

// ---------------------------------------------------------------------------
// startup state
// ---------------------------------------------------------------------------

function onServerReady(url) {
  webUrl = url
  log('ready', url)
  stopReadyPoll()
  clearBootingMarker()
  if (dshProc && dshProc.pid) {
    if (backendOnly) {
      const existing = readServerState()
      if (existing && existing.pid !== dshProc.pid && pidAlive(existing.pid)) {
        // Another instance won the race (its backend is already recorded):
        // retire silently so exactly one backend survives.
        log('backend-only: another backend won, retiring')
        killDsh()
        app.exit(0)
        return
      }
      writeServerState(url, dshProc.pid)
      log('backend-only ready', url)
      app.exit(0)
      return
    }
    writeServerState(url, dshProc.pid)
  }
  createMainWindow(url)
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:status', 'ready')
  }
}

function showStartupError(message) {
  log('startup error:', message)
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:error', message)
  }
}

function retryStartup() {
  webUrl = null
  splashExited = false
  pageLoaded = false
  revealed = false
  if (mainWindow) { mainWindow.destroy(); mainWindow = null }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('splash:retry')
  stopServer()
  startDsh()
}

// ---------------------------------------------------------------------------
// balance (DeepSeek API quota)
// ---------------------------------------------------------------------------

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function readApiKeyFromCredentialsYaml() {
  try {
    const text = fs.readFileSync(path.join(dshHomeDir(), '.credentials.yaml'), 'utf8')
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(?:["']([^"']*)["']|([^\s#]+))/m)
    if (m) {
      const v = (m[1] || m[2] || '').trim()
      if (v) return v
    }
  } catch (err) { /* ignore */ }
  return null
}

function readApiKeyFromEnvFile() {
  try {
    const text = fs.readFileSync(path.join(dshHomeDir(), '.env'), 'utf8')
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m)
    if (m) {
      const v = m[1].trim()
      if (v) return v
    }
  } catch (err) { /* ignore */ }
  return null
}

function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.length > 0) return process.env.DEEPSEEK_API_KEY
  return readApiKeyFromCredentialsYaml() || readApiKeyFromEnvFile()
}

function balanceUrl() {
  let base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
  base = base.replace(/\/v\d+(\.\d+)*$/, '')
  return base + '/user/balance'
}

async function fetchBalance() {
  const key = resolveApiKey()
  if (!key) return { ok: false, reason: 'no-key' }
  try {
    const res = await fetch(balanceUrl(), {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return { ok: false, reason: 'http-' + String(res.status) }
    const data = await res.json()
    const info = data && data.balance_infos && data.balance_infos[0]
    if (!info) return { ok: false, reason: 'no-info' }
    return {
      ok: true,
      currency: String(info.currency || 'CNY'),
      total: String(info.total_balance || '0.00'),
      granted: String(info.granted_balance || '0.00'),
      toppedUp: String(info.topped_up_balance || '0.00')
    }
  } catch (err) {
    return { ok: false, reason: 'network' }
  }
}

function balanceLabel(b) {
  if (b && b.ok) {
    const sym = b.currency === 'USD' ? '$' : '¥'
    return '余额 ' + sym + b.total + '（充值 ' + sym + b.toppedUp + ' + 赠送 ' + sym + b.granted + '）'
  }
  if (b && b.reason === 'no-key') return '余额：未配置 API Key'
  return '余额：获取失败'
}

// ---------------------------------------------------------------------------
// tech-styled tray menu (custom popup window)
// ---------------------------------------------------------------------------

function createMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) return
  menuWindow = new BrowserWindow({
    width: 300,
    height: 380,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  menuWindow.loadFile(path.join(__dirname, 'menu.html'))
  menuWindow.on('blur', function () { hideTrayMenu() })
  menuWindow.on('closed', function () { menuWindow = null })
}

function hideTrayMenu() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.hide()
}

function sendMenuData() {
  if (!menuWindow || menuWindow.isDestroyed()) return
  menuWindow.webContents.send('menu:data', Object.assign({}, lastBalanceData, { autostartBackend: autostartBackend }))
}

function showTrayMenu() {
  createMenuWindow()
  if (!menuWindow || menuWindow.isDestroyed()) return
  const cursor = screen.getCursorScreenPoint()
  const bounds = screen.getDisplayNearestPoint(cursor).workArea
  const size = menuWindow.getSize()
  let x = cursor.x - size[0] + 12
  let y = cursor.y - size[1]
  if (x < bounds.x) x = bounds.x + 4
  if (y < bounds.y) y = bounds.y + 4
  if (x + size[0] > bounds.x + bounds.width) x = bounds.x + bounds.width - size[0] - 4
  if (y + size[1] > bounds.y + bounds.height) y = bounds.y + bounds.height - size[1] - 4
  menuWindow.setPosition(Math.round(x), Math.round(y))
  menuWindow.show()
  menuWindow.focus()
  sendMenuData()
}

function balanceMenuData(b) {
  if (b && b.ok) {
    const sym = b.currency === 'USD' ? '$' : '¥'
    return {
      total: sym + ' ' + b.total,
      detail: '充值 ' + sym + b.toppedUp + ' · 赠送 ' + sym + b.granted,
      error: false,
      low: parseFloat(b.total) < lowBalanceThreshold()
    }
  }
  if (b && b.reason === 'no-key') return { total: '未配置', detail: '请在界面中设置 API Key', error: true, low: false }
  return { total: '获取失败', detail: '检查网络后点击刷新', error: true, low: false }
}

let balanceLowNotified = false

function lowBalanceThreshold() {
  const v = parseFloat(process.env.DSH_BALANCE_LOW_THRESHOLD || '5')
  return isNaN(v) ? 5 : v
}

function setTrayIconImage(filename) {
  if (!tray || tray.isDestroyed()) return
  try {
    const img = nativeImage.createFromBuffer(fs.readFileSync(path.join(assetsDir, filename)))
    if (!img.isEmpty()) tray.setImage(img)
  } catch (err) { /* ignore */ }
}

function updateBalanceState(b) {
  const threshold = lowBalanceThreshold()
  const low = !!(b && b.ok && parseFloat(b.total) < threshold)
  setTrayIconImage(low ? 'tray-red.png' : 'tray.png')
  if (low && !balanceLowNotified) {
    balanceLowNotified = true
    if (Notification.isSupported()) {
      const sym = b.currency === 'USD' ? '$' : '¥'
      try {
        new Notification({
          title: PRODUCT_NAME + ' — 余额不足',
          body: '当前余额 ' + sym + b.total + '，已低于 ' + sym + String(threshold) + '，请及时充值。'
        }).show()
      } catch (err) { /* ignore */ }
    }
  } else if (!low) {
    balanceLowNotified = false
  }
}

async function refreshBalance() {
  balanceText = '余额：查询中…'
  lastBalanceData = { total: '查询中…', detail: '', error: false, low: false }
  sendMenuData()
  const b = await fetchBalance()
  balanceText = balanceLabel(b)
  lastBalanceData = balanceMenuData(b)
  sendMenuData()
  if (tray && !tray.isDestroyed()) tray.setToolTip(PRODUCT_NAME + ' — ' + balanceText)
  updateBalanceState(b)
}

function startBalancePolling() {
  refreshBalance()
  if (balanceTimer) clearInterval(balanceTimer)
  balanceTimer = setInterval(function () { refreshBalance() }, 30000)
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

function createTray() {
  let img = nativeImage.createEmpty()
  try {
    const loaded = nativeImage.createFromBuffer(fs.readFileSync(path.join(assetsDir, 'tray.png')))
    if (loaded && !loaded.isEmpty()) img = loaded
  } catch (err) { /* keep empty */ }
  trayIconEmpty = img.isEmpty()

  tray = new Tray(img)
  tray.setToolTip(PRODUCT_NAME)
  tray.setContextMenu(null)
  // Clicking the tray must never hide the window: show (or bring back) it.
  tray.on('click', function () {
    lastTrayClickTime = Date.now()
    showMain()
  })
  tray.on('right-click', function () {
    lastTrayClickTime = Date.now()
    showTrayMenu()
  })
  startBalancePolling()
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

// The silent logon pre-warm (--backend-only) must not grab the single-instance
// lock: a user launching the app during pre-warm would otherwise be swallowed.
const gotLock = backendOnly ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId('com.deepseek.harness')


  app.on('second-instance', function () { showMain() })

  ipcMain.on('splash:exited', function () {
    splashExited = true
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
    maybeReveal()
  })
  ipcMain.on('splash:minimize', function () {
    log('minimize splash to taskbar')
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.minimize()
  })
  ipcMain.on('menu:ready', function () { sendMenuData() })
  ipcMain.on('menu:action', function (_e, action) {
    if (action === 'open') { showMain(); hideTrayMenu() }
    else if (action === 'browser') { if (webUrl) shell.openExternal(webUrl); hideTrayMenu() }
    else if (action === 'refresh') { refreshBalance() }
    else if (action === 'autostart') { applyAutostart(!autostartBackend) }
    else if (action === 'quit') { isQuitting = true; app.quit() }
    else if (action === 'stop') { stopServer(); isQuitting = true; app.quit() }
    else hideTrayMenu()
  })
  ipcMain.on('ui:theme', function (_e, theme) {
    uiTheme = theme === 'dark' ? 'dark' : 'light'
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(uiBackgroundColor())
    }
  })
  ipcMain.on('splash:retry', function () { retryStartup() })
  ipcMain.on('splash:quit', function () { isQuitting = true; app.quit() })

  app.whenReady().then(function () {
    if (backendOnly) {
      // Silent logon pre-warm: boot the backend, record its URL, exit.
      // No tray, no windows, no splash.
      const spec = buildDshSpawn()
      if (spec) spawnDsh(spec)
      else app.exit(0)
      return
    }
    // Keep the "backend at logon" setting in sync (also refreshes the exe
    // path if the install folder moved). Only for the packaged app.
    autostartBackend = readPrefs().autostartBackend !== false
    if (process.platform === 'win32' && app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: autostartBackend, args: ['--backend-only'] })
      } catch (err) { log('autostart apply error', String(err)) }
    }
    createTray()
    createSplashWindow()
    startDsh()
  })

  app.on('before-quit', function () {
    isQuitting = true
    if (balanceTimer) clearInterval(balanceTimer)
    stopReadyPoll()
    if (process.env.DSH_DESKTOP_SMOKE === '1' && process.env.DSH_DESKTOP_SMOKE_KEEP !== '1') {
      // Smoke runs must not leave servers behind.
      stopServer()
    }
    // Otherwise keep the backend running for an instant next launch.
  })

  // Keep running in the tray: closing the window hides it instead of quitting.
  app.on('window-all-closed', function () { /* no-op: tray keeps the app alive */ })

  app.on('activate', function () {
    if (mainWindow) showMain()
    else if (webUrl) { createMainWindow(webUrl); revealMain() }
  })
}
