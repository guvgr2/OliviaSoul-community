> ⚠️ **本文档已过期（停在 g01 时期），仅作历史参考。**
> 当前做法请看仓库根 `README.md`、本机发版资料（`soul集成\发版手册.md`）与 `g18发布步骤.md`。
> 里面的版本号、目录名与命令都可能已经变了，**不要照抄**。
> 另：本文正文的中文已编码损坏（早期文件被反复转码），读起来是乱码；保留仅供存档，**不要阅读正文**，流程以 `g18发布步骤.md` 为准。
# GitHub 鍙戝竷娴佺▼锛堢収鐫€鍋氬嵆鍙級

## 绗?0 姝ワ細鍏堣В鍐充袱浠跺墠缃簨

### 鈶?鍙栧緱涓婃父鎺堟潈 鉁?宸插畬鎴?
鏈垎鏀殑涓ょ骇涓婃父锛坄yilangren/OliviaSoul`銆乣coderscsy/linli`锛?*閮芥病鏈夊０鏄庡紑婧愯鍙瘉**锛?鎸夎憲浣滄潈娉曢粯璁よ鍒欏睘浜?淇濈暀鎵€鏈夋潈鍒?銆?*鏈垎鏀凡鑾峰緱浣滆€呰鍙?*锛屾姝ュ凡瀹屾垚 鉁?寤鸿鎶婂綋鏃剁殑娌熼€氳褰曟埅鍥剧暀妗ｃ€?
- 閫氳繃灏忛粦鐩掔淇¤仈绯讳袱浣嶄綔鑰咃紝璇存槑浣犺鍋氱殑浜嬶紝璇锋眰涓€鍙ユ槑纭殑"鍚屾剰"
- **鎶婂鏂圭殑鍥炲鎴浘瀛樻。**锛堝缓璁斁鍒?`docs/鎺堟潈瀛樻。/` 骞跺彧鍐欐枃瀛楄鏄庯紝涓嶈鏀句釜浜轰俊鎭級
- 鑻ュ鏂逛笉鍚屾剰锛?*鍙叕寮€浣犳柊澧炵殑浠ｇ爜鏂囦欢**锛堣鏂囨湯"鍙彂宸紓鐗?锛夛紝涓嶈鍒嗗彂鎵撳寘濂界殑 EXE

### 鈶?瑁?Git for Windows

鏈満鐩墠**娌¤ git**銆備换閫変竴绉嶏細

    winget install --id Git.Git -e

鑻?winget 涓嬭浇澶辫触锛圙itHub 鐩磋繛缁忓父瓒呮椂锛夛紝鐢ㄩ暅鍍忎笅瀹夎鍖咃細

    # 鐢?Python 璧伴暅鍍忎笅杞斤紝鍐嶆妸 exe 瑁呬笂
    python -c "import urllib.request;urllib.request.urlretrieve('https://ghproxy.net/https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe', 'Git-2.51.0-64-bit.exe')"

瑁呭畬纭锛歚git --version`

---

## 绗?1 姝ワ細鍙戝竷鍓嶈嚜妫€锛?*姣忔鍙戝竷閮借鍋?*锛?
    cd <浣犵殑浠撳簱鐩綍>

    # 1) 绀惧尯鍚嶅崟闂ㄧ
    node tools/sanitize.js check data/catalog.json

    # 2) 纭娌℃湁涓汉闅愮 / 濯掍綋鏂囦欢娣疯繘鏉ワ紙搴旇緭鍑?0锛?    node -e "const{execSync}=require('child_process');" 
    # 鎵嬪伐妫€鏌ユ洿鐩磋锛氫笅闈袱鏉℃槸閲嶇偣
    dir /s /b | findstr /i "璁板綍 澶囦唤 .sqlite .mp4 .mp3"
    findstr /s /i /r /m "[A-Za-z]:\\" *.js *.md *.json

    # 3) 鐪?git 浼氭彁浜や粈涔堬紙鍏抽敭涓€姝ワ級
    git status --short

**缁濅笉鍏佽鎻愪氦鐨勫唴瀹?*锛歚璁板綍/`銆乣澶囦唤/`銆乣*.sqlite`銆乣*.mp4/*.mp3`銆乣dist-native/`銆?`build*/`銆佷换浣曞惈鏈満璺緞鎴栫敤鎴峰悕鐨勬枃浠讹紙`.gitignore` 宸茶鐩栵紝浣嗘瘡娆′粛瑕佺溂鐪嬩竴閬嶏級

---

## 绗?2 姝ワ細濉帀涓夊鍗犱綅绗?
| 鏂囦欢 | 甯搁噺 | 鏀规垚 |
| --- | --- | --- |
| `repo/source/local-service/midi/community-catalog.js` | `CATALOG_URL` | `https://raw.githubusercontent.com/<浣犵殑璐﹀彿>/<浠撳簱鍚?/main/data/catalog.json` |
| `repo/source/local-service/public/listen-naming-feedback.js` | `REPO` | `<浣犵殑璐﹀彿>/<浠撳簱鍚?` |
| `repo/source/local-service/server.js` 鎴栬缃腑鐨勬洿鏂颁粨搴?| `updateRepository` | `<浣犵殑璐﹀彿>/<浠撳簱鍚?` |

鏀瑰畬鎼滀竴閬嶇‘璁ゆ病鏈夋畫鐣欙細

    findstr /s /i /m "<owner>/<repo>" *.js

---

