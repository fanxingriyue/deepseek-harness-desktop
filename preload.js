'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  // splash lifecycle signals
  // 'loading' | 'ready' (server up) | 'go' (page loaded, fade out) | error
  onStatus: function (cb) { ipcRenderer.on('splash:status', function (_e, status) { cb(status) }) },
  onGo: function (cb) { ipcRenderer.on('splash:go', function () { cb() }) },
  onError: function (cb) { ipcRenderer.on('splash:error', function (_e, message) { cb(message) }) },
  onRetry: function (cb) { ipcRenderer.on('splash:retry', function () { cb() }) },
  exited: function () { ipcRenderer.send('splash:exited') },
  retry: function () { ipcRenderer.send('splash:retry') },
  quit: function () { ipcRenderer.send('splash:quit') },

  // embedded minimize button → minimize to the taskbar
  minimize: function () { ipcRenderer.send('splash:minimize') },

  // report the web UI's active theme so the window background matches
  setUiTheme: function (theme) { ipcRenderer.send('ui:theme', theme) },

  // tray menu window
  menuAction: function (id) { ipcRenderer.send('menu:action', id) },
  menuReady: function () { ipcRenderer.send('menu:ready') },
  onMenuData: function (cb) { ipcRenderer.on('menu:data', function (_e, data) { cb(data) }) }
})
