// 提权命令模板：UAC 被取消或 Start-Process 失败时，必须如实失败。
//
// 背景（2026-10-11 实测复现）：原来的写法是三处一模一样的
//   $process = Start-Process ... -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode
// 用户取消 UAC（或在安全桌面被挡住、直接点了「否」）时，Start-Process 抛的是**非终止错误**，
// 而外层命令没有设 $ErrorActionPreference='Stop'，于是脚本继续往下走：$process 是 $null，
// 而 `exit $null.ExitCode` 等价于 exit 0（已实测：外层拿到 0）。
// 上层据此认为补丁写入成功 → 自检读到的仍是旧版本 → 触发回滚（回滚同样假成功）→
// 用户最后看到的是「更新后自检未通过：补丁仍显示「可更新」」，真实原因（授权被取消、
// 一个字节都没写）被完全掩盖，还会再弹一次 UAC 去做无意义的回滚。
//
// 现在：先置 $ErrorActionPreference='Stop'，把 Start-Process 包进 try/catch；
// 拿不到进程句柄或退出码也一律写错误文件并 exit 1，绝不静默成功。

const literal = value => `'${String(value).replaceAll("'", "''")}'`;

export const ELEVATION_CANCELLED_HINT = "管理员授权被取消或未取得权限，游戏文件没有被改动。";

export const ELEVATION_NO_PROCESS_MESSAGE = "没有取得管理员权限进程，游戏文件没有被改动。";

export const ELEVATION_NO_EXIT_CODE_MESSAGE = "管理员权限进程没有返回退出码，游戏文件没有被改动。";

function writeErrorScript(errorFile, messageExpression) {
  return `[IO.File]::WriteAllText(${literal(errorFile)}, ${messageExpression}, (New-Object Text.UTF8Encoding $false)); exit 1`;
}

/**
 * 生成「以管理员身份运行一条 EncodedCommand」的外层命令。
 *
 * @param {object} options
 * @param {string} options.encodedCommand base64（UTF-16LE）编码的内层命令。
 * @param {string} [options.errorFile] 失败时写入错误信息的文件；省略则只 exit 1。
 * @param {string} [options.fileName] 被启动的进程，默认 powershell.exe（测试用）。
 * @param {string} [options.verb] Start-Process 的 -Verb，默认 RunAs；传空串表示不提权（测试用）。
 */
export function elevatedProcessCommand({ encodedCommand, errorFile = "", fileName = "powershell.exe", verb = "RunAs" } = {}) {
  const verbFlag = verb ? ` -Verb ${literal(verb)}` : "";
  const fail = messageExpression => `exit 1`;
  const catchBody = errorFile
    ? writeErrorScript(errorFile, `${literal(ELEVATION_CANCELLED_HINT)} + [Environment]::NewLine + $_.Exception.Message`)
    : fail();
  const noProcessBody = errorFile ? writeErrorScript(errorFile, literal(ELEVATION_NO_PROCESS_MESSAGE)) : fail();
  const noCodeBody = errorFile ? writeErrorScript(errorFile, literal(ELEVATION_NO_EXIT_CODE_MESSAGE)) : fail();
  return [
    "$ErrorActionPreference = 'Stop';",
    `try { $process = Start-Process -FilePath ${literal(fileName)} ` +
      `-ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}'${verbFlag} ` +
      `-WindowStyle Hidden -Wait -PassThru }`,
    `catch { ${catchBody} }`,
    `if (-not $process) { ${noProcessBody} }`,
    `if ($null -eq $process.ExitCode) { ${noCodeBody} }`,
    "exit $process.ExitCode",
  ].join(" ");
}

/**
 * 把提权失败信息整理成用户能懂的一句话。
 * 取消/无权限类错误统一换成明确的中文提示，其余原样返回（保留可搜索的原始报错）。
 */
export function describeElevationFailure(message) {
  const text = String(message ?? "").trim();
  if (!text) return ELEVATION_CANCELLED_HINT;
  if (/取消|cancel|denied|拒绝|not allowed|elevation|RunAs/u.test(text)) {
    return `${ELEVATION_CANCELLED_HINT}（原始报错：${text}）`;
  }
  return text;
}
