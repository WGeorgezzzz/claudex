// ==UserScript==
// @name         Nexcode wenClaude 用量同步
// @namespace    gaci.local.quota
// @version      1.0.0
// @description  每 30 分钟读取当前 wenClaude 网页的官方额度，仅回传本机 Nexcode。
// @match        https://wenclaude.com/app*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const endpoint = 'http://127.0.0.1:__BRIDGE_PORT__/quota/wenclaude';
  const token = '__BRIDGE_TOKEN__';
  const interval = 30 * 60 * 1000;
  let busy = false;
  let lastAttempt = 0;

  function quotaFromPage() {
    const text = document.body.innerText;
    const start = text.indexOf('官方额度');
    if (start < 0) throw Error('官方额度区域未显示，请打开已登录的仪表盘。');
    const section = text.slice(start).split('最近使用')[0];
    const labels = ['5小时限制', '所有模型', 'Fable'];
    const windows = [];
    for (const label of labels) {
      const begin = section.indexOf(label);
      if (begin < 0) continue;
      const end = Math.min(section.length, ...labels.map(next => section.indexOf(next, begin + label.length)).filter(i => i >= 0));
      const part = section.slice(begin + label.length, end);
      const match = part.match(/已使用\s*([\d.]+)\s*%/);
      const usedPercent = match ? Number(match[1]) : NaN;
      if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
      const reset = part.match(/重置时间\s*([\s\S]*?)已使用/);
      windows.push({ label, usedPercent, resetLabel: reset?.[1].replace(/\s+/g, ' ').trim().slice(0, 100) || null });
    }
    if (!windows.some(row => row.label === '5小时限制')) throw Error('五小时额度未显示。');
    return { sourceUrl: 'https://wenclaude.com/app', checkedAt: new Date().toISOString(), windows };
  }

  async function refreshPageQuota() {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === '刷新额度');
    if (!button || button.disabled) throw Error('额度刷新按钮暂不可用。');
    await new Promise((resolve, reject) => {
      const observer = new MutationObserver(changes => {
        const succeeded = changes.some(change => [...change.addedNodes].some(node => node.textContent?.trim() === '额度已刷新')
          || (change.type === 'characterData' && change.target.textContent?.trim() === '额度已刷新'));
        if (succeeded) { clearTimeout(timer); observer.disconnect(); resolve(); }
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(Error('网页未确认额度刷新成功。')); }, 25000);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      button.click();
    });
  }

  async function sync() {
    if (busy || location.pathname.replace(/\/$/, '') !== '/app') return;
    busy = true; lastAttempt = Date.now();
    try {
      await refreshPageQuota();
      const data = quotaFromPage();
      await new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'POST', url: endpoint,
        headers: { 'Content-Type': 'application/json', 'X-GACI-Quota-Token': token }, data: JSON.stringify(data), timeout: 10000,
        onload: response => response.status === 200 ? resolve() : reject(Error('本机接收端拒绝了数据。')),
        onerror: () => reject(Error('本机用量接收端未运行。')), ontimeout: () => reject(Error('本机用量接收超时。')),
      }));
      console.info('[Nexcode 用量] 网页额度已同步。');
    } catch (error) { console.warn('[Nexcode 用量]', error.message); }
    finally { busy = false; }
  }
  GM_registerMenuCommand('立即同步 wenClaude 额度', sync);
  setTimeout(sync, 3000);
  setInterval(sync, interval);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastAttempt >= interval) void sync(); });
})();