## 绗?3 姝ワ細寤轰粨搴撳苟棣栨鎺ㄩ€?
    cd <浣犵殑浠撳簱鐩綍>
    git init
    git add .
    git status --short          # 鍐嶇‘璁や竴閬嶆病鏈夐殣绉佹枃浠?    git commit -m "Initial commit: OliviaSoul 鏇插悕璇嗗埆鍒嗘敮锛?008.2.7-linli9-g01锛?
    git branch -M main
    git remote add origin https://github.com/<浣犵殑璐﹀彿>/<浠撳簱鍚?.git
    git push -u origin main

> 浠撳簱鎻忚堪閲屽缓璁啓娓?闈炲畼鏂圭涓夋柟鍒嗘敮锛屼粎渚涘涔犱氦娴?锛屼笌 README 椤堕儴澹版槑涓€鑷淬€?
---

## 绗?4 姝ワ細鎵撳寘锛堜骇鍑?EXE锛?
    cd repo\source\local-service
    npm install
    powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-release.ps1 -Iscc "<Inno Setup 瀹夎鐩綍>\ISCC.exe" -OutputDirectory <浣犵殑浠撳簱鐩綍>\repo\build-final

浜х墿鍦?`build-final\`锛?
    OliviaSoul-2008.2.7-linli9-g01-Setup.exe     鈫?瀹夎鍖?    OliviaSoul-2008.2.7-linli9-g01-Portable.zip  鈫?鍏嶅畨瑁呯増
    SHA256SUMS.txt                               鈫?鏍￠獙鍜?
**娉ㄦ剰**锛氳剼鏈嫆缁濆啓鍏ラ潪绌虹洰褰曪紝姣忔鍙戝竷鎹竴涓柊鐨?`-OutputDirectory`銆?
---

## 绗?5 姝ワ細鍙?Release锛?*鍛藉悕鏈夌‖瑕佹眰**锛?
鍦?GitHub 浠撳簱 鈫?Releases 鈫?Draft a new release锛?
| 椤?| 瑕佹眰 |
| --- | --- |
| **Tag** | `2008.2.7-linli9-g01`锛堜笅娆?`g02`锛?|
| **Target** | `main` |
| **Title** | 渚嬪 `2008.2.7-linli9-g01` |
| **璇存槑** | 鍐欐竻鏈鏀逛簡浠€涔堬紱棣栨鍙戝竷鍔犱笂"涓婃父鏈０鏄庤鍙瘉锛屽凡鑾蜂綔鑰呮巿鏉冿紙瑙?docs/鎺堟潈瀛樻。锛? |
| **闄勪欢** | 涓婁紶 Setup.exe銆丳ortable.zip銆丼HA256SUMS.txt |
| **鈿狅笍 Pre-release** | **涓嶈鍕?* 鉁?鍕句簡绋嬪簭鐨勮嚜鍔ㄦ洿鏂板氨璇讳笉鍒帮紙瀹冨彧鏌?`/releases/latest`锛?|
| **鈿狅笍 璧勪骇鍚?* | 蹇呴』鍖归厤 `OliviaSoul-*-Setup.exe` 鉁?鍚﹀垯鏇存柊鍣ㄦ壘涓嶅埌瀹夎鍖咃紙鎵撳寘鑴氭湰浜у嚭鐨勫悕瀛楀ぉ鐒剁鍚堬級 |

---

## 绗?6 姝ワ細浠ュ悗姣忔璺熻繘涓婃父

1. 鎷夊彇涓婃父鏀瑰姩骞跺悎骞讹紙鎴戜滑鍙敼浜?`server.js` 涓?`public/index.html` 涓や釜涓婃父鏂囦欢锛屽啿绐侀潰寰堝皬锛?2. **鏀圭増鏈彿 4 澶?*锛歚package.json`銆乣package-lock.json`锛? 澶勶級銆乣native-host/OliviaSoul.csproj` 鐨?`<Version>`銆乣build-release.ps1` 閲岀殑 `$version`
   锛坄AssemblyVersion` / `FileVersion` 蹇呴』淇濇寔绾暟瀛楋紝濡?`2008.2.7.0`锛?3. 閲嶈窇绗?1 姝ヨ嚜妫€ 鈫?绗?4 姝ユ墦鍖?鈫?绗?5 姝ュ彂 Release锛坱ag 鎹㈡垚 `g02`锛?
---

## 闄勶細鍙彂宸紓鐗堬紙鑻ユ湭鑾锋巿鏉冿級

鍙妸**浣犳柊澧炵殑鏂囦欢**鍗曠嫭寤轰竴涓粨搴撳叕寮€锛屼娇鐢ㄨ€呰嚜琛屼笌涓婃父浠ｇ爜缁勫悎锛?
    midi/listen-naming.js  midi/time-of-day.js  midi/community-catalog.js
    midi/fingerprint.js    midi/dependency-check.js  midi/logs.js
    public/listen-naming.js  public/listen-naming-tools.js
    public/listen-naming-feedback.js  public/dependency-check.js
    public/legal-notices.js  public/logs-page.js
    tools/  data/  docs/  鏇茬洰鍚嶅崟鏍煎紡.md  鍏嶈矗澹版槑.md  闅愮璇存槑.md  寮€婧愯蒋浠跺０鏄?md

骞跺湪 README 閲屽啓鏄庨渶瑕佽嚜琛屾帴鍏ョ殑 5 澶勶紙椤电銆侀潰鏉裤€佽剼鏈紩鐢ㄣ€侀潤鎬佺櫧鍚嶅崟銆佽矾鐢辨寕杞斤級銆