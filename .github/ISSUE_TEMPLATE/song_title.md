---
name: 曲名投稿 / Song title contribution
about: 贡献你识别出来的曲名（也可在程序内用「生成投稿文件」自动生成）
title: "[曲名] "
labels: catalog
---

### 投稿内容

（把程序生成的 `community-upload-queue.json` 内容贴在这里，或按下面格式列出）

    {
      "version": 1,
      "contributor": "<你的 GitHub 用户名>",
      "entries": {
        "midi_130991_1784281291": { "name": "稻香", "fps": ["<512>", "<512>", "<512>"], "hash": "<16位>" }
      }
    }

**请只提交「编号 + 曲名 + 指纹」这三项，不要包含任何个人信息、路径或媒体文件。**
维护者会跑 `node tools/sanitize.js check <文件>` 校验后合并。