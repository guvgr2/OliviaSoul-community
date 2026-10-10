# 本地服务 API 清单（`/admin/api/*` 现状）

本文件只列**现在**存在的接口：路径、方法、用途、源码位置。不含规划，不含「应该怎样」。

## 0. 生成方式（本文件怎么来的、怎么重生成）

本清单不是手抄的，是用脚本从 `repo/source/local-service/server.js` 抽出来的，再人工补「用途」一列。抽取规则：

1. 逐行找含 `/admin/api` 的分支：`if (req.method === "X" && path === "/admin/api/…")`；
2. 同行抓 `req.method === "X"` 得到方法（可能有多个，如 `GET|HEAD`），抓 `"/admin/api/…"` 字面量得到路径；
3. 另外抓「正则匹配式动态路由」：`const 名字 = /^\/admin\/api\/…$/u.exec(path)` 及其后面那个 `if`；
4. 数组式路径（`["/admin/api/local-ai/process", …].includes(path)`）也算一条。

脚本（放到仓库外任意位置即可跑，比如 `%TEMP%\api-table.mjs`）：

```js
import { readFileSync } from "node:fs";
const file = "<仓库根>/repo/source/local-service/server.js"; // 换成你本机仓库的实际路径
const lines = readFileSync(file, "utf8").split(/\r?\n/);
const rows = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!line.includes("/admin/api")) continue;
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("import")) continue;
  const method = [...t.matchAll(/req\.method === "([A-Z]+)"/g)].map(m => m[1]).join("|") || "(无)";
  const literals = [...t.matchAll(/"(\/admin\/api[^"]*)"/g)].map(m => m[1]);
  rows.push({ ln: i + 1, method, path: literals.join(", ") || "(字面量见下一行/正则)" });
}
console.log(`TOTAL=${rows.length}  server.js=${lines.length} 行`);
for (const r of rows) console.log(`${r.ln}\t${r.method}\t${r.path}`);
```

```powershell
node "$env:TEMP\api-table.mjs"
```

当前实测：`TOTAL=54  server.js=4719 行`（54 = 含 `/admin/api` 字面量的分支行数，其中 `local-ai` 一行含 3 个路径）。正则式动态路由另有 9 条、带外（共享分支/共享正则）2 条，合计 **65 条路径条目**。

**第四轮补记（1.2.0）**：歌单路由组（§11）是一条正则同时覆盖 `/admin/api/folders/*` 与 `/toy/folders/*`，共 12 个子路径。因为正则里写成 `admin\/api`（转义斜杠），上面那套字面量抽取规则数不到它 —— 也就是说「65 条」**不含**歌单，补齐后为 **66 条**（正则式动态路由 9 → 10 条）。

**行号会漂**：本仓库工作区在并发开发，行号随每次提交变。表中行号只是「当时抽取时」的值，重跑脚本即可刷新。

---

## 1. 请求与响应的统一约定

| 事情 | 现状 | 源码 |
| --- | --- | --- |
| 成功响应 | HTTP 200 + `{"code":0,"message":"success","data":…}` | `server.js` 的 `ok(req, res, data, headers)` → `sendJson()` |
| 失败响应 | `{"code":<错误码或 -1>,"message":"<人话>","data":null}`，HTTP 状态取 `error.status ?? 500` | `server.js` 的 `createServer` 里那个 `catch` |
| **`/toy/*` 的失败** | **HTTP 一律 200**（只有 `mediaResponse` 类错误才用真状态码）——游戏端只看 body 里的 `code` | 同上 `const responseStatus = req.url.startsWith("/toy/") && !error.mediaResponse ? 200 : status;` |
| 404 兜底 | `/admin` 前缀走静态文件（`serveStatic`），否则 `httpError(404, "接口不存在")` | `server.js` 分派函数末尾 |
| CORS | 无 `Origin` 头则不加 CORS 头；`/admin/*` **只反射自己的源**（防止任意网页跨域读走已保存的 API Key）；`/toy/*` 反射调用方源 | `server.js` 的 `corsHeaders(req)` |
| 允许的方法头 | `GET, POST, PUT, OPTIONS` | 同上 `Access-Control-Allow-Methods` |

`httpError(status, message, code = -1)` 造错误对象（`server.js:334-337`）。

---

