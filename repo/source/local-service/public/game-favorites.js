/* 游戏端「歌单与收藏」界面（A3）。
 *
 * 注入方式：补丁脚本在 bundle 顶部插入一个 <script src="…/admin/game-favorites.js">，
 * 并把歌曲行的「加播单」按钮接管到 window.OliviaSoulFavorites.openPicker()。
 *
 * 本文件只做四件事：
 *   ①「加入歌单」下拉：接管歌曲行的「加播单」，勾选即写入，取消就什么都不做；
 *   ②「歌单管理」弹层：一键切播（正在放的那一夹再点即停）/ 改名 / 排序 / 移除 / 删除
 *      （分享码整块自 1.2.1 第二十八轮起从界面上撤下 —— 搬歌单改在程序端
 *      「歌单与收藏 → 导出歌单」，服务端接口未删）；
 *   ③ 歌曲行上的「已在 N 个歌单」小标签：靠 data-olivia-song 认行，批量问 membership；
 *   ④ 游戏「音乐桌面」面板标题行右侧的「歌单」切换键（1.2.1 第三十轮）。
 *
 * 红线：只用游戏自己的 class（tp-el-*）与 --tp-* 设计令牌，不写死颜色、不引第三方库、
 * 不碰播放逻辑 —— 夹内循环＝把歌单曲目交给注入桥 OliviaSoulPlayFolder()，由它在
 * 游戏自己的作用域里「把歌单变成当前列表 + 设成 ot.Repeat + 播放第一首」；
 * 「正在播放」与「停止」同样只读/只调桥（OliviaSoulPlayerState / OliviaSoulStopPlayback），
 * 不直接改游戏状态。
 */
