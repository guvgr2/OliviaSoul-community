// 「声明与合规」页 + 首次启动声明弹窗
//
// 目的：把免责声明与开源软件声明放在用户一定会看到的位置，避免违规使用。
//   * 首次启动：用应用自带的对话框弹一次，用户点「我已阅读并同意」后才记录
//   * 常驻：左侧「声明与合规」页签，完整文本随时可查
// 样式沿用应用既有类（panelHead / settingsBlock / actions / result）。
(function (global) {
  "use strict";

  const document = global.document;
  const TAB = "legal";
  const ACK_KEY = "oliviaSoul.legalAck.v1";

  const SUMMARY = [
    "本程序是<b>非官方的第三方分支</b>，与米哈游及上游项目官方<b>无任何关系</b>。",
    "仅供<b>个人学习交流</b>，请在<b>下载后 24 小时内删除</b>。",
    "本程序<b>不提供、不存储、不传播</b>任何音视频文件，也<b>没有任何音视频下载功能</b>。",
    "曲库内容来自你自己通过官方客户端获得的作品；所有版权归其权利人所有，<b>禁止商用</b>。",
    "程序按“现状”提供、不附带担保，<b>风险自负</b>；请先备份数据库与曲库。",
    "<b>默认不上传任何数据</b>；仅在你明确同意后分享「文件夹编号 + 曲名 + 3 段音频指纹」，绝不含个人信息。",
    "使用开源软件：Node.js（MIT）、FFmpeg（LGPL 构建）、whisper.cpp（MIT）、Microsoft Edge WebView2 SDK（微软条款）、midi-file（MIT）。",
  ];

  // 弹窗里只放这几行，避免内容过长把按钮挤出可视区；完整条款在「声明与合规」页
  const DIALOG_SUMMARY = [
    "本程序是<b>非官方第三方分支</b>，与米哈游及上游项目官方无任何关系。",
    "仅供<b>个人学习交流</b>，请在<b>下载后 24 小时内删除</b>。",
    "不提供、不存储、不传播任何音视频文件，也<b>没有任何音视频下载功能</b>。",
    "<b>默认不上传任何数据</b>；仅在你同意后分享「编号 + 曲名 + 3 段音频指纹」。",
  ];

  const NOTICES = [
    ["免责声明", [
      "本程序为非官方第三方分支，与 miHoYo（米哈游）、游戏《BSide Olivia Lin》官方，以及上游项目 OliviaSoul / linli 官方团队均无任何关系。",
      "仅供个人学习、研究与技术交流使用，请在下载后 24 小时内删除。",
      "程序不提供、不存储、不传播任何音视频文件，也没有任何从网络下载歌曲/演奏视频的功能。",
      "曲目与作品的版权归各自权利人所有，禁止用于商业用途。",
      "程序按“现状”提供，不附带任何担保；因使用本程序造成的一切后果由使用者自行承担，请先备份数据库与曲库。",
      "若权利人认为本项目侵犯其权益，请通过仓库 Issue 联系，我们会尽快删除相关内容。",
    ]],
    ["开源软件声明", [
      "Node.js 22（MIT）—— 运行时，许可证随程序分发于 runtime\\NODE-LICENSE.txt",
      "FFmpeg / FFprobe n8.1（LGPL v3 构建）—— 音视频处理，见 runtime\\ffmpeg\\LICENSE.txt",
      "whisper.cpp v1.9.2（MIT）—— 语音识别，见 runtime\\whisper\\LICENSE.txt",
      "midi-file 1.2.4（MIT）—— MIDI 解析，随 app\\node_modules\\midi-file\\LICENSE.md",
      "Microsoft Edge WebView2 SDK（微软软件许可条款）—— 界面渲染，见 licenses\\WebView2\\",
      "打包工具 Inno Setup 6（允许非商业使用）、.NET SDK（MIT），不随程序分发",
    ]],
    ["个人隐私合规", [
      "本程序<b>默认不上传任何数据</b>。首次进入「曲名与时段」时会询问是否愿意分享曲名，选择「暂不分享」不影响任何功能。",
      "同意分享后，上传内容<b>仅限</b>：曲库文件夹编号（形如 midi_8815_1786281418，本身不含身份信息）、你填写的曲名、用于识别同一首曲子的 3 段音频指纹。",
      "以下内容<b>绝不上传</b>：用户名、昵称、UID、账号、头像、邮箱；设备 ID、设备型号、显卡信息、IP、机器名、Windows 用户名；任何文件路径；音频、视频、封面、歌词；聊天记录、信件与记忆内容；数据库文件本身。",
      "音频指纹是量化色度特征，属于<b>单向派生数据</b>，无法还原为音频，也不含个人信息。",
      "分享意愿可随时在设置中关闭，并可清空待上传队列；已提交到公开仓库的内容因属公开数据，无法撤回。",
      "本地数据（数据库备份、试听片段缓存、命名日志）<b>只保存在你自己机器上</b>，不会被上传；可随时自行删除。",
      "本程序遵循个人信息处理的<b>最小必要</b>与<b>告知同意</b>原则：不收集与功能无关的信息，不静默上传，不向第三方出售或共享任何数据。",
    ]],

    ["上游与授权状况", [
      "本分支基于上游开源项目 coderscsy/linli 二次开发，其自身基于 yilangren/OliviaSoul。",
      "上游仓库当前未声明开源许可证；本分支已获得上游作者的明确许可，可公开分发与维护。",
      "本分支新增代码采用 MIT 许可证（见 新增代码许可证.md），该授权不改变上游代码的授权状态。",
    ]],
  ];

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function summaryHtml() {
    return SUMMARY.map(line => `<p>· ${line}</p>`).join("");
  }

  function buildPage() {
    const wrap = document.createDocumentFragment();
    const head = node("div", null, "panelHead");
    const left = node("div");
    left.append(
      node("h2", "声明与合规"),
      node("p", "以下内容请在首次使用前阅读。本页为常驻页面，随时可回看。"),
    );
    head.append(left, node("div", null, "ln-statusChips"));
    wrap.append(head);

    const important = node("section", null, "settingsBlock");
    const importantHead = node("div", null, "panelHead");
    importantHead.append(node("h3", "重要声明"), node("p", ""));
    const importantBody = node("div", "", "fieldHint");
    importantBody.innerHTML = summaryHtml();
    important.append(importantHead, importantBody);
    wrap.append(important);

    for (const [title, lines] of NOTICES) {
      const block = node("section", null, "settingsBlock");
      const blockHead = node("div", null, "panelHead");
      blockHead.append(node("h3", title), node("p", ""));
      const body = node("div", "", "fieldHint");
      body.innerHTML = lines.map(line => `<p>${line}</p>`).join("");
      block.append(blockHead, body);
      wrap.append(block);
    }
    const actions = node("div", null, "actions");
    const again = node("button", "重新显示启动声明", "secondary");
    again.addEventListener("click", () => {
      try {
        global.localStorage.removeItem("oliviaSoul.legalAck.v1");
      } catch {
        // 无痕模式忽略
      }
      result.textContent = "已重置，下次启动会再次提示。";
    });
    const result = node("p", "", "result");
    actions.append(again);
    wrap.append(actions, result);

    return wrap;
  }

  function mount() {
    const host = document.querySelector(`.tabPage[data-page="${TAB}"]`);
    if (!host || host.dataset.legalReady === "1") return;
    host.dataset.legalReady = "1";
    host.replaceChildren(buildPage());
  }

  /** 首次启动弹一次；用户已确认过就不再打扰。 */
  function ensureAcknowledged() {
    let acked = "";
    try {
      acked = global.localStorage.getItem(ACK_KEY) || "";
    } catch {
      acked = "1"; // 无痕模式下不反复弹
    }
    if (acked) return;
    const layer = document.getElementById("noticeLayer");
    const title = document.getElementById("noticeTitle");
    const message = document.getElementById("noticeMessage");
    const confirm = document.getElementById("noticeConfirm");
    const cancel = document.getElementById("noticeCancel");
    if (!layer || !title || !message || !confirm || !cancel) return;
    title.textContent = "使用前请阅读：重要声明";
    message.style.textAlign = "left";
    message.style.maxHeight = "52vh";
    message.style.overflowY = "auto";
    message.innerHTML = DIALOG_SUMMARY.map(line => "<p>· " + line + "</p>").join("") +
      "<p style=\"color:#8b9198\">完整声明见左侧「声明与合规」页。</p>";
    cancel.hidden = false;
    cancel.textContent = "取消";
    confirm.textContent = "确定";
    message.innerHTML +=
      '<label id="legalAckCheckbox" style="display:flex;align-items:center;gap:8px;margin-top:10px">' +
      '<input type="checkbox" id="legalAckInput"> <span>已阅读声明，下次启动不再提示</span></label>';
    layer.hidden = false;
    cancel.addEventListener("click", () => {
      layer.hidden = true;
    }, { once: true });
    confirm.addEventListener("click", () => {
      layer.hidden = true;
      const box = document.getElementById("legalAckInput");
      if (box && box.checked) {
        try {
          global.localStorage.setItem(ACK_KEY, new Date().toISOString());
        } catch {
          // 无痕模式：无法记住，下次仍会提示
        }
      }
    }, { once: true });
  }

  const button = document.querySelector(`.sideTab[data-tab="${TAB}"]`);
  if (button) button.addEventListener("click", () => global.setTimeout(mount, 60));
  if (document.readyState !== "loading") {
    global.setTimeout(() => { mount(); ensureAcknowledged(); }, 400);
  } else {
    document.addEventListener("DOMContentLoaded", () => global.setTimeout(() => { mount(); ensureAcknowledged(); }, 400));
  }

  global.OliviaSoulLegalNotices = { mount, ensureAcknowledged };
})(window);