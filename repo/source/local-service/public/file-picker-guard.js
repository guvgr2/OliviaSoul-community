/**
 * 文件选择器的统一触发口。
 *
 * 为什么需要它（1.2.0 真机反馈，见 analysis/给deepseek-1.2.0-真机反馈修复单-2026-10-11.md §一）：
 * public/styles.css 第 2 行在 :root 上声明了 `color-scheme: dark`，
 * 而 Chromium（WebView2 子进程）弹出的文件选择器会**跟随文档的 color-scheme 渲染**，
 * 对话框其余部分却仍按系统浅色画 ⇒ 只有「面包屑路径」那一行被画成黑底（用户看到的那条黑）。
 *
 * 做法：在对话框真正弹出**之前**把文档临时切成浅色，收场后立刻还原。
 *
 * ⚠️ 两道兜底（cancel / window focus）不许精简：
 *   用户在对话框里按「取消」或 Esc 时 **不会** 触发 change，
 *   只写「change 里还原」⇒ colorScheme 永久停在 light ⇒
 *   整个深色界面的滚动条 / 下拉框 / 日期控件会瞬间变白，界面破相。
 */

/**
 * 只做「切浅色 + 挂还原」，不负责触发 —— 给「用户直接点 input（或被 label 代理）」的场景用。
 * 那种场景下 click 已经在发生，再调一次 input.click() 会重复弹框。
 */
export function lightForFilePicker(input) {
  if (!input) return () => {};
  const root = document.documentElement;
  const previous = root.style.colorScheme;
  root.style.colorScheme = 'light';

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    root.style.colorScheme = previous;
    input.removeEventListener('change', onChange);
    input.removeEventListener('cancel', restore);
    window.removeEventListener('focus', restore);
  };
  // 让 change 的处理函数先读完 event.target.files 再还原。
  const onChange = () => setTimeout(restore, 0);

  input.addEventListener('change', onChange, { once: true });
  input.addEventListener('cancel', restore, { once: true });
  // 兜底：有些实现既不给 change 也不给 cancel，对话框关掉后主窗口会回焦。
  window.addEventListener('focus', restore, { once: true });
  return restore;
}

/** 按钮间接触发：切浅色 → click() → （change / cancel / 回焦时）还原。 */
export function pickFile(input) {
  if (!input) return;
  lightForFilePicker(input);
  input.click();
}
