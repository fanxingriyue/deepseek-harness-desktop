(function () {
  'use strict'

  var desktop = window.desktop
  var body = document.body
  var content = document.getElementById('content')
  var subtitle = document.getElementById('subtitle')
  var statusEl = document.getElementById('status')
  var errorPanel = document.getElementById('errorPanel')
  var errorMsg = document.getElementById('errorMsg')
  var retryBtn = document.getElementById('retryBtn')
  var quitBtn = document.getElementById('quitBtn')
  var exited = false

  // Ambient star field.
  var stars = document.getElementById('stars')
  for (var i = 0; i < 36; i++) {
    var s = document.createElement('span')
    s.className = 'star'
    s.style.left = (Math.random() * 100).toFixed(2) + '%'
    s.style.top = (Math.random() * 100).toFixed(2) + '%'
    s.style.setProperty('--dur', (2 + Math.random() * 3).toFixed(2) + 's')
    s.style.setProperty('--delay', (Math.random() * 4).toFixed(2) + 's')
    s.style.setProperty('--peak', (0.3 + Math.random() * 0.7).toFixed(2))
    stars.appendChild(s)
  }

  // Rising bubbles (deep-sea ambience).
  var bubbles = document.getElementById('bubbles')
  for (var j = 0; j < 14; j++) {
    var b = document.createElement('span')
    b.className = 'bubble'
    var size = 6 + Math.random() * 22
    b.style.width = size.toFixed(0) + 'px'
    b.style.height = size.toFixed(0) + 'px'
    b.style.left = (Math.random() * 100).toFixed(2) + '%'
    b.style.setProperty('--dur', (5 + Math.random() * 6).toFixed(2) + 's')
    b.style.setProperty('--delay', (Math.random() * 6).toFixed(2) + 's')
    b.style.setProperty('--drift', Math.round((Math.random() - 0.5) * 80) + 'px')
    bubbles.appendChild(b)
  }

  function doExit() {
    if (exited) return
    exited = true
    body.classList.add('exiting')
    setTimeout(function () {
      if (desktop) desktop.exited()
    }, 680)
  }

  if (desktop) {
    desktop.onStatus(function (st) {
      if (st === 'ready') {
        subtitle.textContent = '本地服务已就绪'
        statusEl.textContent = '正在打开 DeepSeek Harness 界面…'
      }
    })
    desktop.onGo(function () {
      subtitle.textContent = '即将进入'
      statusEl.textContent = '正在加载界面…'
      doExit()
    })
    desktop.onError(function (message) {
      content.style.display = 'none'
      errorPanel.hidden = false
      errorMsg.textContent = message
    })
    desktop.onRetry(function () {
      exited = false
      body.classList.remove('exiting')
      errorPanel.hidden = true
      content.style.display = 'flex'
      subtitle.textContent = '正在启动本地服务…'
      statusEl.textContent = '正在连接 DeepSeek Harness…'
    })
  }

  // Dragging is native (-webkit-app-region: drag in splash.css), so this file
  // only needs the embedded minimize button.
  // Embedded minimize button: minimize the splash to the taskbar.
  var minBtn = document.getElementById('minBtn')
  if (minBtn) minBtn.addEventListener('click', function () { if (desktop) desktop.minimize() })

  if (retryBtn) retryBtn.addEventListener('click', function () { if (desktop) desktop.retry() })
  if (quitBtn) quitBtn.addEventListener('click', function () { if (desktop) desktop.quit() })
})()
