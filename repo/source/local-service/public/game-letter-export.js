(() => {
  if (window.__oliviaLetterExportButton) return;
  window.__oliviaLetterExportButton = true;
  const base = new URL(document.currentScript.src).origin;
  let stopped = false, busy = false, styledFrom = null, timer, toastTimer;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '一键导出';

  // 只在「我的信箱」信件详情头部（下载 / 分享信件 那一组）里出现，并直接沿用「下载」按钮的样式与图标。
  // 用类选择器先把范围缩到那一组容器：原来是对页面里每个 div 逐个判 classList，界面一大就纯白扫。
  function headerActions() {
    for (const box of document.querySelectorAll('div.flex.items-center.gap-2.flex-shrink-0')) {
      const buttons = box.querySelectorAll('button');
      if (buttons.length < 2) continue;
      if (!/下载|Download/i.test(buttons[0].textContent || '')) continue;
      return { box, download: buttons[0] };
    }
    return null;
  }

  // 每次都以「当前这个下载按钮」为准重新取样式：只准备一次的话，第一个匹配到的容器只要不是信件详情
  // （页面里可能有别的同类按钮组），按钮就会一直顶着错的样式与图标，再也纠正不回来。
  function prepare(download) {
    if (styledFrom === download) return;
    styledFrom = download;
    button.className = download.className;
    button.replaceChildren();
    const icon = download.querySelector('svg');
    if (icon) button.appendChild(icon.cloneNode(true));
    button.appendChild(document.createTextNode('一键导出'));
  }

  function toast(text, ok) {
    let node = document.getElementById('olivia-letter-export-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'olivia-letter-export-toast';
      node.style.cssText = 'position:fixed;left:50%;bottom:112px;transform:translateX(-50%);max-width:70vw;'
        + 'padding:10px 16px;border-radius:12px;background:rgba(30,30,34,.92);color:#f5f1e6;'
        + 'font:500 14px/1.6 system-ui;box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:2147483000;'
        + 'pointer-events:none;white-space:pre-wrap;word-break:break-all;transition:opacity .25s ease';
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.style.opacity = '0'; }, ok ? 8000 : 4000);
  }

  async function run() {
    if (busy || stopped) return;
    busy = true; button.disabled = true; button.style.opacity = '0.6';
    try {
      const response = await fetch(base + '/toy/letter/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'md' })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.code !== 0) throw new Error(result.message || result.error || '导出失败');
      const data = result.data || {};
      toast(`已导出 ${data.count} 封信（共 ${data.repliedCount} 封已回信）\n${data.path}`, true);
    } catch (error) {
      toast(`一键导出失败：${error && error.message ? error.message : error}`, false);
    } finally {
      busy = false; button.disabled = false; button.style.opacity = '';
    }
  }
  button.addEventListener('click', () => { void run(); });

  function tick() {
    if (stopped) return;
    const target = headerActions();
    if (target) {
      prepare(target.download);
      if (button.parentNode !== target.box) target.box.appendChild(button);
    }
    // 挂上去之后就没必要每 1.5 秒再把页面重扫一遍；切到后台时再降一档，别在后台空转。
    timer = setTimeout(tick, document.hidden ? 10000 : target ? 5000 : 1500);
  }

  window.addEventListener('pagehide', () => {
    stopped = true; clearTimeout(timer); clearTimeout(toastTimer);
    button.remove(); document.getElementById('olivia-letter-export-toast')?.remove();
  }, { once: true });

  void tick();
})();
