(function () {
  'use strict'

  var desktop = window.desktop

  // Ask the main process for the latest balance snapshot.
  if (desktop) desktop.menuReady()

  var items = document.querySelectorAll('.menu-item')
  for (var i = 0; i < items.length; i++) {
    (function (el) {
      el.addEventListener('click', function () {
        var action = el.getAttribute('data-action')
        if (desktop && action) desktop.menuAction(action)
      })
    })(items[i])
  }

  var balanceTotal = document.getElementById('balanceTotal')
  var balanceDetail = document.getElementById('balanceDetail')

  if (desktop) {
    desktop.onMenuData(function (data) {
      if (!data) return
      balanceTotal.textContent = data.total || ''
      balanceDetail.textContent = data.detail || ''
      if (data.error) balanceTotal.className = 'balance-total err'
      else if (data.low) balanceTotal.className = 'balance-total low'
      else balanceTotal.className = 'balance-total'
    })
  }
})()
