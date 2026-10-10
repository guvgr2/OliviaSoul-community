/* 游戏端「歌单与收藏」界面（A3）。
 *
 * 注入方式：补丁脚本在 bundle 顶部插入一个 <script src="…/admin/game-favorites.js">，
 * 并把歌曲行的「加播单」按钮接管到 window.OliviaSoulFavorites.openPicker()。
 *
 * 本文件只做三件事：
 *   ①「加入歌单」下拉：接管歌曲行的「加播单」，勾选即写入，取消就什么都不做；
 *   ②「歌单管理」弹层：改名 / 排序 / 移除 / 分享码（二维码 + 文本）/ 删除 / 播放（夹内循环）；
 *   ③ 歌曲行上的「已在 N 个歌单」小标签：靠 data-olivia-song 认行，批量问 membership。
 *
 * 红线：只用游戏自己的 class（tp-el-*）与 --tp-* 设计令牌，不写死颜色、不引第三方库、
 * 不碰播放逻辑 —— 夹内循环＝把歌单曲目交给注入桥 OliviaSoulPlayFolder()，由它在
 * 游戏自己的作用域里「把歌单变成当前列表 + 设成 ot.Repeat + 播放第一首」。
 */
(() => {
  if (window.__oliviaGameFavorites) return;
  window.__oliviaGameFavorites = true;
  const base = new URL(document.currentScript.src).origin;
  const CHIP_CLASS = 'olivia-fav-chip';
  /* 管理弹层一次最多画这么多行：整份排序是程序端的活，游戏端只管日常操作 */
  const ROW_LIMIT = 300;
  /* 分享码超过这个长度就不往输入框里塞（几千首时正文近 10 万字符，塞进去只会卡） */
  const SHARE_INLINE_LIMIT = 4000;
  let stopped = false;
  let folders = [];
  let foldersAt = 0;
  let pickerState = null;
  let managerState = null;
  let chipTimer = null;
  let toastTimer = null;
  const chipSeen = new Map();

  /* ---------- 基础设施 ---------- */

  function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'style') Object.assign(node.style, value);
        else if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children ?? []) if (child != null && child !== false) node.append(child);
    return node;
  }

  /* 16px 线性图标：用 SVG 描边画加号/桌面，比字符 '+' 更居中，也不受字号与字体度量影响 */
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgGlyph(pathData, size = 16) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'block';
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  /* 加号：横竖两笔等长、光学居中（3.1 → 12.9） */
  const PLUS_GLYPH = 'M8 3.1v9.8M3.1 8h9.8';
  /* 桌面：屏幕 + 底座，用在「加入音乐桌面（不建歌单）」那一行 */
  const DESKTOP_GLYPH = 'M2.4 3.6h11.2v6.4H2.4zM6 12.4h4';

  async function api(path, init) {
    const response = await fetch(base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...((init && init.headers) ?? {}) },
    });
    const body = await response.json().catch(() => null);
    if (!body || body.code !== 0) throw new Error((body && body.message) || `请求失败（HTTP ${response.status}）`);
    return body.data;
  }

  function toast(text, ok) {
    let node = document.getElementById('olivia-favorites-toast');
    if (!node) {
      node = h('div', {
        id: 'olivia-favorites-toast',
        style: {
          position: 'fixed', left: '50%', bottom: '112px', transform: 'translateX(-50%)', maxWidth: '70vw',
          padding: '10px 16px', borderRadius: '12px', background: 'rgba(30,30,34,.92)', color: '#f5f1e6',
          font: '500 14px/1.6 system-ui', boxShadow: '0 6px 20px rgba(0,0,0,.35)', zIndex: '2147483000',
          pointerEvents: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-all', transition: 'opacity .25s ease',
        },
      });
      document.body.append(node);
    }
    node.textContent = text;
    node.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.style.opacity = '0'; }, ok ? 8000 : 5000);
  }

  const isLocalSong = song => String((song && song.videoUrl) || '').includes('/toy/midi/songs/');

  function songKey(song) {
    if (!song) return '';
    const url = String(song.videoUrl || '');
    const matched = /\/toy\/midi\/songs\/([^/?#]+)/u.exec(url);
    if (matched) return decodeURIComponent(matched[1]);
    return String(song.itemId ?? song.songId ?? song.id ?? '');
  }

  function closePanels() {
    if (pickerState) { pickerState.panel.remove(); pickerState = null; }
    if (managerState && !managerState.keep) { managerState.overlay.remove(); managerState = null; }
  }

  /* ---------- 歌单数据 ---------- */

  async function folderList(force) {
    if (!force && folders.length && Date.now() - foldersAt < 5000) return folders;
    const data = await api('/toy/folders');
    folders = Array.isArray(data.list) ? data.list : [];
    foldersAt = Date.now();
    return folders;
  }

  async function membershipOf(ids) {
    const wanted = [...new Set((ids || []).filter(Boolean))].slice(0, 500);
    if (!wanted.length) return { members: {}, counts: {} };
    const data = await api(`/toy/folders/membership?ids=${wanted.map(id => encodeURIComponent(id)).join(',')}`);
    return { members: data.members ?? {}, counts: data.counts ?? {} };
  }

  /* ---------- ① 加入歌单下拉 ---------- */

  function rowOf(element) {
    const node = element && element.closest ? element.closest('.song-item') : null;
    return node || (element && element.closest ? element.closest('[data-olivia-song]') : null);
  }

  /* nativeAdd：游戏原生的「加进音乐桌面」回调，由客户端补丁作为第三个参数传进来。
     老补丁（v62 及以前）只传两个参数 → 这里为 null，下拉里就不出现那一行，别的行为不变。 */
  function openPicker(song, event, nativeAdd) {
    if (stopped || !isLocalSong(song)) return false;
    const anchor = rowOf((event && (event.currentTarget || event.target)) || null);
    /* 再点一次同一行的「加播单」＝收回（§2.5① 点一下展开再点收回） */
    if (pickerState && anchor && pickerState.anchor === anchor) {
      closePanels();
      return true;
    }
    closePanels();
    pickerState = {
      song,
      anchor,
      nativeAdd: typeof nativeAdd === 'function' ? nativeAdd : null,
      checked: new Set(),
      known: new Set(),
      busy: false,
      fresh: false,
    };
    renderPicker();
    void hydratePicker();
    if (anchor) {
      chipSeen.set(songKey(song), { el: anchor, count: null });
      void refreshChip(anchor);
    }
    return true;
  }

  async function hydratePicker() {
    const state = pickerState;
    if (!state) return;
    try {
      const list = await folderList(true);
      if (pickerState !== state) return;
      const { members } = await membershipOf([songKey(state.song)]);
      if (pickerState !== state) return;
      const mine = members[songKey(state.song)] ?? [];
      state.checked = new Set(mine);
      state.known = new Set(mine);
      void list;
      renderPicker();
    } catch (error) {
      if (pickerState === state) toast(`歌单读取失败：${error.message}`, false);
    }
  }

  function pickerRow(folder, state) {
    const checked = state.checked.has(folder.id);
    const box = h('span', {
      style: {
        width: '16px', height: '16px', flexShrink: '0', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', borderRadius: '4px', border: `1px solid var(--tp-grey-4)`,
        background: checked ? 'var(--tp-primary-2)' : 'transparent', color: 'var(--tp-grey-2)', fontSize: '12px',
      },
      text: checked ? '✓' : '',
    });
    return h('div', {
      class: 'tp-menu-item',
      style: {
        display: 'flex', alignItems: 'center', gap: '10px', height: '40px', padding: '0 16px', cursor: 'pointer',
        color: 'var(--tp-grey-8)', fontSize: '14px', background: checked ? 'var(--tp-grey-2)' : 'transparent',
      },
      onmouseenter: event => { if (!checked) event.currentTarget.style.background = 'var(--tp-overlay)'; },
      onmouseleave: event => { if (!state.checked.has(folder.id)) event.currentTarget.style.background = 'transparent'; },
      onclick: () => {
        if (state.checked.has(folder.id)) state.checked.delete(folder.id);
        else state.checked.add(folder.id);
        renderPicker();
      },
    }, [
      box,
      h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: folder.name }),
      h('span', { style: { color: 'var(--tp-text-tertiary)', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }, text: `${folder.itemCount ?? 0} 首` }),
    ]);
  }

  function renderPicker() {
    const state = pickerState;
    if (!state) return;
    const previous = state.panel;
    const keyword = (state.keyword ?? '').trim().toLowerCase();
    const visible = folders.filter(folder => !keyword || String(folder.name).toLowerCase().includes(keyword));

    /* 第一行保留游戏原来的「加播单」去处：不想建歌单的人照样能加进右侧「音乐桌面」。 */
    const nativeRow = state.nativeAdd
      ? h('div', {
        class: 'tp-menu-item',
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', height: '40px', padding: '0 16px', cursor: 'pointer',
          color: 'var(--tp-grey-8)', fontSize: '14px', borderBottom: '1px solid var(--tp-grey-3)',
        },
        title: '游戏原本的「加播单」：直接加进右侧的「音乐桌面」，不用先建歌单',
        onmouseenter: event => { event.currentTarget.style.background = 'var(--tp-overlay)'; },
        onmouseleave: event => { event.currentTarget.style.background = 'transparent'; },
        onclick: () => applyNativeAdd(),
      }, [
        h('span', {
          style: { width: '16px', height: '16px', flexShrink: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tp-text-tertiary)' },
        }, [svgGlyph(DESKTOP_GLYPH)]),
        h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: '加入音乐桌面' }),
        h('span', { style: { color: 'var(--tp-text-tertiary)', fontSize: '12px' }, text: '原功能' }),
      ])
      : null;

    const listBox = h('div', {
      class: 'tp-el-scrollbar',
      style: { maxHeight: '240px', overflowY: 'auto', padding: '4px 0' },
    }, [nativeRow, ...(visible.length
      ? visible.map(folder => pickerRow(folder, state))
      : [h('div', { style: { padding: '16px', color: 'var(--tp-text-tertiary)', fontSize: '13px' }, text: state.fresh ? '还没有歌单 —— 在下面新建一个' : '没有匹配的歌单' })])]);

    const createRow = state.creating
      ? h('div', {
        style: { display: 'flex', gap: '8px', padding: '8px 12px', borderTop: '1px solid var(--tp-grey-3)' },
      }, [
        h('input', {
          id: 'olivia-fav-create-input',
          class: 'tp-el-input__inner',
          style: { flex: '1', height: '32px', padding: '0 10px', borderRadius: '6px', border: '1px solid var(--tp-grey-4)', background: 'transparent', color: 'var(--tp-grey-9)', fontSize: '13px' },
          placeholder: '新歌单名字', value: state.newName ?? '', maxlength: '40',
          oninput: event => { state.newName = event.target.value; },
          onkeydown: event => { if (event.key === 'Enter') void createFolder(); },
        }),
        h('button', { class: 'tp-el-button tp-el-button--primary', style: { height: '32px', padding: '0 12px' }, text: '建立', onclick: () => void createFolder() }),
        h('button', { class: 'tp-el-button tp-el-button--default', style: { height: '32px', padding: '0 12px' }, text: '取消', onclick: () => { state.creating = false; renderPicker(); } }),
      ])
      : h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', padding: '0 16px', height: '44px', cursor: 'pointer',
          borderTop: '1px solid var(--tp-grey-3)', color: 'var(--tp-grey-8)', fontSize: '14px', flexShrink: '0',
        },
        onmouseenter: event => { event.currentTarget.style.background = 'var(--tp-overlay)'; },
        onmouseleave: event => { event.currentTarget.style.background = 'transparent'; },
        onclick: () => { state.creating = true; renderPicker(); },
      }, [
        /* 与歌单行的勾选框同宽同起点（16px 盒子 + 10px 间距，父容器 16px 内边距）⇒ 文字与歌单名左右对齐；
           原来那个 26px 圆圈 + 字符 '+' 的中心与文字基线都不齐，整行看着是歪的 */
        h('span', {
          style: { width: '16px', height: '16px', flexShrink: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tp-text-tertiary)' },
        }, [svgGlyph(PLUS_GLYPH)]),
        h('span', { text: '新建歌单…' }),
      ]);

    const panel = h('div', {
      class: 'tp-el-popper',
      style: {
        position: 'fixed', zIndex: '2147483000', width: '320px', minWidth: '260px', padding: '0',
        background: 'var(--tp-grey-1)', borderRadius: '16px', boxShadow: '0 12px 32px rgba(0,0,0,.45)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', color: 'var(--tp-grey-9)', fontSize: '14px',
      },
    }, [
      h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 8px' },
      }, [
        h('span', { style: { fontWeight: '500' }, text: '加入歌单' }),
        h('button', {
          style: { border: '0', background: 'transparent', color: 'var(--tp-primary-2)', cursor: 'pointer', fontSize: '13px', padding: '0' },
          text: '管理歌单 ›',
          onclick: () => { const target = state.checked.size ? [...state.checked][0] : (folders[0] && folders[0].id); closePanels(); void openManager(target); },
        }),
      ]),
      h('div', { style: { padding: '0 12px 8px' } }, [
        h('input', {
          class: 'tp-el-input__inner',
          style: { width: '100%', height: '32px', padding: '0 10px', borderRadius: '6px', border: '1px solid var(--tp-grey-4)', background: 'transparent', color: 'var(--tp-grey-9)', fontSize: '13px', boxSizing: 'border-box' },
          placeholder: '搜索歌单', value: state.keyword ?? '',
          oninput: event => { state.keyword = event.target.value; renderPicker(); },
        }),
      ]),
      listBox,
      createRow,
      h('div', {
        style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '10px 16px', borderTop: '1px solid var(--tp-grey-3)', flexShrink: '0' },
      }, [
        h('button', { class: 'tp-el-button tp-el-button--default', text: '取消', onclick: () => closePanels() }),
        h('button', {
          class: 'tp-el-button tp-el-button--primary',
          text: state.busy ? '加入中…' : '加入',
          onclick: () => void applyPicker(),
        }),
      ]),
    ]);

    document.body.append(panel);
    placePanel(panel, state.anchor);
    if (previous) previous.remove();
    state.panel = panel;
    // 按 id 精确取创建框：搜索框在它自己的容器里也是「唯一的 .tp-el-input__inner」，
    // 用 :last-of-type 会先命中文档序在前的搜索框，于是刚点「新建歌单」时打字会变成过滤歌单。
    if (state.creating) panel.querySelector('#olivia-fav-create-input')?.focus();
  }

  function placePanel(panel, anchor) {
    const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    const width = 320;
    const height = panel.offsetHeight || 320;
    const left = rect ? Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12)) : (window.innerWidth - width) / 2;
    let top = rect ? rect.bottom + 8 : 120;
    if (rect && top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 8);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  async function createFolder() {
    const state = pickerState;
    if (!state || state.busy) return;
    const name = String(state.newName ?? '').trim();
    if (!name) { toast('先写个歌单名字', false); return; }
    state.busy = true;
    renderPicker();
    try {
      const created = await api('/toy/folders', { method: 'POST', body: JSON.stringify({ name }) });
      folders = [];
      await folderList(true);
      state.fresh = true;
      state.creating = false;
      state.newName = '';
      state.checked.add(created.id);
      toast(`已新建《${created.name}》`, true);
    } catch (error) {
      toast(`新建失败：${error.message}`, false);
    } finally {
      state.busy = false;
      renderPicker();
    }
  }

  /* 下拉里的「加入音乐桌面」＝把游戏原生的加播单动作原样执行一遍（没有本地歌单时也有去处）。 */
  function applyNativeAdd() {
    const state = pickerState;
    if (!state || state.busy) return;
    const run = state.nativeAdd;
    closePanels();
    if (typeof run !== 'function') return;
    try {
      run();
      toast('已加入音乐桌面', true);
    } catch (error) {
      toast(`加入音乐桌面失败：${(error && error.message) || error}`, false);
    }
  }

  async function applyPicker() {
    const state = pickerState;
    if (!state || state.busy) return;
    const songId = songKey(state.song);
    const toAdd = [...state.checked].filter(id => !state.known.has(id));
    const toRemove = [...state.known].filter(id => !state.checked.has(id));
    if (!toAdd.length && !toRemove.length) { closePanels(); return; }
    state.busy = true;
    renderPicker();
    try {
      const add = await Promise.all(toAdd.map(id => api(`/toy/folders/${id}/items`, { method: 'POST', body: JSON.stringify({ itemIds: [songId] }) })));
      await Promise.all(toRemove.map(id => api(`/toy/folders/${id}/items`, { method: 'DELETE', body: JSON.stringify({ itemIds: [songId] }) })));
      folders = [];
      const parts = [];
      const added = add.reduce((sum, one) => sum + (one.added ? one.added.length : 0), 0);
      const skipped = add.reduce((sum, one) => sum + (one.skipped ? one.skipped.length : 0), 0);
      if (toAdd.length) parts.push(`已加入 ${toAdd.length} 个歌单${added ? `（新增 ${added} 处）` : ''}`);
      if (skipped) parts.push(`${skipped} 处本来就在里面`);
      if (toRemove.length) parts.push(`已移出 ${toRemove.length} 个歌单`);
      toast(parts.join('，') || '没有变化', true);
      // 结果已落库：把 known 与新状态对齐，重开下拉时按服务端为准
      if (state.anchor) void refreshChip(state.anchor);
      closePanels();
    } catch (error) {
      toast(`加入失败：${error.message}`, false);
      state.busy = false;
      renderPicker();
    }
  }

  /* ---------- ② 歌单管理弹层 ---------- */

  async function openManager(folderId) {
    if (stopped) return;
    let list;
    try {
      list = await folderList(true);
    } catch (error) {
      toast(`歌单读取失败：${error.message}`, false);
      return;
    }
    if (!list.length) { toast('还没有歌单 —— 先在歌曲行上新建一个', false); return; }
    const target = list.find(folder => folder.id === folderId) ?? list[0];
    closePanels();
    managerState = { overlay: null, folderId: target.id, items: [], busy: true, deleting: false, exportData: null };
    renderManager();
    void loadManagerItems();
  }

  async function loadManagerItems() {
    const state = managerState;
    if (!state) return;
    try {
      const data = await api(`/toy/folders/${state.folderId}`);
      if (managerState !== state) return;
      state.items = (data.items ?? []).map(item => ({ ...item, _key: `${item.itemId}:${item.sortOrder}` }));
      state.busy = false;
      renderManager();
    } catch (error) {
      if (managerState === state) toast(`歌单内容读取失败：${error.message}`, false);
    }
  }

  function renderManager() {
    const state = managerState;
    if (!state) return;
    const folder = folders.find(one => one.id === state.folderId);
    const strip = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } },
      folders.map(one => h('button', {
        style: {
          border: '1px solid var(--tp-grey-3)', borderRadius: '6px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
          background: one.id === state.folderId ? 'var(--tp-grey-2)' : 'transparent',
          color: one.id === state.folderId ? 'var(--tp-grey-9)' : 'var(--tp-grey-8)',
        },
        text: `${one.name} · ${one.itemCount ?? 0}`,
        onclick: () => { state.folderId = one.id; state.items = []; state.busy = true; renderManager(); void loadManagerItems(); },
      })));

    const rows = state.items.slice(0, ROW_LIMIT).map((item, index) => h('div', {
      draggable: 'true',
      style: {
        display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px', borderRadius: '6px',
        border: '1px solid var(--tp-grey-3)', marginBottom: '6px', background: 'var(--tp-grey-0)',
      },
      ondragstart: event => { state.dragFrom = index; event.dataTransfer?.setData('text/plain', String(index)); },
      ondragover: event => { event.preventDefault(); },
      ondrop: event => {
        event.preventDefault();
        const from = state.dragFrom ?? Number(event.dataTransfer?.getData('text/plain'));
        if (!Number.isInteger(from) || from === index) return;
        const order = state.items.map(one => one.itemId);
        const [moved] = order.splice(from, 1);
        order.splice(index, 0, moved);
        state.dragFrom = null;
        void applyOrder(order);
      },
    }, [
      h('span', { style: { color: 'var(--tp-grey-6)', cursor: 'grab' }, text: '⠿' }),
      h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' }, text: item.name }),
      item.renamed ? h('span', { style: { color: 'var(--tp-text-tertiary)', fontSize: '12px' }, text: `原名：${item.originalName}` }) : null,
      h('button', { class: 'tp-el-button tp-el-button--default', style: { height: '24px', padding: '0 8px', fontSize: '12px' }, text: '↑', onclick: () => void applyOrder(null, item.itemId, 'up') }),
      h('button', { class: 'tp-el-button tp-el-button--default', style: { height: '24px', padding: '0 8px', fontSize: '12px' }, text: '↓', onclick: () => void applyOrder(null, item.itemId, 'down') }),
      h('button', { class: 'tp-el-button tp-el-button--default', style: { height: '24px', padding: '0 8px', fontSize: '12px' }, text: '移除', onclick: () => void removeItem(item.itemId) }),
    ]));

    const exportBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
      h('div', { style: { fontSize: '13px', color: 'var(--tp-text-secondary)' }, text: '把这个码发给自己人，在程序端「歌单与收藏」里导入' }),
      h('div', {
        style: { width: '180px', height: '180px', background: 'var(--tp-primary-0)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
        id: 'olivia-fav-qr',
      }, [h('span', { style: { color: 'var(--tp-grey-6)', fontSize: '12px' }, text: '生成中…' })]),
      h('textarea', {
        readonly: true,
        value: '',
        placeholder: '超过 30 首不在框里展开 —— 点下面的「复制分享码」拿全文',
        style: {
          width: '100%', height: '76px', resize: 'none', background: 'transparent', color: 'var(--tp-grey-8)', fontSize: '12px',
          border: '1px solid var(--tp-grey-3)', borderRadius: '6px', padding: '6px', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace',
        },
      }),
      h('button', {
        class: 'tp-el-button tp-el-button--default', text: '复制分享码',
        onclick: () => void copyShare(state),
      }),
    ]);

    const overlay = h('div', {
      class: 'tp-el-overlay',
      style: { position: 'fixed', inset: '0', zIndex: '2147482999', background: 'rgba(4,4,6,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      onclick: event => { if (event.target === overlay) closeManager(); },
    }, [
      h('div', {
        class: 'tp-el-dialog',
        style: { width: '760px', maxWidth: '92vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column', background: 'var(--tp-grey-1)', borderRadius: '16px', overflow: 'hidden' },
      }, [
        h('div', { class: 'tp-el-dialog__header', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px' } }, [
          h('span', { class: 'tp-el-dialog__title', style: { color: 'var(--tp-grey-9)', fontSize: '15px' }, text: `歌单管理 · ${folder ? folder.name : ''}` }),
          h('button', { style: { border: '0', background: 'transparent', color: 'var(--tp-grey-6)', cursor: 'pointer', fontSize: '16px' }, text: '✕', onclick: () => closeManager() }),
        ]),
        h('div', { class: 'tp-el-dialog__body', style: { display: 'flex', gap: '16px', padding: '0 18px 12px', overflow: 'auto' } }, [
          h('div', { style: { flex: '1 1 400px', minWidth: '0' } }, [
            strip,
            h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, [
              h('input', {
                class: 'tp-el-input__inner',
                style: { flex: '1', height: '32px', padding: '0 10px', borderRadius: '6px', border: '1px solid var(--tp-grey-4)', background: 'transparent', color: 'var(--tp-grey-9)', fontSize: '13px' },
                value: state.rename ?? (folder ? folder.name : ''),
                oninput: event => { state.rename = event.target.value; },
              }),
              h('button', { class: 'tp-el-button tp-el-button--default', style: { height: '32px' }, text: '保存名称', onclick: () => void renameFolder() }),
            ]),
            h('div', {
              style: { color: 'var(--tp-text-tertiary)', fontSize: '12px', marginBottom: '8px' },
              text: state.busy
                ? '读取中…'
                : (state.items.length > ROW_LIMIT
                  ? `共 ${state.items.length} 首 · 这里只画出前 ${ROW_LIMIT} 首，整份排序请在程序端「歌单与收藏」里做`
                  : `共 ${state.items.length} 首 · 拖动左侧手柄排序`),
            }),
            h('div', { style: { maxHeight: '38vh', overflowY: 'auto' } }, state.busy ? [] : rows),
          ]),
          h('div', { style: { flex: '0 0 260px', borderLeft: '1px solid var(--tp-grey-3)', paddingLeft: '16px' } }, [
            h('div', { style: { color: 'var(--tp-grey-9)', fontSize: '14px', marginBottom: '8px' }, text: '分享码' }),
            exportBox,
            h('button', {
              class: 'tp-el-button tp-el-button--primary',
              style: { marginTop: '10px', width: '100%' },
              text: '播放这个歌单（夹内循环）',
              onclick: () => void playFolder(state.folderId),
            }),
          ]),
        ]),
        h('div', { class: 'tp-el-dialog__footer', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--tp-grey-3)' } }, [
          h('span', { style: { color: 'var(--tp-error)', fontSize: '12px' }, text: '删除歌单不可恢复（曲库文件不受影响）' }),
          h('div', { style: { display: 'flex', gap: '8px' } }, [
            h('button', {
              class: 'tp-el-button tp-el-button--default',
              style: { color: 'var(--tp-error)', borderColor: 'var(--tp-error)' },
              text: state.deleting ? '再点一次确认删除' : '删除歌单',
              onclick: () => void deleteFolder(),
            }),
            h('button', { class: 'tp-el-button tp-el-button--primary', text: '完成', onclick: () => closeManager() }),
          ]),
        ]),
      ]),
    ]);

    const previous = state.overlay;
    document.body.append(overlay);
    state.overlay = overlay;
    if (previous) previous.remove();
    /* 已经算好且还是同一份歌单 → 直接把结果画上；否则先显示「生成中…」再去算 */
    paintExport();
    if (!state.exportData || state.exportData.folderId !== state.folderId) void fillExport();
  }

  /* 把 state.exportData 画到当前弹层上（同一份歌单重画弹层时可重复调用） */
  function paintExport() {
    const state = managerState;
    if (!state || !state.overlay) return;
    const data = state.exportData && state.exportData.folderId === state.folderId ? state.exportData.data : null;
    const box = state.overlay.querySelector('#olivia-fav-qr');
    const textarea = state.overlay.querySelector('textarea');
    if (!box) return;
    if (!data) {
      box.replaceChildren(h('span', { style: { color: 'var(--tp-grey-6)', fontSize: '12px' }, text: '生成中…' }));
      if (textarea) textarea.value = '';
      return;
    }
    box.replaceChildren();
    if (data.qr && Array.isArray(data.qr.rows)) box.append(renderQr(data.qr));
    else box.append(h('span', { style: { color: 'var(--tp-grey-6)', fontSize: '12px', padding: '8px', textAlign: 'center' }, text: `共 ${data.count} 首，超过 30 首无法用二维码 —— 点「复制分享码」拿整份文本，或在程序端「歌单与收藏」里导出 .osfolder 文件` }));
    if (textarea) textarea.value = String(data.text ?? '').length <= SHARE_INLINE_LIMIT ? String(data.text ?? '') : '';
  }

  async function fillExport() {
    const state = managerState;
    if (!state) return;
    const folderId = state.folderId;
    try {
      const data = await api(`/toy/folders/${folderId}/export`);
      if (managerState !== state || state.folderId !== folderId) return;
      state.exportData = { folderId, data };
      paintExport();
    } catch (error) {
      if (managerState === state) toast(`分享码生成失败：${error.message}`, false);
    }
  }

  function renderQr(qr) {
    const quiet = 2;
    const size = qr.size;
    const total = size + quiet * 2;
    let path = '';
    for (let row = 0; row < size; row += 1) {
      const line = qr.rows[row] ?? '';
      for (let column = 0; column < size; column += 1) {
        if (line[column] === '1') path += `M${column + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
    svg.setAttribute('width', '170');
    svg.setAttribute('height', '170');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('width', String(total));
    background.setAttribute('height', String(total));
    background.setAttribute('fill', 'var(--tp-primary-0)');
    const modules = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    modules.setAttribute('d', path);
    modules.setAttribute('fill', 'var(--tp-grey-2)');
    svg.append(background, modules);
    return svg;
  }

  async function copyShare(state) {
    const text = state.exportData && state.exportData.folderId === state.folderId ? String(state.exportData.data.text ?? '') : '';
    if (!text) { toast('还没生成分享码', false); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('分享码已复制', true);
    } catch {
      /* 大歌单的正文没塞进输入框，兜底就只能让用户自己到程序端导出 */
      const textarea = state.overlay && state.overlay.querySelector('textarea');
      if (textarea && textarea.value) { textarea.select(); document.execCommand && document.execCommand('copy'); toast('已选中分享码，按 Ctrl+C 复制', true); return; }
      toast('复制失败：正文太长，请在程序端「歌单与收藏」里导出 .osfolder 文件', false);
    }
  }

  async function renameFolder() {
    const state = managerState;
    if (!state) return;
    const name = String(state.rename ?? '').trim();
    if (!name) { toast('歌单名不能为空', false); return; }
    try {
      const data = await api(`/toy/folders/${state.folderId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      folders = folders.map(one => (one.id === state.folderId ? { ...one, name: data.name } : one));
      state.rename = data.name;
      if (data.name !== name) toast(`同名歌单已存在，改成了《${data.name}》`, true);
      else toast('已改名', true);
      renderManager();
    } catch (error) {
      toast(`改名失败：${error.message}`, false);
    }
  }

  async function applyOrder(order, itemId, direction) {
    const state = managerState;
    if (!state) return;
    try {
      const data = await api(`/toy/folders/${state.folderId}/items/order`, {
        method: 'POST',
        body: JSON.stringify(order ? { itemIds: order } : { itemId, direction }),
      });
      if (managerState !== state) return;
      const byId = new Map(state.items.map(item => [item.itemId, item]));
      state.items = (data.order ?? []).map(id => byId.get(id)).filter(Boolean);
      folders = [];
      renderManager();
    } catch (error) {
      toast(`排序失败：${error.message}`, false);
    }
  }

  async function removeItem(itemId) {
    const state = managerState;
    if (!state) return;
    try {
      await api(`/toy/folders/${state.folderId}/items`, { method: 'DELETE', body: JSON.stringify({ itemIds: [itemId] }) });
      if (managerState !== state) return;
      state.items = state.items.filter(item => item.itemId !== itemId);
      folders = [];
      toast('已移出这个歌单', true);
      renderManager();
    } catch (error) {
      toast(`移除失败：${error.message}`, false);
    }
  }

  async function deleteFolder() {
    const state = managerState;
    if (!state) return;
    if (!state.deleting) {
      state.deleting = true;
      renderManager();
      setTimeout(() => {
        if (managerState === state) { state.deleting = false; renderManager(); }
      }, 4000);
      return;
    }
    try {
      await api(`/toy/folders/${state.folderId}`, { method: 'DELETE' });
      folders = [];
      toast('歌单已删除（曲库文件没有动）', true);
      closeManager();
    } catch (error) {
      toast(`删除失败：${error.message}`, false);
    }
  }

  function closeManager() {
    if (!managerState) return;
    managerState.keep = false;
    const overlay = managerState.overlay;
    managerState = null;
    if (overlay) overlay.remove();
    refreshChipsSoon();
  }

  /* ---------- 夹内循环 ---------- */

  async function playFolder(folderId) {
    if (!folderId) return;
    if (typeof window.OliviaSoulPlayFolder !== 'function') {
      toast('游戏播放桥没有注入 —— 请重新安装客户端补丁', false);
      return;
    }
    try {
      const data = await api(`/toy/folders/${folderId}`, { method: 'GET' });
      const items = (data.items ?? []).filter(isLocalSong);
      if (!items.length) { toast('这个歌单里没有能播的曲目', false); return; }
      const started = window.OliviaSoulPlayFolder(items, 0);
      if (!started) { toast('游戏播放器没有就绪，稍后再试', false); return; }
      toast(`开始夹内循环：《${data.name}》共 ${items.length} 首（第一次点播放才会开始）`, true);
      void refreshChipsSoon();
    } catch (error) {
      toast(`播放失败：${error.message}`, false);
    }
  }

  /* ---------- ③ 歌曲行上的「已在 N 个歌单」 ---------- */

  function chipFor(row) {
    let chip = row.querySelector(`.${CHIP_CLASS}`);
    if (!chip) {
      chip = h('span', {
        class: CHIP_CLASS,
        style: {
          position: 'absolute', right: '12px', top: '10px', padding: '1px 8px', borderRadius: '9999px', fontSize: '11px',
          background: 'var(--tp-primary-4)', color: 'var(--tp-primary-2)', pointerEvents: 'none', zIndex: '2',
        },
      });
      row.append(chip);
    }
    return chip;
  }

  async function refreshChip(row) {
    const songId = row && row.getAttribute ? row.getAttribute('data-olivia-song') : '';
    if (!songId) return;
    try {
      const { members } = await membershipOf([songId]);
      const count = (members[songId] ?? []).length;
      const chip = chipFor(row);
      if (!count) { chip.remove(); return; }
      chip.textContent = `已在 ${count} 个歌单`;
    } catch { /* 取不到就不显示，不影响页面 */ }
  }

  async function refreshChipsSoon() {
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => void refreshAllChips(), 200);
  }

  async function refreshAllChips() {
    if (stopped) return;
    const rows = [...document.querySelectorAll('[data-olivia-song]')];
    const ids = [...new Set(rows.map(row => row.getAttribute('data-olivia-song')).filter(Boolean))];
    if (!ids.length) return;
    let members = {};
    try {
      for (let at = 0; at < ids.length; at += 200) {
        const data = await membershipOf(ids.slice(at, at + 200));
        members = { ...members, ...data.members };
      }
    } catch { return; }
    for (const row of rows) {
      const songId = row.getAttribute('data-olivia-song');
      const count = (members[songId] ?? []).length;
      if (!count) {
        const existing = row.querySelector(`.${CHIP_CLASS}`);
        if (existing) existing.remove();
        continue;
      }
      chipFor(row).textContent = `已在 ${count} 个歌单`;
    }
  }

  const observer = new MutationObserver(() => { void refreshChipsSoon(); });

  /* 点别处 / 按 Esc 收回下拉。用 mousedown（早于 click）：点锚点自身时跳过，交给 openPicker 的开关逻辑 */
  function onOutsideDown(event) {
    if (!pickerState) return;
    const target = event.target;
    if (pickerState.panel && pickerState.panel.contains(target)) return;
    if (pickerState.anchor && pickerState.anchor.contains(target)) return;
    if (managerState && managerState.overlay && managerState.overlay.contains(target)) return;
    closePanels();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') closePanels();
  }

  function start() {
    if (stopped) return;
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-olivia-song'] });
      document.addEventListener('mousedown', onOutsideDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      void refreshAllChips();
    } else {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    }
  }

  function cleanup() {
    stopped = true;
    observer.disconnect();
    document.removeEventListener('mousedown', onOutsideDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    clearTimeout(chipTimer);
    clearTimeout(toastTimer);
    closePanels();
  }

  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
  start();

  window.OliviaSoulFavorites = {
    openPicker,
    openManager,
    playFolder,
    refreshChips: refreshAllChips,
    close: closePanels,
  };
})();
