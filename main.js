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
let webUrl = null
let isQuitting = false
let splashExited = false
let pageLoaded = false
let revealed = false
let trayIconEmpty = true
let balanceText = '余额：查询中…'
let balanceTimer = null
let lastBalanceData = { total: '查询中…', detail: '', error: false, low: false }

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
  if (!proc) return
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill('SIGTERM')
    }
  } catch (err) {
    log('kill error', String(err))
  }
}

function startDsh() {
  const spec = buildDshSpawn()
  if (!spec) {
    showStartupError('未找到 dsh 命令。请先安装 DeepSeek Harness（npx @deepseek-ai/dsh web），或设置 DSH_BIN 环境变量指向 dsh。')
    return
  }
  const env = Object.assign({}, process.env)
  if (spec.asNode) env.ELECTRON_RUN_AS_NODE = '1'
  if (spec.bundled) {
    delete env.NODE_PATH
    delete env.DSH_BIN
  }
  log('spawn', spec.command, spec.args.join(' '))
  let proc
  try {
    proc = spawn(spec.command, spec.args, { env: env, shell: spec.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    showStartupError('无法启动 dsh：' + String(err && err.message ? err.message : err))
    return
  }
  dshProc = proc

  let buffer = ''
  proc.stdout.on('data', function (chunk) {
    buffer += chunk.toString()
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      onDshLine(line)
    }
  })
  proc.stderr.on('data', function (chunk) { process.stderr.write('[dsh] ' + chunk.toString()) })
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

  setTimeout(function () {
    if (!webUrl && !isQuitting) showStartupError('等待 dsh web 就绪超时。')
  }, READY_TIMEOUT_MS)
}

function onDshLine(line) {
  log('dsh', line)
  const m = READY_LINE.exec(line)
  if (m && !webUrl) onServerReady(m[1])
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
  // Auto-minimize to the taskbar whenever the user switches to another app.
  splashWindow.on('blur', function () { splashWindow.minimize() })
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
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send('splash:go')
    } else {
      splashExited = true
    }
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
    const duration = 650
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
  if (splashExited && pageLoaded) revealMain()
}

function showMain() {
  if (!mainWindow) {
    if (webUrl) { createMainWindow(webUrl); revealMain() }
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// ---------------------------------------------------------------------------
// startup state
// ---------------------------------------------------------------------------

function onServerReady(url) {
  webUrl = url
  log('ready', url)
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
  killDsh()
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
    width: 262,
    height: 300,
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
  menuWindow.webContents.send('menu:data', lastBalanceData)
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
  tray.on('click', function () {
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide()
    else showMain()
  })
  tray.on('right-click', function () { showTrayMenu() })
  startBalancePolling()
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
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
    else if (action === 'quit') { isQuitting = true; app.quit() }
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
    createTray()
    createSplashWindow()
    startDsh()
  })

  app.on('before-quit', function () {
    isQuitting = true
    if (balanceTimer) clearInterval(balanceTimer)
    killDsh()
  })

  // Keep running in the tray: closing the window hides it instead of quitting.
  app.on('window-all-closed', function () { /* no-op: tray keeps the app alive */ })

  app.on('activate', function () {
    if (mainWindow) showMain()
    else if (webUrl) { createMainWindow(webUrl); revealMain() }
  })
}