## 2. 身份与状态

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 3764 | GET | `/admin/api/identity` | 读离线身份（`getOfflineIdentity()`） |
| 3767 | POST | `/admin/api/identity` | 保存离线身份（`normalizeOfflineIdentity(await readJson(req))`） |
| 3774 | GET | `/admin/api/status` | 就绪状态：`{ready:true, person}` |
| 3778 | GET | `/admin/api/storage` | 存储状态 + 引用根汇总 + 曲库来源 |
| 3781 | POST | `/admin/api/storage/refresh` | 重新探测存储状态 |
| 3947 | POST | `/admin/api/open-external` | 用系统默认程序打开外部链接/路径 |
| 3905 | GET | `/admin/api/debug` | 调试面板数据 |
| 3917 | POST | `/admin/api/debug/delay` | 设回复延迟秒数（`body.seconds`） |
| 3925 | POST | `/admin/api/debug/delay/default` | 延迟恢复默认值 |
| 3930 | POST | `/admin/api/debug/quota/reset` | 重置今日配额（顺带 `bumpLetterRevision()`） |
| 3937 | POST | `/admin/api/debug/quota/limit` | 设今日配额上限（`body.limit`） |

## 3. 数据搬家（storage migration）

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 3784 | POST | `/admin/api/storage/migration/preview` | 开始搬家预览：`storageMigration.startPreview({targetRoot: storageStatus.activePath})` |
| 3789 | GET | `/admin/api/storage/migration/preview/:jobId` | 查预览进度（正则 `storagePreviewStatusMatch`）；查不到 404 `MIGRATION_PREVIEW_JOB_NOT_FOUND` |
| 3799 | POST | `/admin/api/storage/migration/preview/:jobId/cancel` | 取消预览（正则 `storagePreviewCancelMatch`） |
| 3809 | POST | `/admin/api/storage/migration/confirm` | 确认搬家；缺确认 → `MIGRATION_CONFIRMATION_REQUIRED`（409）、其余 `MIGRATION_*` → 409 |

## 4. 信件与回信视频

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 5433 | GET | `/admin/api/letters` | 信件列表（`visibleLetter(row, req)`，带 `error` / `memoryError`）。**不传查询参数＝老行为**：最近 100 条，直接返回数组；显式带上 `before` / `limit` / `status` / `archived` / `person` / `q` 之一才返回分页对象 `{list,hasMore,nextBefore,stats,total,persons}` |
| 3748 | POST | `/admin/api/letters/:id/video` | 给回信存视频（正则 `videoManageMatch`）：`saveReplyVideo()` + `rebuildArchiveProjection()` |
| 3748 | DELETE | `/admin/api/letters/:id/video` | 删回信视频（同一个正则分支）；回信不存在 → 404「对应回信不存在」 |
| 4341 | POST | `/admin/api/memory/import/preview` | 导入预览（`body.exchanges`） |
| 4535 | POST | `/admin/api/import/preview` | 信件导入预览 |
| 4547 | POST | `/admin/api/import/confirm` | 信件导入确认 |
| 4251 | POST | `/admin/api/import/ai` | AI 全文导入（把粘贴全文切成可编辑的信） |
| 4105 | GET | `/toy/mail/timeline` | 游戏端信件时间线（游标分页）：`before`（`created_at_rowid` 游标）、`limit`（默认 50、上限 200）、`status`（`replied` / `pending` / `failed`）、`archived`（`archived` / `unarchived` / `all`）、`person`、`q`；返回 `{list,hasMore,nextBefore,stats,total,persons}`。**`total`＝当前筛选命中数，`stats`＝全库概览**；未到 `available_at` 的回信按 `pending` 且 `replyText:null` 返回（不剧透），状态判定与 `letterExportReplied()` 同一口径 |
| 4110 | POST | `/toy/letter/import/preview` | 信件导入预览：校验 `olivia-soul-letters` v1 格式（不合格 400 并说明原因），返回 `previewId` / `addCount` / `skipCount` / `conflictCount` 与样本；不写库 |
| 4137 | POST | `/toy/letter/import/confirm` | 信件导入确认：按 `previewId` 写入（`source='import'`、`status=REPLIED`）；导入前自动备份一次数据库（`backup-letter-import-*.sqlite`）；已存在的 `letterId` 跳过、不覆盖本地回信；同一预览只能用一次（再用 404） |

