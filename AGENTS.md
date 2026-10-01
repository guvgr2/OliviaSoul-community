# 本仓库工作约定（必须遵守）

> 这是 OliviaSoul-community 的仓库级规范。**每次改动、每次发版都要按这里执行。**

## 一、每次更新都必须运行「全面检查」

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .test-twins\全面检查.ps1
```

覆盖 6 个阶段：

| 阶段 | 内容 |
|---|---|
| 1 | **单元测试全量**（`node --test`，700+ 项） |
| 2 | **端到端**：启动、真实曲库、媒体 Range、播放、续播、游戏端点全量（真实产物 + 真实数据副本 + 真实 HTTP） |
| 3 | **数据库自愈**：制造陈旧 `-shm`/`-wal` → 启动 → 验证移开留档且服务可用 |
| 4 | **补丁注入**：真实打补丁到测试游戏目录 → 验证 marker、注入符号、JS 语法 |
| 5 | **数据搬家**：真实触发 → 验证服务主动重启（exit 86）、备份、无 malformed |
| 6 | **打包门禁**：关键套件（清单在脚本里，数量会自动打印）+ 打包脚本自检 |

**不通过就不要打包。** 详见 `.test-twins/全面检查说明.md`。

## 二、新增功能时，必须同步更新检测脚本

**否则会出现「新功能检测不到」**（真实踩过：补丁升到 v48 并内联了续播函数，
而打包冒烟还在检查 `v47` 和已删除的 `OliviaSoulApplyResumePoint`，导致打包被误判中止）。

### 改游戏端注入代码（`tools/patch-feapp-local.ps1`）时必须同步 5 处

1. `tools/patch-feapp-local.ps1` 的 `$patchMarker` —— **升版本号**
2. `tools/get-feapp-status.ps1` 的 `$currentMarker` + `$knownMarkers` —— **把旧版本作为历史字面量加进去**
3. `desktop/client-backups.js` 的内嵌 marker 枚举
4. `desktop/feapp-revisions.js` 的 `FEAPP_REVISIONS`
5. **所有断言补丁版本/注入内容的测试**：`test/api.test.js`、`test/fe-v31-uninstall-contract.test.js`、
   `test/fe-playlist-handoff.test.js` 等

> **约定**：端到端补丁检测（`.test-twins/g28-e2e-patch.ps1`）**不硬编码** marker 与函数名，
> 而是从补丁脚本读取 `$patchMarker` 并扫描所有 `OliviaSoulXxx=` 定义 —— 新增注入会被自动覆盖。

### 新增运行期自愈/重启类机制时必须同步

- 打包冒烟的检查项（`.test-twins/*-final-check.ps1`，阶段 6 自动取最新的那一个）
- 端到端脚本（`.test-twins/g2x-e2e-*.mjs`）

### 新增用户可见功能时必须同步 3 处

1. `.test-twins/全面检查.ps1` 阶段 6 的 `$suites` —— 把该功能的测试套件加进去
2. 打包冒烟（最新的 `*-final-check.ps1`）：`$suites` 同样加进去；若功能体现在界面上，
   **必须再加一条产物检查**（直接检查解压后的 `app/**`）——
   单元测试读的是**源码**，产物漏文件时测试仍会全绿（真实踩过）
3. 端到端脚本（`.test-twins/g2x-e2e-*.mjs`），若该功能有运行期行为

> 已实践：端口退让后的用户引导 —— `port-fallback-guidance` 套件（13 项，含真实占用端口、
> 真实补丁 ZIP 的实测）+ 两处 `$suites` + 打包冒烟新增的「产物引导检查」。

### 版本号升级必须同步 6 处

`package.json`、`package-lock.json`（×2）、`native-host/OliviaSoul.csproj`、
`packaging/build-release.ps1`（`$version`）、`public/listen-naming-feedback.js`（`APP_VERSION`），
以及 `E:\olivia_tool\soul集成\审计发布树.mjs`。

## 三、发布流程固定要求

1. **每次推版本，版本号必须增加**（不留同号重发）
   - **精确含义：只有「已发布」的版本才占号**（发布 = 已在 GitHub 建了 Release）。
   - **未发布的版本可以继续在同一个号上迭代** —— 不要因为"改了东西"就机械升号。
     反例（真实踩过）：1.0 还没发布，却因为修 bug 连升到 1.0.1、1.0.2，白占两个号。
   - 补丁版本（`vNN`）是**独立序列**：只要用户已经装过某个补丁版本，新补丁就必须升号。
2. **每次都要给 GitHub 上传的文案**（Summary + Description，可直接粘贴）
3. **每次都要写发布步骤**（放 `.test-twins/g2x发布步骤.md`，含哈希、Release 正文、操作步骤）
4. **不确定/不稳定的功能必须打「实验性」标签**，并说明失败隔离方式
5. **必须做用户引导**（使用说明/发布说明里写清操作路径）
6. **必须做隐私安全与 bug 检查**（`release-privacy` / `source-encoding` 等套件）
7. **如实报告**：失败项、豁免项、不确定的地方都要写出来，不掩盖

## 四、已知豁免（不是产品缺陷，但须逐版复核）

| 类别 | 说明 |
|---|---|
| 依赖 build 产物 | `packaging-artifact`（需先打包） |
| 需真实浏览器 | `*-browser.mjs` 系列 |
| ZIP fixture 建包方式 | `release-privacy` 的 2 项 |
| 测试 vm 缺 DOM | `song-editor-entry` 的 2 项 |
| Windows 临时目录并发 | `api.test.js` / `relay-compatibility` 的 `ENOTEMPTY`（单独跑通过） |
| C# harness 隔离编译 | `native-tray-exit`（缺 `_stopping` 定义） |

## 五、工程细节注意（踩过的坑）

- **`.ps1` 文件必须带 UTF-8 BOM**；编辑后如丢失，用 `node .test-twins/add-bom.mjs <path>` 补回
- **`.ps1` 里的中文** = 文件必须是 UTF-8 **且** 命令行读取时带 `-Encoding UTF8`；否则显示乱码
- **不要用 Node 的 `latin1` 写含 CJK 的文件**（会损坏字节，曾导致构建失败）
- **`[IO.File]::*` 必须用绝对路径**（`.NET` 不看 PowerShell 的当前位置）
- **`packaging/` 目录不得留临时文件**（曾误写 `_tmp_patch_notes.md`，打包前必须确认目录干净）
- **读源码做断言时不要假设「相邻」**：注入函数可能被后续版本插在中间
- **测试 fixture 造 ZIP 时，PS 5.1 下 `Compress-Archive` 与 `ZipFile::CreateFromDirectory`
  都会写成反斜杠条目**（`assets\main.js`），会被审计与状态脚本（要求 `assets/main-*.js`）正确拒绝。
  必须**显式指定条目名**：`$zip = [IO.Compression.ZipFile]::Open($p,'Create'); $zip.CreateEntry('assets/main.js')`
  —— 真实补丁包用的是正斜杠（这条规范原先推荐 `CreateFromDirectory`，实测同样产生反斜杠，已改正）
- **显示文件内容时不要加前缀后误判缩进**：用 `JSON.stringify(line)` 看清真实空白
- **搭测试程序时，补丁脚本必须同步到 `UserData\tools\`**，不是只改 `app\tools\`：
  程序启动 node 时 `--root` 指向 **`UserData`**（可用 `Get-CimInstance Win32_Process` 看 node 的命令行核对，
  或在 `UserData\runtime.log` 里看），工作区文件是从 `resources\workspace-template` 初始化复制来的。
  只改 `app\tools\` 会出现「程序按旧脚本判定」的假象 —— 真实踩过：界面一直显示「服务已挂载」、不提示补丁可更新，
  排查了好几轮才发现改错了地方。同步顺序：`UserData\tools` **+** `resources\workspace-template\tools` **+** `app\tools`。
- **不要用 `| Select-Object -First N` 截断「有副作用」的脚本输出**（写文件、改产物、跑测试都算）：
  管道拿到 N 行后会提前关闭，PowerShell 随即终止上游进程（PipelineStoppedException），
  于是 `Dispose()` / 落盘 / 收尾清理都不会执行 —— 探针脚本曾因此**报告「已写入成功」而文件其实没动**，
  差点让真机验证白跑一轮。要截断输出就改成先落盘到变量、再截取显示。
