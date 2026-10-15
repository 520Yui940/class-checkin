// 《隐私说明》页的少量运行时填充：数据管理者称呼 + 当前应用版本
(function () {
  var op = (window.APP_CONFIG && window.APP_CONFIG.operator) || '本班班长';
  var nodes = document.querySelectorAll('[data-cfg="operator"]');
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = op;
  fetch('api/ping').then(function (r) { return r.json(); }).then(function (d) {
    var el = document.getElementById('pv-ver');
    if (el && d && d.version) el.textContent = 'v' + d.version;
  }).catch(function () {});
})();