## 5. 语音转写

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 3823 | POST | `/admin/api/transcription` | 新建转写任务 |
| 3828 | POST | `/admin/api/transcription/upload` | 上传音频字节（流式写盘，回调里用 `transform`） |
| 3849 | GET | `/admin/api/transcription/:id` | 查任务（正则 `transcriptionMatch`） |
| 3860 | POST | `/admin/api/transcription/:id/cancel` | 取消任务（正则 `transcriptionCancelMatch`） |

## 6. 远端记忆（remote memory）

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 3864 | POST | `/admin/api/remote-memory` | 启动远端任务：`remoteMemoryJobs.start()` |
| 3867 | GET | `/admin/api/remote-memory/:id` | 查任务（正则 `remoteMemoryMatch`） |
| 3871 | POST | `/admin/api/remote-memory/:id/cancel` | 取消（正则 `remoteMemoryCancelMatch`） |
| 3875 | POST | `/admin/api/remote-memory/:id/import` | 把远端结果导入本地记忆库（`withMemoryLock()` 包住 `importSoulArchive()`） |
| 3887 | GET | `/admin/api/remote-memory/:id/soul` | 下载对方的 soul 归档（流式；`HEAD` 只回响应头不写 body） |

## 7. 更新（含 stable / beta 双通道）

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 3954 | GET | `/admin/api/update` | 检查更新；**通道现读本机 `settings`**，用户切通道后下次检查立刻生效（源码注释就写在分支前一行） |
| 3967 | POST | `/admin/api/update/channel` | 切换更新通道 |
| 3976 | POST | `/admin/api/update/download` | 开始下载更新：`updateDownloads.start()` |
| 3980 | GET | `/admin/api/update/download/status` | 下载状态 |
| 3983 | POST | `/admin/api/update/download/cancel` | 取消下载 |
| 3989 | POST | `/admin/api/update/download/pause` | 暂停下载 |

## 8. 模型配置

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 3995 | GET | `/admin/api/model` | 读模型配置（`modelConfigPayload(await readModelConfig({root}))`） |
| 3999 | POST | `/admin/api/models/reset` | 重置运行时：`modelRuntimeGeneration += 1` |
| 4014 | GET | `/admin/api/model/status` | 运行时状态 |
| 4017 | POST | `/admin/api/model/detect` | 探测可用模型：`detectActiveModel()` |
| 4020 | — | `/admin/api/local-ai/process`、`/admin/api/local-ai/start`、`/admin/api/local-ai/stop` | 已移除：一律 **410** `LOCAL_AI_PROCESS_REMOVED`（三个路径写在同一个数组里 `includes` 判断，不分方法） |
| 4023 | POST | `/admin/api/model/models` | 拉模型列表 |
| 4060 | POST | `/admin/api/model/profile` | 写模型档案 |
| 4094 | POST | `/admin/api/model/activate` | 激活模型 |
| 4122 | POST | `/admin/api/model/test-save` | 测试并保存 |
| 4163 | POST | `/admin/api/model/test` | 只测试连接 |
| 4183 | GET | `/admin/api/deepseek` | 读 DeepSeek 配置（旧入口，仍在） |
| 4188 | POST | `/admin/api/deepseek` | 写 DeepSeek 配置 |
| 4219 | POST | `/admin/api/deepseek/test` | 测试 DeepSeek 连接（测试断言请求打到 `https://model.example/v1/chat/completions`） |

## 9. 记忆

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 4312 | GET | `/admin/api/memory` | 记忆条目列表（`memoryRows(user.id, true)`） |
| 4317 | GET\|HEAD | `/admin/api/memory/export/soul` | 导出 soul 归档：`exportSoulArchive()` |
| 4322 | GET | `/admin/api/memory/export` | 导出记忆 JSON：`buildMemoryExport()` |
| 4326 | GET | `/admin/api/memory/status` | 记忆状态（`getMemoryStatus(person)`） |
| 4331 | POST | `/admin/api/memory/refresh` | 恢复/继续记忆刷新：`resumeMemoryRefresh(person)` |
| 4336 | POST | `/admin/api/memory/import/soul` | 导入 soul 归档：`withMemoryLock()` + `importSoulArchive()` |
| 4353 | POST | `/admin/api/memory/import` | 导入记忆条目 |
| 4423 | POST | `/admin/api/memory` | 写一条记忆 |

