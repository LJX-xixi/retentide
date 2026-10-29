'use strict';
// Tab bar labels. app.js never rewrites the #tabs buttons, so they are set once here (after i18n.js).
(() => {
  const labels = { home: L('今日', 'Today'), bank: L('词库', 'Words'), ask: L('问', 'Ask'), settings: L('设置', 'Settings') };
  for (const b of document.querySelectorAll('#tabs button')) if (labels[b.dataset.tab]) b.textContent = labels[b.dataset.tab];
})();
