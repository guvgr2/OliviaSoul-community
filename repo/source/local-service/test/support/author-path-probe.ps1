# 包内「作者绝对路径」护栏的探针（给 test/package-author-path.test.js 用，不单独跑）。
#
# 2026-10-19 第四轮审查 · 包内作者路径核查 §6-3：`E:\olivia-soul-community-kit\...`
# 这类作者本机目录曾随 1.2.3 包发出，而**没有任何东西会红**。护栏加在
# package-safety.ps1 的 Assert-PackageTextContent 里，这里验两件事：
#   ① Get-PackageAuthorPathHits 的命中/误报边界；
#   ② 它**真的被接进了内容扫描**（直接调 Assert-PackageTextContent 看会不会抛）
#      —— 只验函数本身的话，「忘了调用」这种写法照样全绿。
$ErrorActionPreference = 'Stop'

$safety = Join-Path $PSScriptRoot '..\..\packaging\package-safety.ps1'
. (Resolve-Path $safety)

$samples = @(
    'E:/olivia-soul-community-kit/repo/source',   # 0 作者本仓库路径 —— 必须命中
    'E:\linli-letters\app\harness',               # 1 姊妹仓库路径 —— 必须命中
    'C:\Program Files\OliviaSoul-community',      # 2 装机后真实存在的系统目录 —— 放行
    'C:\Windows\System32\x.dll',                  # 3 放行
    'C:\Users\Public\Music',                      # 4 放行
    'X:\OliviaSoul',                              # 5 文档占位盘符 —— 放行
    'const re = /[A-Za-z]:[\\/]/; let s = "\s*"; let d = 3:\d+', # 6 JS 正则字面量 —— 放行（裸匹配会假红上百处）
    'https://api.deepseek.com/v1',                # 7 URL 里的 :// —— 放行
    'D:\pagefile.sys 16384 40960',                # 8 用户自己配的页面文件，任何盘符都放行
    "E:\我的文件夹\repo\source"                    # 9 中文目录 —— 必须命中（首段非 ASCII 那条分支）
)

for ($i = 0; $i -lt $samples.Count; $i++) {
    $hits = @(Get-PackageAuthorPathHits -Text $samples[$i])
    Write-Output ("S{0};{1};{2}" -f $i, $hits.Count, ($hits -join '|'))
}

# ② 接线验证：走真实的内容扫描入口
function Test-Wired([string]$Text) {
    try {
        Assert-PackageTextContent -Text $Text -RelativePath 'fixture.txt'
        return 'NO-THROW'
    } catch {
        if ($_.Exception.Message -like '*AUTHOR_PATH*') { return 'AUTHOR_PATH' }
        return ('OTHER:' + $_.Exception.Message)
    }
}
Write-Output ('WIRED-LEAK;' + (Test-Wired -Text 'E:/olivia-soul-community-kit/repo/source/harness'))
Write-Output ('WIRED-CLEAN;' + (Test-Wired -Text 'hello world, nothing to see here'))