## 10. MIDI 曲库

| 行号 | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 4443 | GET | `/admin/api/midi` | MIDI 曲库状态 |
| 4466 | GET | `/admin/api/midi-duration-repair` | 时长修复状态：`midiDurationRepair.status()` |
| 4470 | POST | `/admin/api/midi-duration-repair/start` | 开始时长修复 |
| 4474 | POST | `/admin/api/midi-library/preview` | 曲库预览 |
| 4497 | POST | `/admin/api/midi-library/confirm` | 曲库确认 |
| 1927 | GET | `/admin/api/listen-naming/health`（与 `/toy/listen-naming/health` 同一分支） | 曲库体检：`midi/listen-naming.js` 的 `libraryHealth()`。不传参＝每类明细最多回 30 条（同款群两组各 20 条），但 `counts.*` 与 `totals.*` **始终是全量数字**（前端「共 N 条，已列出前 M 条」靠这两个数），`totals.X` 是该类明细真实条数；显式带 `?full=1` 时不截断且 `full:true`。返回 `duplicateNames{name,folders,count}` / `twinConflicts{folders,names}`（同群但名字不一致，要人工核对）/ `duplicateGroups{name,folders,count}`（同款群里名字一样＝可合并，不是错误）/ `missingVideo[folder]` / `missingMidi[folder]` / `durationOdd{folder,seconds}` / `placeholderNames{folder,name}`（`个人上传 · midi_xxx` 占位名，**只统计不猜曲名**）。既有键一个都没删，旧「曲库健康检查」面板照旧可用 |

## 11. 歌单与收藏（`/folders`，1.2.0 新增）

一条正则同时吃程序端与游戏端：`folderApiMatch = /^\/(?:toy|admin\/api)\/folders(?:\/(.*))?$/u`
（`server.js:4602`）。下表按 `rest` 分段列出全部子路径；`:id` 一律是歌单 id（TEXT）。
歌单不存在 → 404 `歌单不存在`；段数对但方法不对 → 405 `歌单接口不支持这个方法`；段数不匹配 → 404 `接口不存在`。

| 行号 | 方法 | 路径（`/admin/api/folders/*` 与 `/toy/folders/*` 同款） | 用途 |
| --- | --- | --- | --- |
| 4609 | GET | `/folders` | 歌单列表：`{list, total}`，每项带成员数（`song_folder_items` 按 `folder_id` 计数） |
| 4614 | POST | `/folders` | 新建歌单：body `name` / `folderName` / `folder_name`（撞名自动加后缀） |
| 4624 | POST | `/folders/import` | 整单导入（扫二维码文本或 `.osfolder` 内容）：body `text` / `content` / `code`；返回 `folder`、`added`、`skipped`、`missing`（曲库里没有的 itemId **原样列出，绝不静默丢**）、`missingCount`、`total` |
| 4643 | GET | `/folders/membership?ids=a,b,c` | 一批曲子分别落在哪些歌单里（游戏端「已在 N 个歌单」/勾选态）。只读；不传 `ids` 只回计数。**必须在 `:id` 之前匹配**，否则 `membership` 会被当成歌单 id。一次最多 500 个 id（`server.js:4449` 截断，更多要调用方自己分批） |
| 4653 | GET | `/folders/:id` | 歌单详情：`folderPayload` + `items` |
| 4655 | PATCH\|PUT | `/folders/:id` | 改名（撞名自动加后缀） |
| 4661 | DELETE | `/folders/:id` | 删歌单（连同成员）：`{id, removedItems}` |
| 4670 | POST | `/folders/:id/import-library` | 一键把曲库里能播的全部灌进来：`{folderId, added, skipped, noMedia, items}`（不能播的只计数，不静默丢） |
| 4684 | GET\|POST | `/folders/:id/export` | 导出：成员 ≤ 30 首给二维码矩阵，再多就给 `.osfolder` 文件内容；返回 `itemIds`、`text`、`mode`（`qr`/`file`）、`qr`、`fileName` |
| 4700 | POST | `/folders/:id/items/order` | 排序：`{direction:"up"\|"down", itemId}` 相邻换位，或 `{itemIds:[…]}` 整表重排；`direction` 传了非 up/down 的值 → 400 `direction 只能填 up 或 down`（第四轮 #69 之前是静默不生效） |
| 4731 | GET | `/folders/:id/items` | 成员列表：`{folderId, total, items}` |
| 4734 | POST | `/folders/:id/items` | 加成员：body 由 `folderEntriesFrom()` 解释（`itemId` / `itemIds` / `items`），返回 `added` / `skipped` |
| 4739 | DELETE | `/folders/:id/items` | 删成员：body 同上，返回 `removed` |

