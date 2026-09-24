# OliviaSoul-community

给曲库里那些没有名字的歌起名，顺便把时段也判了。

## 能做什么

1. **自己听**：一首一首过，每首自动截 15 秒，听出来打字回车就写进库。同一首曲子重复传过的会一起命名。
2. **让别人替你听**：把「编号 + 曲名 + 3 段音频指纹」传到这个仓库，别人那边的程序算一遍指纹，对得上就自动填名。
   三段指纹全过才认，宁可留给人听也不填错。
3. **时段**：看画面判断白天/傍晚/夜晚，亮度加色温，在你库里 50 首 150 段上跑过一遍，跟已知答案全对上了。

另外还有：依赖自检（缺 WebView2 或 ffmpeg 会直接告诉你怎么补）、运行日志、程序内一键问题反馈。

## 合规说明

- 非官方第三方分支，与米哈游、游戏《BSide Olivia Lin》官方以及上游 OliviaSoul / linli 项目均无关系。
- 仅供个人学习、研究与技术交流使用，请在下载后 24 小时内删除。
- 本程序不提供、不存储、不传播任何音视频文件，也没有任何音视频下载功能。
- 默认不上传任何数据。只有你明确同意后，才会上传「曲库文件夹编号 + 曲名 + 3 段音频指纹」，
  绝不上传用户名、账号、路径、设备信息、音视频或聊天记录。
- 曲目与作品的版权归各自权利人所有，禁止商业用途。
- 程序按“现状”提供，不附带担保，风险自负。

## 指纹为什么不会填错

- 每首歌取 3 个位置的片段（第 20s / 80s / 140s 起各 60 秒）算量化色度指纹
- 自动命名必须**至少 2 段相似度 ≥ 0.90 且没有任何一段低于 0.70**
- 实测：同一录音 `[1, 1, 1]`；不同歌 `[0.566, 0.577, 0.568]` → 直接否决
- 指纹是单向派生数据，还原不出音频，也不含个人信息

## 怎么用

装好打开，左侧四个新页签：

| 页签 | 干什么 |
| --- | --- |
| **声明与合规** | 首次启动会弹一次确认（勾了就下次不再提示），这里是完整文本 |
| **曲名与时段** | 试听起名 + 时段预览与写入 + 社区名单。首次进入会问一次是否愿意分享曲名 |
| **依赖检查** | 七项自检，缺什么、怎么补都写在上面 |
| **运行日志** | 出问题时点「复制（已脱敏）」，直接贴进 Issue |

省力顺序：先点「刷新名单」→ 再点「自动命名」→ **只剩名单里也没有的歌**才需要你自己听。

## 技术栈

Node ESM + 原生 HTML/CSS/JS（沿用上游 `public/styles.css` 的类名与配色）+ C# WebView2 宿主。

## 构建

    cd source/local-service
    npm install
    npm run build:win

需要 Node >= 22.5、.NET SDK、Inno Setup（脚本会自动下载 Node 运行时、ffmpeg 与 WebView2 引导程序）。

## 目录

    source/local-service/
      midi/listen-naming.js      试听起名（后端）
      midi/time-of-day.js        画面识别（时段）
      midi/community-catalog.js  社区名单拉取 / 自动命名 / 生成投稿
      midi/fingerprint.js        3 段指纹（前后端统一实现）
      midi/dependency-check.js   依赖自检
      midi/logs.js               运行日志
      public/                    对应的前端页面（listennaming / tools / feedback / dependency-check / legal-notices / logs-page）
      packaging/                 上游发布打包脚本（已补上本分支的模块清单）
    data/catalog.json         社区名单（程序读取的唯一入口）
    data/community/           每人一个投稿文件
    tools/                    指纹、脱敏门禁、合并去重、真机探针
    docs/                     使用说明、发布检查清单、GitHub 发布流程

## 路线图

