# GitHub 发布流程（照着做即可）

## 第 0 步：先解决两件前置事

### ① 取得上游授权 ✅ 已完成

本分支的两级上游（`yilangren/OliviaSoul`、`coderscsy/linli`）**都没有声明开源许可证**，
按著作权法默认规则属于"保留所有权利"。**本分支已获得作者许可**，此步已完成 ✓ 建议把当时的沟通记录截图留档。

- 通过小黑盒私信联系两位作者，说明你要做的事，请求一句明确的"同意"
- **把对方的回复截图存档**（建议放到 `docs/授权存档/` 并只写文字说明，不要放个人信息）
- 若对方不同意：**只公开你新增的代码文件**（见文末"只发差异版"），不要分发打包好的 EXE

### ② 装 Git for Windows

本机目前**没装 git**。任选一种：

    winget install --id Git.Git -e

若 winget 下载失败（GitHub 直连经常超时），用镜像下安装包：

    # 用 Python 走镜像下载，再把 exe 装上
    python -c "import urllib.request;urllib.request.urlretrieve('https://ghproxy.net/https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe', 'Git-2.51.0-64-bit.exe')"

装完确认：`git --version`

---

## 第 1 步：发布前自检（**每次发布都要做**）

    cd <你的仓库目录>

    # 1) 社区名单门禁
    node tools/sanitize.js check data/catalog.json

    # 2) 确认没有个人隐私 / 媒体文件混进来（应输出 0）
    node -e "const{execSync}=require('child_process');" 
    # 手工检查更直观：下面两条是重点
    dir /s /b | findstr /i "记录 备份 .sqlite .mp4 .mp3"
    findstr /s /i /m "C:\\Users\\ E:\\linlimusic E:\\olivia_tool" *.js *.md *.json

    # 3) 看 git 会提交什么（关键一步）
    git status --short

**绝不允许提交的内容**：`记录/`、`备份/`、`*.sqlite`、`*.mp4/*.mp3`、`dist-native/`、
`build*/`、任何含本机路径或用户名的文件（`.gitignore` 已覆盖，但每次仍要眼看一遍）

---

## 第 2 步：填掉三处占位符

| 文件 | 常量 | 改成 |
| --- | --- | --- |
| `repo/source/local-service/midi/community-catalog.js` | `CATALOG_URL` | `https://raw.githubusercontent.com/<你的账号>/<仓库名>/main/data/catalog.json` |
| `repo/source/local-service/public/listen-naming-feedback.js` | `REPO` | `<你的账号>/<仓库名>` |
| `repo/source/local-service/server.js` 或设置中的更新仓库 | `updateRepository` | `<你的账号>/<仓库名>` |

改完搜一遍确认没有残留：

    findstr /s /i /m "<owner>/<repo>" *.js

---

## 第 3 步：建仓库并首次推送

    cd <你的仓库目录>
    git init
    git add .
    git status --short          # 再确认一遍没有隐私文件
    git commit -m "Initial commit: OliviaSoul 曲名识别分支（2008.2.7-linli9-g01）"
    git branch -M main
    git remote add origin https://github.com/<你的账号>/<仓库名>.git
    git push -u origin main

> 仓库描述里建议写清"非官方第三方分支，仅供学习交流"，与 README 顶部声明一致。

---

## 第 4 步：打包（产出 EXE）

    cd repo\source\local-service
    npm install
    powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-release.ps1 -Iscc "<Inno Setup 安装目录>\ISCC.exe" -OutputDirectory <你的仓库目录>\repo\build-final

产物在 `build-final\`：

    OliviaSoul-2008.2.7-linli9-g01-Setup.exe     ← 安装包
    OliviaSoul-2008.2.7-linli9-g01-Portable.zip  ← 免安装版
    SHA256SUMS.txt                               ← 校验和

**注意**：脚本拒绝写入非空目录，每次发布换一个新的 `-OutputDirectory`。

---

## 第 5 步：发 Release（**命名有硬要求**）

在 GitHub 仓库 → Releases → Draft a new release：

| 项 | 要求 |
| --- | --- |
| **Tag** | `2008.2.7-linli9-g01`（下次 `g02`） |
| **Target** | `main` |
| **Title** | 例如 `2008.2.7-linli9-g01` |
| **说明** | 写清本次改了什么；首次发布加上"上游未声明许可证，已获作者授权（见 docs/授权存档）" |
| **附件** | 上传 Setup.exe、Portable.zip、SHA256SUMS.txt |
| **⚠️ Pre-release** | **不要勾** ✗ 勾了程序的自动更新就读不到（它只查 `/releases/latest`） |
| **⚠️ 资产名** | 必须匹配 `OliviaSoul-*-Setup.exe` ✗ 否则更新器找不到安装包（打包脚本产出的名字天然符合） |

---

## 第 6 步：以后每次跟进上游

1. 拉取上游改动并合并（我们只改了 `server.js` 与 `public/index.html` 两个上游文件，冲突面很小）
2. **改版本号 4 处**：`package.json`、`package-lock.json`（2 处）、`native-host/OliviaSoul.csproj` 的 `<Version>`、`build-release.ps1` 里的 `$version`
   （`AssemblyVersion` / `FileVersion` 必须保持纯数字，如 `2008.2.7.0`）
3. 重跑第 1 步自检 → 第 4 步打包 → 第 5 步发 Release（tag 换成 `g02`）

---

## 附：只发差异版（若未获授权）

只把**你新增的文件**单独建一个仓库公开，使用者自行与上游代码组合：

    midi/listen-naming.js  midi/time-of-day.js  midi/community-catalog.js
    midi/fingerprint.js    midi/dependency-check.js  midi/logs.js
    public/listen-naming.js  public/listen-naming-tools.js
    public/listen-naming-feedback.js  public/dependency-check.js
    public/legal-notices.js  public/logs-page.js
    tools/  data/  docs/  曲目名单格式.md  免责声明.md  隐私说明.md  开源软件声明.md

并在 README 里写明需要自行接入的 5 处（页签、面板、脚本引用、静态白名单、路由挂载）。