**交换格式**：`OSF1|歌单名|itemId1,itemId2,…`（标签常量 `server.js:4365`，导出 `folderExportText()` :4535，导入 `folderParseExport()` :4556）。

**二维码 / 文件切换口径**：`FOLDER_QR_MAX_ITEMS = 30`（`server.js:4361`）—— 成员 ≤ 30 首走二维码，超过 30 首走 `.osfolder` 文件，**不做分片**。

**游戏端注入**：游戏内歌单下拉与「合集」由 `public/game-favorites.js` 接管（补丁 marker v62，见 `docs/客户端补丁与挂载.md`）。

## 12. 带外：不算独立分支、但确实存在的两个 `/admin/api` 路径

| 行号 | 方法 | 路径 | 说明 |
| --- | --- | --- | --- |
| 2983 | POST | `/admin/api/media/songs/remove` | 与 `/toy/media/songs/remove`、`/toy/deleteUserSong` 共用同一个 `.includes(path)` 分支 |
| 3124 | GET\|POST | `/admin/api/media/songs/:id/metadata` | 与 `/toy/media/songs/:id/metadata` 共用同一个正则 `songMetadataMatch`；作品不存在 → 404 `MIDI_SONG_NOT_FOUND`；名称非法 → 400 `MIDI_SONG_NAME_INVALID`，映射非法 → 400 `MIDI_SONG_MAPPING_INVALID` |

## 13. 不在本清单范围的前缀（只说在哪，不重复内容）

- `/toy/*`：游戏端兼容层，包括 `midi/routes.js` 的 `/toy/midi/*`（其中 `importShareCode`、`getObjectUploadUrl`、`midi/upload/:token`、`midi/generate` 等已退化为 **410**）、`/toy/listen-naming/*`（试听起名，各子模块自带路由）、`/toy/media/*`、`/toy/letter/*`。
- `/toy/listen-naming/data/*`：备份/导出/导入/恢复共 10 条，逐条列在 [数据与状态文件](数据与状态文件.md) §5。
- 列出其余前缀下全部路径的通用命令：

```powershell
cd <仓库根>\repo\source\local-service
Select-String -Path midi\*.js,server.js -Pattern 'path === "/' |
  ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }
```

## 14. 已知不一致（如实记录，不是建议）

- **测试里的两条路径在源码里不存在**，而且测试本身就断言它们失败（`code !== 0`）：
  - `test/api.test.js:2517` 请求 `POST /admin/api/archive/sync`；
  - `test/api.test.js:3384` 请求 `POST /admin/api/settings`（旧延迟入口）。
  两者都落在 §1 的 404 兜底上，测试也确实是按「会失败」来断言的。
- **`/admin/api/*` 的中文错误文案里有既存的乱码**（同一文件的注释是正常 UTF-8，文件内也没有 U+FFFD）：例如 `/admin/api/letters/:id/video` 分支附近的 `"鎾崟鏉＄洰涓嶅畬鏁?"`、`"瀵瑰簲鍥炰俊涓嶅瓨鍦?"`，以及搬家预览的 `"灏氭湭鍙栧緱娓告垙璁剧疆鐨勫洖鐩樹繚瀛樿矾寰?"`。`test/api.test.js` 里也有同类乱码字符串（如 `"浣犲ソ銆?`）。这是仓库既有的双重编码技术债，属代码侧，本文件只登记现象，不改。

## 15. 核对方法

```powershell
cd <仓库根>\repo\source\local-service

# 1) 重生成路径/方法清单（脚本见 §0）
node "$env:TEMP\api-table.mjs"
# 2) 正则式动态路由原样（9 条）
Select-String -Path server.js -Pattern 'Match = /' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
# 3) 响应约定
Select-String -Path server.js -Pattern 'function ok\(|function httpError\(|code: error.code' -Context 0,2
# 4) 测试覆盖：请求 /admin/api/* 的断言数量
(Select-String -Path test\*.js -Pattern '/admin/api/').Count   # 实测 275 处
```
