// 弹窗只显示版本号，其余是静态说明
try {
  document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;
} catch (e) {
  document.getElementById('ver').textContent = '';
}
