'use strict';
// UI language. Strings are written in place as L('中文', 'English'), so each one keeps both versions side by
// side and a missing translation is visible in review. The word list's own glosses are not translated.
(() => {
  let lang = 'zh';
  try { lang = localStorage.getItem('ovd-lang') || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en'); } catch (e) { /* default */ }
  if (lang !== 'zh' && lang !== 'en') lang = 'en';
  window.LANG = lang;
  window.L = (zh, en) => (lang === 'en' && en != null ? en : zh);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
})();