(() => {
  if (window.__oliviaGameFavorites) return;
  window.__oliviaGameFavorites = true;
  const base = new URL(document.currentScript.src).origin;
  const CHIP_CLASS = 'olivia-fav-chip';
  /* 管理弹层一次最多画这么多行：整份排序是程序端的活，游戏端只管日常操作 */
  const ROW_LIMIT = 300;
  let stopped = false;
  let folders = [];
  let foldersAt = 0;
  let pickerState = null;
  let managerState = null;
  /* 「正在播放」不再靠我们自己记账 —— 1.2.1 第三十轮起直接读游戏播放器的真实状态。
     桥 window.OliviaSoulPlayerState()（注入在播放器工厂内，看得见 h/m/x/u/f）返回
     { playing, source, ids, cursor }；与「点播那一刻记下的曲目指纹」比对，一致才算这一夹在放。
     用处：用户在游戏原生界面停止播放、或把当前列表换成别的，面板上的「播放中」会跟着消失，
     不再停留在「点过一次就永远亮着」的陈旧态（用户反馈：要接游戏的原生播放器）。
     放在模块级（而不是 managerState 里）是为了关掉面板再打开时仍认得出哪一夹在放。 */
  let playingFolderId = '';
  /* 点播那一刻的曲目 id 指纹：播放器现在的列表跟它一致，才认这一夹还在放 */
  let playingIdsKey = '';
  /* 面板开着时的巡检定时器：捕获「在原生界面停止 / 切走」这类发生在面板外的变化 */
  let playingTimer = null;
  let chipTimer = null;
  let toastTimer = null;
  const chipSeen = new Map();
  /* 常驻「歌单」入口按钮的 id（见 ensureEntryButton 的说明） */
  const ENTRY_ID = 'olivia-fav-entry';
  /* 「音乐桌面」面板标题行右侧那个切换键（见 mountDeskTab） */
  const DESK_TAB_CLASS = 'olivia-desk-tab';
  const DESK_TITLE = '音乐桌面';

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
  /* 暂停：两条竖线。正在放的那一夹，▶ 换成它 —— 再点一下就是停 */
  const PAUSE_GLYPH = 'M5.8 3.6v8.8M10.2 3.6v8.8';

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

  /* 首次建成歌单的那一刻，把「以后去哪儿切换」直接说给他听。
     比任何时候都管用 —— 这时他刚理解这个功能，也刚发现入口不好找。 */
  const ENTRY_HINT_KEY = 'olivia-fav-entry-hint-v1';
  let entryHinted = false;
  try { entryHinted = window.localStorage.getItem(ENTRY_HINT_KEY) === '1'; } catch { /* 存储被禁用：本次会话仍提示一次 */ }
  function hintEntryOnce() {
    if (entryHinted) return;
    entryHinted = true;
    try { window.localStorage.setItem(ENTRY_HINT_KEY, '1'); } catch { /* 存不下就算了，不影响功能 */ }
    setTimeout(() => {
      toast('以后想切换歌单：点右下角「歌单」按钮，或任意一首歌的「加播单」→ 右上角「管理歌单」', true);
    }, 1200);
  }

  /* 常驻入口。
     为什么不塞进游戏右上工具栏：那是游戏自己的 DOM，类名随版本变，找不到就是静默失效；
     固定在右下角只依赖「页面上有没有歌曲行」，游戏改版也吃不掉它（也才敢写进文档当固定入口）。 */
  /* 1.2.1 第二十八轮：用户反馈「这个歌单不太明显」⇒ 从灰底描边小胶囊改成游戏自己的主色按钮
     （class 用 tp-el-button--primary，颜色全部来自游戏令牌，不写死色值），并带一个 ▶ 图标。 */
  /* 1.2.1 第三十轮：用户仍觉得不明显，要求「在音乐桌面旁边加一个切换键」。⇒ 主入口搬到
     游戏「音乐桌面」面板的标题行右侧（见 mountDeskTab），这个右下角按钮退为兜底：
     只在页面上没有「音乐桌面」面板时才显示，两者不会同时出现。 */
  function ensureEntryButton() {
    if (!document.body || document.getElementById(ENTRY_ID)) return;
    document.body.append(h('button', {
      id: ENTRY_ID,
      type: 'button',
      class: 'tp-el-button tp-el-button--primary',
      title: '打开歌单管理（一键切播 / 新建 / 改名 / 排序）',
      style: {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147482998',
        display: 'none', alignItems: 'center', gap: '6px', height: '40px', padding: '0 18px',
        borderRadius: '20px', cursor: 'pointer', fontSize: '14px', fontWeight: '600',
        boxShadow: '0 8px 24px rgba(0,0,0,.45)', fontFamily: 'inherit',
      },
      onclick: () => { void openManager(); },
    }, [h('span', { text: '▶' }), h('span', { text: '歌单' })]));
  }

  function syncEntryButton() {
    const button = document.getElementById(ENTRY_ID);
    if (!button) return;
    /* 页面上有「音乐桌面」面板时，主入口是面板标题行右侧那个切换键（mountDeskTab），
       右下角这个就不出现 —— 免得同一件事有两个按钮，用户还得想「这两个有什么不一样」。 */
    const hasRows = Boolean(document.querySelector('[data-olivia-song]'));
    const hasDeskTab = Boolean(document.querySelector(`.${DESK_TAB_CLASS}`));
    button.style.display = (hasRows && !hasDeskTab) ? 'inline-flex' : 'none';
  }

  /* 「音乐桌面」旁边的歌单切换键（1.2.1 第三十轮，用户要求）。
   *
   * 为什么挂这儿：游戏音乐面板（组件 SongPlayList）的标题行是
   *   <div class="flex items-center justify-between p-4"><h2 class="…">音乐桌面 <span>N</span></h2></div>
   * —— justify-between 的右侧本来就空着，那个空位就是「音乐桌面旁边」，不用挤任何东西就能放。
   *
   * 认元素只认 h2 的文字前缀（「音乐桌面」是游戏语言包 playlist_my_songs 渲染出来的），
   * 不写游戏内部的组件名/类名 —— 那些随版本变，而文案要变就得连着语言包一起变，改动面小得多。
   * 找不到就什么都不做，右下角那个常驻按钮仍然在（syncEntryButton 的兜底分支）。
   *
   * 注意：游戏是 Vue 渲染的，重新挂载会把我们的按钮冲掉 ⇒ 由既有的 MutationObserver
   * （refreshAllChips → mountDeskTab）反复补挂；这里有 id 判重，重复调用是安全的。 */
  function mountDeskTab() {
    if (stopped || !document.body) return null;
    const heading = [...document.querySelectorAll('h2')]
      .find(node => (node.textContent || '').trim().startsWith(DESK_TITLE));
    if (!heading) return null;
    const row = heading.parentElement;
    if (!row) return null;
    const existing = row.querySelector(`.${DESK_TAB_CLASS}`);
    if (existing) return existing;
    const button = h('button', {
      type: 'button',
      class: DESK_TAB_CLASS,
      title: '打开歌单（一键切播 / 新建 / 改名 / 排序）',
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: '0',
        height: '28px', padding: '0 12px', borderRadius: '9999px', cursor: 'pointer',
        border: '1px solid var(--tp-primary-2)', background: 'transparent',
        color: 'var(--tp-primary-2)', fontSize: '13px', fontWeight: '600', fontFamily: 'inherit',
      },
      onmouseenter: event => { event.currentTarget.style.background = 'var(--tp-primary-4)'; },
      onmouseleave: event => { event.currentTarget.style.background = 'transparent'; },
      onclick: event => { event.stopPropagation(); void openManager(); },
    }, [h('span', { text: '▶' }), h('span', { text: '歌单' })]);
    row.append(button);
    syncEntryButton();
    return button;
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
      hintEntryOnce();
    } catch (error) {
      toast(`新建失败：${error.message}`, false);
    } finally {
      state.busy = false;
      renderPicker();
    }
  }

  /* 管理面板里的「新建」—— 与下拉里的 createFolder 做同一件事，只是数据源是 managerState。
     空歌单时这是面板里唯一能做的事，所以它必须存在。 */
  async function createFolderInManager() {
    const state = managerState;
    if (!state || state.busy) return;
    const name = String(state.newName ?? '').trim();
    if (!name) { toast('先写个歌单名字', false); return; }
    state.busy = true;
    renderManager();
    try {
      const created = await api('/toy/folders', { method: 'POST', body: JSON.stringify({ name }) });
      folders = [];
      await folderList(true);
      state.folderId = created.id;
      state.items = [];
      state.newName = '';
      state.creating = false;
      toast(`已新建《${created.name}》`, true);
      hintEntryOnce();
      renderManager();
      await loadManagerItems();
    } catch (error) {
      toast(`新建失败：${error.message}`, false);
      state.busy = false;
      renderManager();
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
    // 空歌单也必须能进管理面板（1.2.0 真机反馈）：原来这里只弹一句 toast 就把人挡在门外，
    // 而入口恰恰是给「还没有歌单」的人准备的 —— 进去连「新建」都够不着。
    const target = list.find(folder => folder.id === folderId) ?? list[0] ?? null;
    closePanels();
    managerState = {
      overlay: null,
      folderId: target ? target.id : '',
      items: [],
      busy: Boolean(target),
      deleting: false,
      creating: !target,
    };
    renderManager();
    if (target) void loadManagerItems();
    /* 打开面板时先按播放器真实状态校正一次，再挂上巡检（面板开着才需要巡检） */
    syncPlayingState();
    startPlayingWatch();
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
    /* 面板里的「新建歌单」。空歌单时它是这个面板唯一能做的事，所以常驻在最上面
       （1.2.0 真机反馈：入口要能通到「建一个」这一步，而不是只提示去别处建）。 */
    const createRow = state.creating
      ? h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, [
        h('input', {
          class: 'tp-el-input__inner',
          style: { flex: '1', height: '32px', padding: '0 10px', borderRadius: '6px', border: '1px solid var(--tp-grey-4)', background: 'transparent', color: 'var(--tp-grey-9)', fontSize: '13px' },
          placeholder: '新歌单名字',
          value: state.newName ?? '',
          maxlength: '40',
          oninput: event => { state.newName = event.target.value; },
          onkeydown: event => { if (event.key === 'Enter') void createFolderInManager(); },
        }),
        h('button', { class: 'tp-el-button tp-el-button--primary', style: { height: '32px' }, text: '建立', onclick: () => void createFolderInManager() }),
        h('button', { class: 'tp-el-button tp-el-button--default', style: { height: '32px' }, text: '取消', onclick: () => { state.creating = false; state.newName = ''; renderManager(); } }),
      ])
      : h('div', {
        style: { display: 'inline-flex', alignItems: 'center', marginBottom: '10px', color: 'var(--tp-primary-2)', fontSize: '13px', cursor: 'pointer' },
        text: '＋ 新建歌单…',
        onclick: () => { state.creating = true; renderManager(); },
      });
    const emptyHint = folders.length
      ? null
      : h('div', {
        style: { color: 'var(--tp-text-secondary)', fontSize: '13px', lineHeight: '1.8', marginBottom: '10px' },
        text: '还没有歌单。点上面的「＋ 新建歌单…」建一个，再在任意一首歌上点「加播单」就能把歌加进来。',
      });
    /* 一句话说清这片小圆点怎么用（用户反馈「不明显」：光有图标不说，第一次看不懂） */
    const stripHint = folders.length
      ? h('div', { style: { color: 'var(--tp-text-tertiary)', fontSize: '12px', marginBottom: '6px' }, text: '点歌单左边的小 ▶ 直接换着听（正在放的那一夹再点一下就是停）；点歌单名看里面的曲目' })
      : null;

    /* 每个歌单一个「片」：左边 ▶ 是一键切播（切到这一夹并立刻开始循环），右边名字是选中看成员。
       1.2.1 第二十八轮（用户反馈「切换歌单播放还要手动点歌单才能切换」）：
       ▶ 单独成一个热区，一次点击就换掉正在放的那一夹，不必先选中再点播放；
       正在放的那一夹整片高亮并挂「播放中」。 */
    const strip = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } },
      folders.map(one => {
        const active = one.id === state.folderId;
        const playing = playingFolderId === one.id;
        return h('div', {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '2px',
            border: `1px solid ${active ? 'var(--tp-primary-2)' : 'var(--tp-grey-3)'}`,
            borderRadius: '9999px', padding: '3px 10px 3px 4px',
            background: active ? 'var(--tp-primary-4)' : 'transparent',
            color: active ? 'var(--tp-grey-9)' : 'var(--tp-grey-8)', fontSize: '13px',
          },
        }, [
          h('span', {
            'data-olivia-play': '1',
            title: playing ? '再点一下停止播放' : '切到这个歌单并开始播（夹内循环）',
            style: {
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px',
              borderRadius: '9999px', cursor: 'pointer', fontSize: '11px', lineHeight: '1',
              color: playing ? 'var(--tp-primary-2)' : 'var(--tp-grey-6)',
              background: playing ? 'var(--tp-primary-4)' : 'var(--tp-grey-2)',
            },
            onclick: event => { event.stopPropagation(); void playFolder(one.id); },
          }, playing ? [svgGlyph(PAUSE_GLYPH, 10)] : [h('span', { text: '▶' })]),
          h('span', {
            style: { cursor: 'pointer' },
            text: `${one.name} · ${one.itemCount ?? 0}`,
            onclick: () => { state.folderId = one.id; state.items = []; state.busy = true; renderManager(); void loadManagerItems(); },
          }),
          playing ? h('span', { style: { marginLeft: '2px', fontSize: '11px', color: 'var(--tp-primary-2)' }, text: '播放中' }) : null,
        ]);
      }));

    /* 播放这一夹：从原先的右侧窄列（260px、字号小）提到歌单条下面的整行主按钮 ——
       用户反馈「切着听」这件事在面板里找不到落点。正在放的那一夹文案会跟着变，
       并且再点一次就是停（1.2.1 第三十轮，与 ▶ 热区同一套行为）。 */
    const rowPlaying = Boolean(folder) && playingFolderId === folder.id;
    const playRow = folder ? h('button', {
      class: 'tp-el-button tp-el-button--primary',
      style: { width: '100%', height: '36px', marginBottom: '10px' },
      text: rowPlaying
        ? `■ 停止《${folder.name}》 · 正在播放`
        : `▶ 播放《${folder.name}》（夹内循环）`,
      onclick: () => void playFolder(state.folderId),
    }) : null;

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

    const overlay = h('div', {
      class: 'tp-el-overlay',
      style: { position: 'fixed', inset: '0', zIndex: '2147482999', background: 'rgba(4,4,6,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      onclick: event => { if (event.target === overlay) closeManager(); },
    }, [
      h('div', {
        class: 'tp-el-dialog',
        style: { width: '560px', maxWidth: '92vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column', background: 'var(--tp-grey-1)', borderRadius: '16px', overflow: 'hidden' },
      }, [
        h('div', { class: 'tp-el-dialog__header', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px' } }, [
          h('span', { class: 'tp-el-dialog__title', style: { color: 'var(--tp-grey-9)', fontSize: '15px' }, text: folder ? `歌单管理 · ${folder.name}` : '歌单管理（还没有歌单）' }),
          h('button', { style: { border: '0', background: 'transparent', color: 'var(--tp-grey-6)', cursor: 'pointer', fontSize: '16px' }, text: '✕', onclick: () => closeManager() }),
        ]),
        h('div', { class: 'tp-el-dialog__body', style: { display: 'flex', gap: '16px', padding: '0 18px 12px', overflow: 'auto' } }, [
          h('div', { style: { flex: '1 1 400px', minWidth: '0' } }, [
            stripHint,
            strip,
            playRow,
            createRow,
            emptyHint,
            folder ? h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, [
              h('input', {
                class: 'tp-el-input__inner',
                style: { flex: '1', height: '32px', padding: '0 10px', borderRadius: '6px', border: '1px solid var(--tp-grey-4)', background: 'transparent', color: 'var(--tp-grey-9)', fontSize: '13px' },
                value: state.rename ?? folder.name,
                oninput: event => { state.rename = event.target.value; },
              }),
              h('button', { class: 'tp-el-button tp-el-button--default', style: { height: '32px' }, text: '保存名称', onclick: () => void renameFolder() }),
            ]) : null,
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
        ]),
        h('div', { class: 'tp-el-dialog__footer', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--tp-grey-3)' } }, [
          folder
            ? h('span', { style: { color: 'var(--tp-error)', fontSize: '12px' }, text: '删除歌单不可恢复（曲库文件不受影响）' })
            : h('span', { style: { color: 'var(--tp-text-tertiary)', fontSize: '12px' }, text: '这里只改歌单归属，曲库文件不受影响' }),
          h('div', { style: { display: 'flex', gap: '8px' } }, [
            folder ? h('button', {
              class: 'tp-el-button tp-el-button--default',
              style: { color: 'var(--tp-error)', borderColor: 'var(--tp-error)' },
              text: state.deleting ? '再点一次确认删除' : '删除歌单',
              onclick: () => void deleteFolder(),
            }) : null,
            h('button', { class: 'tp-el-button tp-el-button--primary', text: '完成', onclick: () => closeManager() }),
          ]),
        ]),
      ]),
    ]);

    const previous = state.overlay;
    document.body.append(overlay);
    state.overlay = overlay;
    if (previous) previous.remove();
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
    stopPlayingWatch();
    refreshChipsSoon();
  }

  /* ---------- 夹内循环 ---------- */

  /* 「正在播放」的判定：读游戏播放器的真实状态，而不是我们自己记的账。
     桥是 1.2.1 第三十轮新加的（注入在播放器工厂内，能看见 h/m/x/u/f）：
       window.OliviaSoulPlayerState() → { playing, source, ids, cursor } | null
     老补丁没有这个桥 ⇒ 返回 null 时一律「什么都不改」，退回「点过就一直亮」的旧行为，不会更坏。 */
  function playerState() {
    if (typeof window.OliviaSoulPlayerState !== 'function') return null;
    try { return window.OliviaSoulPlayerState(); } catch { return null; }
  }

  const idsKeyOf = list => (list || []).map(one => String(one)).join('\u0001');

  /* 巡检一次：播放器停了、或者当前列表已经换成别的（指纹对不上），就把「播放中」摘掉。
     只有真的变了才重画 —— 否则每 2 秒把面板推倒重来一次，正拖着排序的人会被打断。 */
  function syncPlayingState() {
    if (!playingFolderId) return;
    const state = playerState();
    if (!state) return;                        // 老补丁：保持现状
    if (state.playing && idsKeyOf(state.ids) === playingIdsKey) return;
    playingFolderId = '';
    playingIdsKey = '';
    if (managerState) renderManager();
  }

  function startPlayingWatch() {
    stopPlayingWatch();
    playingTimer = setInterval(syncPlayingState, 2000);
  }

  function stopPlayingWatch() {
    clearInterval(playingTimer);
    playingTimer = null;
  }

  /* 夹内循环。也可以从面板里每个歌单片上的 ▶ 直接调用 —— 那就是「一键切播」：
     不必先选中那一夹再点播放，点了就换掉正在放的那一份。
     1.2.1 第三十轮（用户要求「再点即停」）：同一夹再点一次 = 停。判断依据同样是播放器的
     真实状态（playingFolderId 由 syncPlayingState 守着），不是「上次点了谁」。 */
  async function playFolder(folderId) {
    if (!folderId) return;
    if (typeof window.OliviaSoulPlayFolder !== 'function') {
      toast('游戏播放桥没有注入 —— 请重新安装客户端补丁', false);
      return;
    }
    /* 已经在放这一夹 ⇒ 再点就是停 */
    if (playingFolderId === folderId) {
      const stopped = typeof window.OliviaSoulStopPlayback === 'function' ? window.OliviaSoulStopPlayback() : false;
      if (stopped) {
        playingFolderId = '';
        playingIdsKey = '';
        if (managerState) renderManager();
        toast('已停止播放', true);
        return;
      }
      /* 停不了（老补丁）就照常往下走，重播一遍，不留死路 */
    }
    try {
      const data = await api(`/toy/folders/${folderId}`, { method: 'GET' });
      const items = (data.items ?? []).filter(isLocalSong);
      if (!items.length) { toast('这个歌单里没有能播的曲目', false); return; }
      const started = window.OliviaSoulPlayFolder(items, 0);
      if (!started) { toast('游戏播放器没有就绪，稍后再试', false); return; }
      playingFolderId = folderId;
      playingIdsKey = idsKeyOf(items.map(songKey));
      if (managerState) renderManager();
      toast(`开始夹内循环：《${data.name}》共 ${items.length} 首`, true);
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
    /* 常驻入口的显隐跟着「页面上有没有歌曲行 / 有没有音乐桌面面板」走，
       必须在 !ids.length 提前 return 之前同步 —— 音乐桌面面板里可能一首本地歌都没有。 */
    syncEntryButton();
    mountDeskTab();
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
      ensureEntryButton();
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
    stopPlayingWatch();
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
