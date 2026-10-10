// 游戏端「信件时间线」：在信箱信件详情头部（下载 / 分享信件 / 一键导出 那一组）追加一枚「时间线」按钮，
// 点开在游戏内展开覆盖层，读本地服务的只读接口 /toy/mail/timeline（游标分页 + 服务端筛选）。
// 不跳浏览器 → externalLinkAllowed() 的白名单完全不用碰。
(() => {
  if (window.__oliviaLetterTimeline) return;
  window.__oliviaLetterTimeline = true;
  const base = new URL(document.currentScript.src).origin;

  const PAGE_SIZE = 20;
  const STATE_ORDER = ['', 'replied', 'pending', 'failed'];
  const STATE_LABEL = { '': '全部', replied: '已回信', pending: '待回信', failed: '失败' };
  const STATE_COLOR = { replied: 'var(--tp-primary-2)', pending: 'var(--tp-grey-5)', failed: 'var(--tp-error)' };
  const ARCHIVE_ORDER = ['all', 'unarchived', 'archived'];
  const ARCHIVE_LABEL = { all: '全部', unarchived: '未归档', archived: '已归档' };
  const FONT = 'system-ui, "Microsoft YaHei", sans-serif';

  let button = null;
  let overlay = null;
  let state = null;
  let importLayer = null;
  let tickTimer = null;
  let toastTimer = null;
  let searchTimer = null;
  let stopped = false;

  function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, String(value));
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false || child === '') continue;
      node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function api(path) {
    const response = await fetch(base + path, { headers: { Accept: 'application/json' } });
    const result = await response.json().catch(() => ({}));
    if (result.code !== 0) throw new Error(result.message || result.error || '请求失败');
    return result.data || {};
  }

  // 导入走 POST（preview → confirm 两步），与既有 import/preview + import/confirm 写法一致。
  async function post(path, body) {
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const result = await response.json().catch(() => ({}));
    if (result.code !== 0) throw new Error(result.message || result.error || '请求失败');
    return result.data || {};
  }

  function toast(text, ok) {
    let node = document.getElementById('olivia-letter-timeline-toast');
    if (!node) {
      node = h('div', {
        id: 'olivia-letter-timeline-toast',
        style: {
          position: 'fixed', left: '50%', bottom: '112px', transform: 'translateX(-50%)', maxWidth: '70vw',
          padding: '10px 16px', borderRadius: '12px', background: 'rgba(30,30,34,.92)', color: '#f5f1e6',
          font: `500 14px/1.6 ${FONT}`, boxShadow: '0 6px 20px rgba(0,0,0,.35)', zIndex: '2147483000',
          pointerEvents: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-all', transition: 'opacity .25s ease',
        },
      });
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.style.opacity = '0'; }, ok ? 6000 : 4000);
  }

  // ---- 入口按钮：照 game-letter-export.js 的既有做法，把范围缩到「下载 / 分享信件」那一组 ----
  function headerActions() {
    for (const box of document.querySelectorAll('div.flex.items-center.gap-2.flex-shrink-0')) {
      const buttons = box.querySelectorAll('button');
      if (buttons.length < 2) continue;
      if (!/下载|Download/i.test(buttons[0].textContent || '')) continue;
      return { box, download: buttons[0] };
    }
    return null;
  }

  let styledFrom = null;
  function prepare(download) {
    if (styledFrom === download) return;
    styledFrom = download;
    button.className = download.className;
    button.replaceChildren();
    const icon = download.querySelector('svg');
    if (icon) button.appendChild(icon.cloneNode(true));
    button.appendChild(document.createTextNode('时间线'));
  }

  function mountButton() {
    const target = headerActions();
    if (!target) return false;
    prepare(target.download);
    if (button.parentNode !== target.box) {
      // 紧跟「一键导出」后面；那个按钮也是注入的，还没挂上时就先接到组尾。
      const exporter = Array.from(target.box.querySelectorAll('button'))
        .find(node => /一键导出/.test(node.textContent || ''));
      if (exporter && exporter.nextSibling) target.box.insertBefore(button, exporter.nextSibling);
      else target.box.appendChild(button);
    }
    return true;
  }

  // ---- 时间线视图 ----
  function segment(options, current, onPick) {
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--tp-grey-0)', borderRadius: '8px', padding: '2px' } },
      options.map(value => h('button', {
        type: 'button',
        text: options === ARCHIVE_ORDER ? ARCHIVE_LABEL[value] : STATE_LABEL[value],
        style: {
          border: '0', cursor: 'pointer', height: '24px', padding: '0 10px', borderRadius: '6px', font: `500 12px ${FONT}`,
          background: value === current ? 'var(--tp-grey-2)' : 'transparent',
          color: value === current ? 'var(--tp-grey-9)' : 'var(--tp-text-secondary)',
        },
        onclick: () => onPick(value),
      })),
    );
  }

  function stateLabel(item) {
    const label = STATE_LABEL[item.timelineState] || '待回信';
    const extra = item.timelineState === 'replied' ? (item.replyLabel || '回信') : '';
    return extra && extra !== label ? `${label} · ${extra}` : label;
  }

  function formatStamp(item) {
    const date = item.letterDate || '';
    const time = item.letterTime || '';
    return [date, time].filter(Boolean).join(' ');
  }

  function detail(item) {
    const blocks = [];
    blocks.push(h('div', {
      text: item.content || '（这封信没有正文）',
      style: { font: `400 14px/1.9 ${FONT}`, color: 'var(--tp-text-body)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    }));
    if (item.replyText) {
      blocks.push(h('div', { style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--tp-grey-3)' } }, [
        h('div', { text: item.replyLabel || '回信', style: { font: `600 13px ${FONT}`, color: 'var(--tp-primary-2)', paddingBottom: '6px' } }),
        h('div', {
          text: item.replyText,
          style: { font: `400 14px/1.9 ${FONT}`, color: 'var(--tp-text-body)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
        }),
      ]));
    } else if (item.timelineState === 'pending') {
      blocks.push(h('div', {
        text: '还没收到回信 —— 到时间了这里会出现。',
        style: { marginTop: '10px', font: `400 13px ${FONT}`, color: 'var(--tp-text-secondary)' },
      }));
    }
    if (item.replyVideoUrl) {
      blocks.push(h('video', {
        src: item.replyVideoUrl, controls: 'controls', preload: 'metadata',
        style: { marginTop: '12px', width: '100%', maxHeight: '260px', borderRadius: '12px', background: '#000' },
      }));
    }
    return h('div', { style: { paddingTop: '10px' } }, blocks);
  }

  function row(item, isLast) {
    const expanded = state.expanded.has(item.letterId);
    const rail = h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: '14px', flexShrink: '0' } }, [
      h('span', {
        style: {
          width: '10px', height: '10px', borderRadius: '999px', marginTop: '12px', flexShrink: '0',
          background: STATE_COLOR[item.timelineState] || 'var(--tp-grey-5)',
        },
      }),
      isLast ? null : h('span', { style: { width: '1px', flex: '1', background: 'var(--tp-grey-3)', marginTop: '4px' } }),
    ]);
    const card = h('div', {
      style: {
        flex: '1', minWidth: '0', margin: '4px 0', padding: '10px 14px', borderRadius: '12px',
        background: 'var(--tp-grey-2)', cursor: 'pointer',
      },
      onmouseenter: event => { event.currentTarget.style.background = 'var(--tp-grey-3)'; },
      onmouseleave: event => { event.currentTarget.style.background = 'var(--tp-grey-2)'; },
      onclick: () => {
        if (expanded) state.expanded.delete(item.letterId);
        else state.expanded.add(item.letterId);
        renderList();
      },
    }, [
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } }, [
        h('div', {
          text: item.summary || '（无标题）',
          style: { flex: '1', minWidth: '0', font: `500 15px ${FONT}`, color: 'var(--tp-text-title)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }),
        h('span', { text: stateLabel(item), style: { font: `500 12px ${FONT}`, color: STATE_COLOR[item.timelineState] || 'var(--tp-text-secondary)', flexShrink: '0' } }),
      ]),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '4px' } }, [
        h('span', { text: formatStamp(item), style: { font: `400 12px ${FONT}`, color: 'var(--tp-text-secondary)' } }),
        item.person ? h('span', { text: item.person, style: { font: `400 12px ${FONT}`, color: 'var(--tp-text-tertiary)' } }) : null,
        item.archived ? h('span', {
          text: '已归档',
          style: { font: `400 11px ${FONT}`, color: 'var(--tp-text-tertiary)', border: '1px solid var(--tp-grey-4)', borderRadius: '999px', padding: '1px 8px' },
        }) : null,
        h('span', {
          text: expanded ? '收起' : '展开',
          style: { marginLeft: 'auto', font: `400 12px ${FONT}`, color: 'var(--tp-text-tertiary)' },
        }),
      ]),
      expanded ? detail(item) : null,
    ]);
    return h('div', { style: { display: 'flex', gap: '14px' } }, [rail, card]);
  }

  function renderList() {
    const host = overlay.querySelector('#olivia-timeline-list');
    if (!host) return;
    host.replaceChildren();
    if (state.loading && !state.list.length) {
      host.appendChild(h('div', { text: '读取中…', style: { padding: '24px 0', textAlign: 'center', font: `400 14px ${FONT}`, color: 'var(--tp-text-secondary)' } }));
      return;
    }
    if (state.error) {
      host.appendChild(h('div', { text: `读不到时间线：${state.error}`, style: { padding: '24px 0', textAlign: 'center', font: `400 14px ${FONT}`, color: 'var(--tp-error)' } }));
      return;
    }
    if (!state.list.length) {
      const empty = state.q || state.person || state.status
        ? '没有符合条件的信件 —— 换一组筛选条件试试。'
        : state.archived === 'archived'
          ? '还没有已归档的信件。信件被整理进记忆之后会出现在这里。'
          : state.archived === 'unarchived'
            ? '还没有未归档的信件 —— 已经整理进记忆的信在「已归档」里。'
            : '还没有信件。写给林离的第一封信会出现在这里。';
      host.appendChild(h('div', {
        text: empty,
        style: { padding: '28px 0', textAlign: 'center', font: `400 14px/1.9 ${FONT}`, color: 'var(--tp-text-secondary)' },
      }));
      return;
    }
    let lastDate = '';
    const nodes = [];
    state.list.forEach((item, index) => {
      const date = item.letterDate || '';
      if (date && date !== lastDate) {
        lastDate = date;
        nodes.push(h('div', {
          text: date,
          style: { font: `600 13px ${FONT}`, color: 'var(--tp-text-secondary)', padding: '14px 0 4px 28px' },
        }));
      }
      nodes.push(row(item, index === state.list.length - 1));
    });
    host.replaceChildren(...nodes);
  }

  // 单独渲染页脚：renderList 在「读取中 / 出错 / 空列表」时会提前 return，
  // 页脚若跟着一起 return 就会留在上一次筛选的文案上（真机实测踩到：「未归档 0 封」却写着「共 13 封」）。
  function renderFoot() {
    const foot = overlay.querySelector('#olivia-timeline-foot');
    if (!foot) return;
    foot.replaceChildren();
    if (state.error || (state.loading && !state.list.length)) return;
    foot.appendChild(state.hasMore
      ? h('button', {
        type: 'button', text: state.loading ? '读取中…' : '加载更早',
        style: {
          border: '1px solid var(--tp-grey-3)', cursor: 'pointer', height: '32px', padding: '0 18px', borderRadius: '999px',
          background: 'transparent', color: 'var(--tp-grey-9)', font: `500 13px ${FONT}`, opacity: state.loading ? '.6' : '1',
        },
        onclick: () => { if (!state.loading) void load(true); },
      })
      : h('span', {
        text: `没有更早的信了 · 这份视图共 ${state.total} 封`,
        style: { font: `400 12px ${FONT}`, color: 'var(--tp-text-tertiary)' },
      }));
  }

  function renderSummary() {
    const host = overlay.querySelector('#olivia-timeline-summary');
    if (!host) return;
    const stats = state.stats || {};
    const parts = [`这份视图 ${state.total} 封`];
    if (stats.total !== undefined) parts.push(`全部 ${stats.total} 封`);
    if (stats.replied !== undefined) parts.push(`已回信 ${stats.replied}`);
    if (stats.pending !== undefined) parts.push(`待回信 ${stats.pending}`);
    if (stats.failed) parts.push(`失败 ${stats.failed}`);
    host.textContent = parts.join(' · ');
  }

  // 分段控件每次重画：默认「全部」被选中时样式是烘进 style 的，
  // 点击后若不重画，高亮会一直留在旧的那一项上（真机实测踩到）。
  function paintSegments() {
    const archiveHost = overlay.querySelector('#olivia-timeline-archive-seg');
    if (archiveHost) {
      archiveHost.replaceChildren(segment(ARCHIVE_ORDER, state.archived, value => { state.archived = value; void load(false); }));
    }
    const stateHost = overlay.querySelector('#olivia-timeline-state-seg');
    if (stateHost) {
      stateHost.replaceChildren(segment(STATE_ORDER, state.status, value => { state.status = value; void load(false); }));
    }
  }

  function render() {
    paintSegments();
    paintPersons();
    renderSummary();
    renderList();
    renderFoot();
  }

  function query(before) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (state.archived) params.set('archived', state.archived);
    if (state.status) params.set('status', state.status);
    if (state.person) params.set('person', state.person);
    if (state.q) params.set('q', state.q);
    if (before) params.set('before', before);
    return params.toString();
  }

  async function load(more) {
    if (state.loading) return;
    state.loading = true;
    render();
    try {
      const before = more && state.list.length ? state.list[state.list.length - 1].cursor : '';
      const data = await api(`/toy/mail/timeline?${query(before)}`);
      const list = Array.isArray(data.list) ? data.list : [];
      state.list = more ? state.list.concat(list) : list;
      state.hasMore = Boolean(data.hasMore);
      state.total = Number(data.total) || 0;
      state.stats = data.stats || null;
      state.persons = Array.isArray(data.persons) ? data.persons : [];
      state.error = '';
      if (!more) state.expanded = new Set();
    } catch (error) {
      state.error = (error && error.message) || String(error);
      if (!more) { state.list = []; state.hasMore = false; state.total = 0; }
    } finally {
      state.loading = false;
      render();
    }
  }

  function build() {
    state = { archived: 'all', status: '', person: '', q: '', list: [], hasMore: false, total: 0, stats: null, persons: [], loading: false, error: '', expanded: new Set(), importText: '', importPreviewId: '', importBusy: false };
    const personSelect = h('select', {
      style: {
        height: '28px', borderRadius: '6px', border: '0', padding: '0 8px', font: `400 12px ${FONT}`,
        background: 'var(--tp-grey-0)', color: 'var(--tp-grey-9)',
      },
      onchange: event => { state.person = event.target.value; void load(false); },
    }, [h('option', { value: '', text: '所有人' })]);
    const search = h('input', {
      class: 'tp-el-input__inner', placeholder: '搜索信件内容', type: 'search',
      style: {
        height: '28px', width: '180px', border: '0', borderRadius: '6px', padding: '0 10px',
        background: 'var(--tp-grey-0)', color: 'var(--tp-grey-9)', font: `400 12px ${FONT}`, outline: 'none',
      },
      oninput: event => {
        const value = event.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { state.q = String(value || '').trim(); void load(false); }, 300);
      },
    });

    importLayer = buildImportLayer();

    const dialog = h('div', {
      class: 'tp-el-dialog',
      style: {
        width: '880px', maxWidth: '94vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column', position: 'relative',
        background: 'var(--tp-grey-1)', borderRadius: '16px', overflow: 'hidden',
      },
    }, [
      h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px 12px', borderBottom: '1px solid var(--tp-grey-3)' },
      }, [
        h('span', { text: '信件时间线', style: { font: `600 18px ${FONT}`, color: 'var(--tp-text-title)' } }),
        h('span', { id: 'olivia-timeline-summary', style: { flex: '1', font: `400 12px ${FONT}`, color: 'var(--tp-text-secondary)' } }),
        h('button', {
          type: 'button', text: '导入', title: '把「一键导出」的 json 放回来',
          style: {
            border: '1px solid var(--tp-grey-3)', background: 'transparent', cursor: 'pointer', color: 'var(--tp-grey-9)',
            font: `500 12px ${FONT}`, height: '26px', padding: '0 12px', borderRadius: '999px', flexShrink: '0',
          },
          onclick: () => openImport(),
        }),
        h('button', {
          type: 'button', text: '✕',
          style: { border: '0', background: 'transparent', cursor: 'pointer', color: 'var(--tp-text-secondary)', font: `500 16px ${FONT}`, padding: '0 4px' },
          onclick: close,
        }),
      ]),
      h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 20px', borderBottom: '1px solid var(--tp-grey-3)' },
      }, [
        h('div', { id: 'olivia-timeline-archive-seg' }),
        h('div', { id: 'olivia-timeline-state-seg' }),
        personSelect,
        h('span', { style: { marginLeft: 'auto' } }, [search]),
      ]),
      h('div', {
        class: 'tp-el-scrollbar',
        style: { flex: '1', minHeight: '0', overflowY: 'auto', padding: '4px 20px 8px' },
      }, [h('div', { id: 'olivia-timeline-list' })]),
      h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 20px 16px', borderTop: '1px solid var(--tp-grey-3)' },
      }, [h('div', { id: 'olivia-timeline-foot' })]),
      importLayer,
    ]);

    overlay = h('div', {
      class: 'tp-el-overlay',
      style: {
        position: 'fixed', inset: '0', zIndex: '2147482900', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '3vh 3vw', background: 'rgba(4,4,6,.72)',
      },
      onclick: event => { if (event.target === overlay) close(); },
    }, [dialog]);
    state.personSelect = personSelect;
  }

  // ---- 导入信件 JSON（挂在线时间线顶部，见派工单 §3.4）----
  // 游戏是 CEF 外壳，<input type="file"> 不一定弹得出系统选择器，所以同时给一个粘贴框兜底。
  function buildImportLayer() {
    const fileInput = h('input', {
      type: 'file', accept: '.json,application/json',
      style: { font: `400 12px ${FONT}`, color: 'var(--tp-text-secondary)', width: '100%' },
      onchange: event => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          state.importText = String(reader.result || '');
          textarea.value = state.importText;
          state.importPreviewId = '';
          paintImportButtons();
          setImportText(`已读入 ${file.name}（${state.importText.length} 字符），点「预览」看看会导入什么。`, 'ok');
        };
        reader.onerror = () => setImportText('这个文件读不出来 —— 改成把内容粘到下面的框里。', 'error');
        reader.readAsText(file);
      },
    });
    const textarea = h('textarea', {
      placeholder: '把「一键导出」生成的 json 内容粘到这里',
      rows: 5,
      style: {
        width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '0', outline: 'none', borderRadius: '10px',
        padding: '10px 12px', background: 'var(--tp-grey-0)', color: 'var(--tp-grey-9)', font: `400 12px/1.7 ${FONT}`,
      },
      oninput: event => { state.importText = event.target.value; state.importPreviewId = ''; paintImportButtons(); },
    });
    const previewButton = h('button', {
      type: 'button', text: '预览',
      style: {
        border: '0', cursor: 'pointer', height: '30px', padding: '0 16px', borderRadius: '999px',
        background: 'var(--tp-grey-3)', color: 'var(--tp-grey-9)', font: `500 13px ${FONT}`,
      },
      onclick: () => void previewImport(),
    });
    const confirmButton = h('button', {
      type: 'button', text: '确认导入',
      style: {
        border: '0', cursor: 'pointer', height: '30px', padding: '0 16px', borderRadius: '999px',
        background: 'var(--tp-primary-2)', color: 'var(--tp-grey-2)', font: `600 13px ${FONT}`,
      },
      onclick: () => void confirmImport(),
    });
    const result = h('div', {
      id: 'olivia-timeline-import-result',
      style: { font: `400 12px/1.8 ${FONT}`, color: 'var(--tp-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    });

    const panel = h('div', {
      class: 'tp-el-dialog',
      style: {
        width: '560px', maxWidth: '100%', maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--tp-grey-1)', borderRadius: '16px', overflow: 'hidden', border: '1px solid var(--tp-grey-3)',
      },
    }, [
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 18px 12px', borderBottom: '1px solid var(--tp-grey-3)' } }, [
        h('span', { text: '导入信件 JSON', style: { flex: '1', font: `600 16px ${FONT}`, color: 'var(--tp-text-title)' } }),
        h('button', {
          type: 'button', text: '✕',
          style: { border: '0', background: 'transparent', cursor: 'pointer', color: 'var(--tp-text-secondary)', font: `500 15px ${FONT}`, padding: '0 4px' },
          onclick: () => closeImport(),
        }),
      ]),
      h('div', { style: { flex: '1', minHeight: '0', overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '10px' } }, [
        h('div', {
          text: '选择游戏里「一键导出」生成的 json 文件，或把内容粘到下面。已存在的信默认跳过，不覆盖本地已有的回信；确认导入前会自动备份一次数据库。',
          style: { font: `400 12px/1.8 ${FONT}`, color: 'var(--tp-text-secondary)' },
        }),
        fileInput,
        textarea,
        result,
      ]),
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', padding: '12px 18px 14px', borderTop: '1px solid var(--tp-grey-3)' } }, [
        h('button', {
          type: 'button', text: '取消',
          style: { border: '1px solid var(--tp-grey-3)', cursor: 'pointer', height: '30px', padding: '0 16px', borderRadius: '999px', background: 'transparent', color: 'var(--tp-grey-9)', font: `500 13px ${FONT}` },
          onclick: () => closeImport(),
        }),
        previewButton,
        confirmButton,
      ]),
    ]);

    const layer = h('div', {
      style: {
        position: 'absolute', inset: '0', display: 'none', alignItems: 'center', justifyContent: 'center',
        padding: '24px', background: 'rgba(4,4,6,.72)',
      },
      onclick: event => { if (event.target === layer) closeImport(); },
    }, [panel]);
    layer.__ui = { fileInput, textarea, previewButton, confirmButton, result };
    return layer;
  }

  function setImportText(text, kind) {
    if (!importLayer) return;
    const { result } = importLayer.__ui;
    result.textContent = text || '';
    result.style.color = kind === 'error' ? 'var(--tp-error)' : kind === 'ok' ? 'var(--tp-primary-2)' : 'var(--tp-text-secondary)';
  }

  function paintImportButtons() {
    if (!importLayer) return;
    const { previewButton, confirmButton } = importLayer.__ui;
    const busy = Boolean(state.importBusy);
    previewButton.disabled = busy;
    previewButton.style.opacity = busy ? '.6' : '1';
    // 没有预览结果就不能确认：preview 用掉即删，没 previewId 的确认只会拿到 404。
    const canConfirm = Boolean(state.importPreviewId) && !busy;
    confirmButton.disabled = !canConfirm;
    confirmButton.style.opacity = canConfirm ? '1' : '.5';
    confirmButton.style.cursor = canConfirm ? 'pointer' : 'default';
  }

  function openImport() {
    if (!importLayer) return;
    state.importPreviewId = '';
    importLayer.__ui.textarea.value = state.importText || '';
    importLayer.__ui.fileInput.value = '';
    paintImportButtons();
    setImportText('还没有预览 —— 先选文件或粘贴内容，再点「预览」。', '');
    importLayer.style.display = 'flex';
  }

  function closeImport() {
    if (importLayer) importLayer.style.display = 'none';
  }

  async function previewImport() {
    if (!importLayer || state.importBusy) return;
    const text = String(state.importText || '').trim();
    if (!text) { setImportText('先选一个 json 文件，或把内容粘到框里。', 'error'); return; }
    state.importBusy = true;
    state.importPreviewId = '';
    paintImportButtons();
    setImportText('正在预览…', '');
    try {
      const data = await post('/toy/letter/import/preview', { content: text });
      state.importPreviewId = String(data.previewId || '');
      const lines = [`文件里 ${data.fileCount} 封 · 新增 ${data.addCount} 封 · 已存在跳过 ${data.skipCount} 封 · 文件内冲突 ${data.conflictCount} 封`];
      if (Array.isArray(data.addSample) && data.addSample.length) {
        lines.push('将写入：' + data.addSample.slice(0, 5).map(item => `${item.date} ${item.time}`).join('、') + (data.addSample.length > 5 ? ' 等' : ''));
      }
      if (Array.isArray(data.conflictSample) && data.conflictSample.length) {
        lines.push('文件内重复、只留一封：' + data.conflictSample.slice(0, 5).map(item => String(item.letterId ?? item)).join('、'));
      }
      lines.push(data.backupHint || '');
      setImportText(lines.filter(Boolean).join('\n'), data.addCount ? 'ok' : '');
    } catch (error) {
      setImportText(`预览失败：${(error && error.message) || error}`, 'error');
    } finally {
      state.importBusy = false;
      paintImportButtons();
    }
  }

  async function confirmImport() {
    if (!importLayer || state.importBusy || !state.importPreviewId) return;
    state.importBusy = true;
    paintImportButtons();
    try {
      const data = await post('/toy/letter/import/confirm', { previewId: state.importPreviewId });
      state.importPreviewId = '';
      const parts = [`已导入 ${data.added ?? 0} 封`];
      if (data.skipped) parts.push(`跳过 ${data.skipped} 封（本地已有）`);
      if (data.failed) parts.push(`失败 ${data.failed} 封`);
      if (data.backupFile) parts.push(`导入前已备份 ${data.backupFile}`);
      const summary = parts.join(' · ');
      closeImport();
      toast(`信件导入完成：${summary}`, true);
      void load(false);
    } catch (error) {
      setImportText(`导入失败：${(error && error.message) || error}`, 'error');
    } finally {
      state.importBusy = false;
      paintImportButtons();
    }
  }

  function paintPersons() {
    if (!state.personSelect) return;
    const current = state.person;
    state.personSelect.replaceChildren(
      h('option', { value: '', text: '所有人' }),
      ...state.persons.map(item => h('option', { value: item.person, text: `${item.person}（${item.count}）` })),
    );
    state.personSelect.value = state.persons.some(item => item.person === current) ? current : '';
  }

  function open() {
    if (!overlay) {
      build();
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKeyDown, true);
    }
    overlay.style.display = 'flex';
    void load(false);
  }

  function close() {
    if (overlay) overlay.style.display = 'none';
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (overlay && overlay.style.display !== 'none') close();
  }

  function cleanup() {
    stopped = true;
    clearTimeout(tickTimer);
    clearTimeout(toastTimer);
    clearTimeout(searchTimer);
    document.removeEventListener('keydown', onKeyDown, true);
    if (overlay) overlay.remove();
    if (button) button.remove();
    document.getElementById('olivia-letter-timeline-button')?.remove();
    document.getElementById('olivia-letter-timeline-toast')?.remove();
    overlay = null;
    button = null;
  }

  function start() {
    // 已经挂上去就别再造一个：tick 是自调度的，不判存在会把「时间线」按钮越堆越多（真机实测踩到，截图里出现 3 个）。
    if (button && button.isConnected) {
      tickTimer = setTimeout(start, document.hidden ? 10000 : 5000);
      return;
    }
    document.getElementById('olivia-letter-timeline-button')?.remove();
    button = h('button', { id: 'olivia-letter-timeline-button', type: 'button', text: '时间线', onclick: () => open() });
    const mounted = mountButton();
    // 挂上去之后没必要每 1.5 秒重扫整个页面；切后台再降一档。
    if (stopped) return;
    tickTimer = setTimeout(start, document.hidden ? 10000 : mounted ? 5000 : 1500);
  }

  window.addEventListener('pagehide', cleanup, { once: true });

  window.OliviaSoulLetterTimeline = { open, refresh: () => load(false), close };
  void start();
})();
