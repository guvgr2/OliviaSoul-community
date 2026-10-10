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

  async function exportOnce(format) {
    const response = await fetch(base + '/toy/letter/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.code !== 0) throw new Error(result.message || result.error || '导出失败');
    return result.data || {};
  }

  function reasonOf(settled) {
    const reason = settled && settled.reason;
    return reason && reason.message ? reason.message : String(reason || '未知原因');
  }

  // 一次点出两份：markdown 给人看 / 直接分享，json 用来在「时间线 → 导入」里把信搬回来。
  // 这里原来只发 format:'md'，而时间线的导入入口写的却是「把一键导出的 json 放回来」——
  // 界面里没有任何 JSON 出口，导入等于走不通（1.1.1 起直到 v63 才修）。
  async function run() {
    if (busy || stopped) return;
    busy = true; button.disabled = true; button.style.opacity = '0.6';
    try {
      const [markdown, json] = await Promise.allSettled([exportOnce('md'), exportOnce('json')]);
      const any = markdown.status === 'fulfilled' ? markdown.value : json.status === 'fulfilled' ? json.value : null;
      if (!any) throw (markdown.reason || json.reason || new Error('导出失败'));
      const lines = [`已导出 ${any.count} 封信（共 ${any.repliedCount} 封已回信）`];
      lines.push(markdown.status === 'fulfilled'
        ? `Markdown（给人看 / 直接分享）：${markdown.value.path}`
        : `Markdown 没导出成功：${reasonOf(markdown)}`);
      lines.push(json.status === 'fulfilled'
        ? `JSON（换电脑后在「时间线 → 导入」里放回来）：${json.value.path}`
        : `JSON 没导出成功：${reasonOf(json)}`);
      toast(lines.join('\n'), true);
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