- [x] 试听起名（含分享意愿询问页）
- [x] 画面识别（时段）：真机验证与已知答案一致
- [x] 社区名单：拉取 / 指纹自动命名 / 生成投稿
- [x] 依赖自检、运行日志、问题反馈
- [x] 脱敏门禁 + 指纹去重合并
- [x] 发布：社区仓库地址已写入 `midi/community-catalog.js`、`public/listen-naming-feedback.js`、`server.js`（guvgr2/OliviaSoul-community）

---

完整条款：免责声明.md · 隐私说明.md · 开源软件声明.md · 新增代码许可证.md
（本分支新增代码为 MIT；上游代码的授权状况见 开源软件声明.md）
## 被杀软报毒怎么办

这个程序**没有代码签名证书**，而且它会启动 `node.exe`、调用 `ffmpeg`、扫描你本地的视频文件，
这些行为特征和某些恶意软件相似，所以杀软（尤其卡巴斯基）经常误报。程序本身不含恶意代码，源码全部公开可查。

**第三方检测结果（2026-09-25，版本 `2008.2.7-linli9-g04`）**

| 文件 | VirusTotal 结果 |
| --- | --- |
| 安装包 `OliviaSoul-2008.2.7-linli9-g04-Setup.exe` | **51 家引擎全部未检出** —— [报告](https://www.virustotal.com/gui/file/879ebbf9481d69c086e51e9bb90c450f0f4b08456c394bed5aa5599daf90103c) |
| 便携包 `OliviaSoul-2008.2.7-linli9-g04-Portable.zip` | **60 家中 59 家未检出**；唯一报毒的 ViRobot 报的是 `Win95.Marburg`（1995 年的 DOS 病毒名），属于老特征库误报 —— [报告](https://www.virustotal.com/gui/file/5b97aab0f3242d49951d7d943b4950e224dc30e0a251fe2d3a730384fd14b205) |
| `OliviaSoul.exe`（主程序本体，1.31 MB） | 卡巴斯基 OpenTip **动态分析：干净**（探测 0 / 可疑活动 0 / 网络活动 0，未提取到任何威胁） —— [报告](https://opentip.kaspersky.com/E502707CF7C3CEE0D00855E8786D53B01C2629B4DF2C11C4031BECD5C282B331/results) |

也就是说：**内容层面没有恶意代码**，报毒来自“程序没有代码签名 + 会启动随包的 node/ffmpeg + 大量读写本地文件”这套行为与信誉判断。

三件事可以做：

**1. 加排除项（立刻见效）**

卡巴斯基：设置 → 威胁与排除 → 管理排除项 → 添加 → 选择程序所在的文件夹。
其它杀软类似，把程序目录加进白名单即可。

**2. 优先用免安装版**

`Portable.zip` 比安装包少很多敏感行为（不需要自解压、不写注册表、不自动装依赖），
被误报的概率明显更低。Release 里两个都提供时，建议先用免安装版。

**3. 帮忙提交误报（一劳永逸）**

到 <https://opentip.kaspersky.com/> 上传被报的文件，选 **Report a false detection**，
说明这是开源学习项目并附上仓库地址。通过后所有卡巴用户都不会再被报。

想彻底解决只能给程序买代码签名证书（大约 $10/月起，例如 Azure Trusted Signing）——
签过名的程序不会显示"未知发布者"，信誉也会逐步建立起来。

## 致谢

- **Clously** —— 开源项目《OliviaSoul》，一切从这里开始
- **yilangren** —— [OliviaSoul](https://github.com/yilangren/OliviaSoul) 上游仓库的持续维护
- **coderscsy** —— [linli](https://github.com/coderscsy/linli) 分支，本仓库自它分叉而来（已获上游授权）
- **挥手再见** —— 玩家上传歌曲库，社区名单里最初的曲名来源
- **Node.js、FFmpeg、WebView2、Inno Setup** —— 随包分发的开源组件，许可证见 [开源软件声明.md](开源软件声明.md)

还要谢谢每一位帮忙试听、起名、报 Bug、提建议的朋友：
社区名单里的每一个曲名，都是这样一首一首听出来、攒起来的。