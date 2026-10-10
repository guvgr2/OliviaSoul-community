# Provider-neutral OpenAI-compatible model transport. PowerShell 5.x.
# Dot-source this file, call Import-ModelConfig once, then Invoke-ModelChat.

$script:ModelUtf8NoBom = New-Object System.Text.UTF8Encoding $false

function Read-ModelEnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($rawLine in [IO.File]::ReadAllLines((Resolve-Path -LiteralPath $Path).Path, $script:ModelUtf8NoBom)) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
        $separator = $line.IndexOf("=")
        if ($separator -le 0) { continue }
        $values[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
    }
    return $values
}

function Get-ModelValue {
    param(
        [hashtable]$Primary,
        [string]$PrimaryName,
        [hashtable]$Legacy,
        [string]$LegacyName,
        [string]$Default
    )
    if ($Primary.ContainsKey($PrimaryName)) { return [string]$Primary[$PrimaryName] }
    if ($Legacy -and $LegacyName -and $Legacy.ContainsKey($LegacyName)) { return [string]$Legacy[$LegacyName] }
    $environmentValue = $null
    if ($LegacyName) { $environmentValue = [Environment]::GetEnvironmentVariable($LegacyName) }
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) { return $environmentValue }
    return $Default
}

function Assert-ModelSingleLine {
    param([string]$Value, [string]$Label)
    if ($Value -match "[`r`n]") { throw "$Label cannot contain newlines" }
    return $Value.Trim()
}

function Test-MaxTokensUnsupported {
    param([string]$Detail)
    # 与 model-transport.js 的 unsupportedMaxTokens 对齐：只有厂商明确在说「这个参数名不认」时才换名，
    # 普通 400（内容太长、字段非法）不能乱换，否则会把真正的错误掩盖成另一次失败。
    if ([string]::IsNullOrWhiteSpace($Detail)) { return $false }
    if ($Detail -match 'max_completion_tokens') { return $true }
    if ($Detail -match 'max_tokens' -and $Detail -match 'unsupported_parameter|unsupported parameter|unknown parameter|unrecognized|not supported|不支持|无法识别|未知参数|不允许|不支援') { return $true }
    return $false
}

function Import-ModelFamilyTable {
    # B2（2026-10-09 复审）：家族判定的唯一真相源是 local-service/model-families.json。
    # 以前这里和 model-config.js 各写一份正则，PS 侧只认 deepseek/glm ⇒ 探测（JS）通过、真写信却走厂商默认。
    # 查找顺序：① 打包时复制过来的同目录副本（安装态在 UserData\.cursor\skills\fit-letters\scripts\）；
    #           ② 仓库开发态的相对路径 repo\source\local-service\model-families.json。
    $candidates = @(
        (Join-Path $PSScriptRoot "model-families.json"),
        (Join-Path $PSScriptRoot "..\..\..\..\local-service\model-families.json")
    )
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $parsed = ([IO.File]::ReadAllText((Resolve-Path $candidate).Path, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop)
        $families = @($parsed.families)
        if ($families.Count -eq 0) { throw "model-families.json 里没有 families" }
        $script:ModelFamilies = $families
        return
    }
    # TODO(B2)：正常打包一定带这份 JSON（build-release.ps1 已复制 + 门禁套件断言两边一致）。
    # 走到这里说明是老版本升级残留：先退回 deepseek/glm 两条老规则保证写信能用，
    # 正确做法是程序启动时把缺失的 model-families.json 补进 UserData\.cursor\skills\fit-letters\scripts\。
    Write-Warning "model-families.json 没找到，写信将退回内置的 deepseek/glm 老规则（Kimi / 豆包会失去厂商专用参数）"
    $script:ModelFamilies = @(
        [pscustomobject]@{ name = "deepseek"; pattern = '(?:^|/)deepseek(?:[-/]|$)'; effort = "high"; canDisable = $true },
        [pscustomobject]@{ name = "glm"; pattern = '(?:^|/)(?:glm|chatglm|zhipu)(?:[-/]|$)'; effort = "max"; canDisable = $false }
    )
}

function Get-ModelFamily {
    param([Parameter(Mandatory = $true)][string]$Model)
    if ([string]::IsNullOrWhiteSpace($Model)) { return $null }
    foreach ($family in $script:ModelFamilies) {
        $pattern = [string]$family.pattern
        if ([string]::IsNullOrWhiteSpace($pattern)) { continue }
        # JS 的 pattern 带 u 标志（Unicode）；这些 pattern 全是 ASCII，.NET 用 IgnoreCase 等价。
        if ([regex]::IsMatch($Model, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { return $family }
    }
    return $null
}

function Import-ModelConfig {
    param([Parameter(Mandatory = $true)][string]$Root)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Import-ModelFamilyTable
    $secrets = Join-Path $Root ".cursor\secrets"
    $config = Read-ModelEnvFile -Path (Join-Path $secrets "model.env")
    $legacy = Read-ModelEnvFile -Path (Join-Path $secrets "deepseek.env")
    $provider = Get-ModelValue -Primary $config -PrimaryName "MODEL_ACTIVE_PROVIDER" -Legacy $null -LegacyName "" -Default "deepseek"
    $provider = Assert-ModelSingleLine -Value $provider -Label "provider"
    if ($provider -notin @("deepseek", "local")) { throw "provider must be deepseek or local" }

    if ($provider -eq "deepseek") {
        $prefix = "MODEL_DEEPSEEK"
        $defaultBase = "https://api.deepseek.com"
        $defaultModel = "deepseek-flash"
        $defaultAuth = "bearer"
        $legacyBase = "DEEPSEEK_BASE"
        $legacyModel = "DEEPSEEK_MODEL"
        $legacyKey = "DEEPSEEK_API_KEY"
    }
    else {
        $prefix = "MODEL_LOCAL"
        $defaultBase = "http://127.0.0.1:8000/v1"
        $defaultModel = "local-model"
        $defaultAuth = "none"
        $legacyBase = ""
        $legacyModel = ""
        $legacyKey = ""
    }

    $base = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_BASE") -Legacy $legacy -LegacyName $legacyBase -Default $defaultBase
    $model = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_MODEL") -Legacy $legacy -LegacyName $legacyModel -Default $defaultModel
    $authMode = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_AUTH_MODE") -Legacy $null -LegacyName "" -Default $defaultAuth
    $apiKey = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_API_KEY") -Legacy $legacy -LegacyName $legacyKey -Default ""
    # B1（2026-10-09 复审）：写信必须自己给输出预算。智谱 / 火山方舟的「最大回答」官方默认只有 4k，
    # 而推理 token 与正文共享这份预算 ⇒ 回信稍长就 finish_reason=length ⇒ Get-ModelFinalText 抛
    # "model did not produce complete text"，整封回信直接失败。默认 32768 对智谱（128k）与 DeepSeek（384K）都安全；
    # 想改可在 UserData\.cursor\secrets\model.env 里加 MODEL_DEEPSEEK_MAX_TOKENS / MODEL_LOCAL_MAX_TOKENS 覆盖。
    # ⚠️ 只能靠默认值保守：PS 侧没有 model-transport.js 那种 max_tokens → max_completion_tokens 回退，值超限会被 400 拒。
    $maxTokensRaw = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_MAX_TOKENS") -Legacy $null -LegacyName "" -Default "32768"
    $maxTokensRaw = Assert-ModelSingleLine -Value ([string]$maxTokensRaw) -Label "max tokens"
    $maxTokensValue = 0
    if (-not [int]::TryParse($maxTokensRaw, [ref]$maxTokensValue) -or $maxTokensValue -le 0) { throw "max tokens must be a positive integer" }
    $base = Assert-ModelSingleLine -Value $base -Label "model base URL"
    $model = Assert-ModelSingleLine -Value $model -Label "model name"
    $authMode = Assert-ModelSingleLine -Value $authMode -Label "auth mode"
    $apiKey = Assert-ModelSingleLine -Value $apiKey -Label "API key"
    if ([string]::IsNullOrWhiteSpace($model)) { throw "model name cannot be empty" }
    if ($authMode -notin @("bearer", "none")) { throw "auth mode must be bearer or none" }
    if ($authMode -eq "bearer" -and [string]::IsNullOrWhiteSpace($apiKey)) { throw "Bearer authentication requires an API key" }
    $parsed = $null
    if (-not [Uri]::TryCreate($base, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -notin @("http", "https")) {
        throw "model base URL must use http or https"
    }
    if ($parsed.UserInfo -or $parsed.Query -or $parsed.Fragment) { throw "model URL must not contain credentials, query or fragment" }
    if ($parsed.AbsolutePath.TrimEnd('/') -match '/(messages|responses)$') { throw "only Chat Completions endpoints are supported" }
    $base = $base.TrimEnd('/') -replace '/chat/completions$', ''

    $script:ModelProvider = $provider
    $script:ModelUri = $base.TrimEnd("/") + "/chat/completions"
    $script:ModelName = $model
    $script:ModelAuthMode = $authMode
    $script:ModelKey = $apiKey
    # B3（2026-10-09 复审）：写信默认开思考，推理 token 按输出单价计费。
    # 用 model.env 的 MODEL_THINKING=on|off 控制（默认 on，保持原有行为）；原来只有 harness-4step.ps1
    # 的 -NoThink 开关能动它，而 harness-live.ps1 从不传这个开关 ⇒ 实际上永远开着、关不掉。
    $thinkingRaw = Get-ModelValue -Primary $config -PrimaryName "MODEL_THINKING" -Legacy $null -LegacyName "" -Default "on"
    $thinkingRaw = (Assert-ModelSingleLine -Value ([string]$thinkingRaw) -Label "MODEL_THINKING").ToLowerInvariant()
    if ($thinkingRaw -notin @("on", "off")) { throw "MODEL_THINKING must be on or off" }
    $script:ModelThinking = ($thinkingRaw -eq "on")
    $script:ModelMaxTokens = $maxTokensValue
    $script:ModelLastFinishReason = ""
    $script:ModelLastUsage = $null
}

function Set-ModelThinking {
    param([Parameter(Mandatory = $true)][bool]$On)
    $script:ModelThinking = $On
}

function Set-ModelName {
    param([Parameter(Mandatory = $true)][string]$Model)
    if ([string]::IsNullOrWhiteSpace($Model)) { throw "model name cannot be empty" }
    $script:ModelName = $Model.Trim()
}

function ConvertTo-ModelBodyText {
    param($Value)
    if ($Value -is [string]) { return $Value }
    $text = New-Object Text.StringBuilder
    if ($Value -is [array]) {
        foreach ($part in $Value) {
            if ($part -is [string]) { [void]$text.Append($part) }
            elseif ($part.type -cin @('text', 'output_text') -and $part.text -is [string]) { [void]$text.Append($part.text) }
        }
    }
    return $text.ToString()
}

function Get-ModelFinalText {
    param($Payload)
    if ($Payload.error) { throw 'model response error' }
    $choice = @($Payload.choices)[0]
    if ($choice.finish_reason -in @('length', 'content_filter')) { throw 'model did not produce complete text' }
    $text = ConvertTo-ModelBodyText $choice.message.content
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    $text = ConvertTo-ModelBodyText $choice.text
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    $text = ConvertTo-ModelBodyText $Payload.output_text
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    $parts = @($Payload.output | Where-Object { -not $_.type -or $_.type -ceq 'message' } | ForEach-Object { $_.content })
    $text = ConvertTo-ModelBodyText $parts
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    throw ("{0} returned empty content (final text required)" -f $script:ModelProvider)
}

function ConvertFrom-ModelJson {
    param([string]$Raw)
    try { return ($Raw.TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'model returned invalid JSON' }
}

function ConvertFrom-ModelResponse {
    param([string]$Raw, [string]$ContentType)
    if ($ContentType -notmatch 'text/event-stream') {
        $response = ConvertFrom-ModelJson $Raw
        $choice = @($response.choices)[0]
        $script:ModelLastFinishReason = [string]$choice.finish_reason
        $script:ModelLastUsage = $response.usage
        return Get-ModelFinalText $response
    }
    $text = New-Object Text.StringBuilder
    $ended = $false
    $script:ModelLastFinishReason = ''
    $script:ModelLastUsage = $null
    $normalized = $Raw.TrimStart([char]0xFEFF) -replace "`r`n?", "`n"
    foreach ($event in ($normalized -split "`n`n")) {
        $lines = @($event -split "`n" | Where-Object { $_.StartsWith('data:') } | ForEach-Object { $_.Substring(5) -replace '^ ', '' })
        $data = $lines -join "`n"
        if (-not $data) { continue }
        if ($data.Trim() -ceq '[DONE]') { $ended = $true; break }
        $payload = ConvertFrom-ModelJson $data
        if ($payload.error) { throw 'model stream returned error' }
        if ($payload.usage) { $script:ModelLastUsage = $payload.usage }
        $choice = @($payload.choices | Where-Object { $_.index -eq 0 })[0]
        if (-not $choice) { $choice = @($payload.choices)[0] }
        if (-not $choice) { continue }
        $part = $choice.delta.content
        if ($null -eq $part) { $part = $choice.message.content }
        if ($null -eq $part) { $part = $choice.text }
        [void]$text.Append((ConvertTo-ModelBodyText $part))
        if ($choice.finish_reason) { $script:ModelLastFinishReason = [string]$choice.finish_reason; $ended = $true }
    }
    if (-not $ended) { throw 'model stream interrupted before completion' }
    if ($script:ModelLastFinishReason -in @('length', 'content_filter')) { throw 'model stream did not produce complete text' }
    if ([string]::IsNullOrWhiteSpace($text.ToString())) { throw ("{0} returned empty content (final text required)" -f $script:ModelProvider) }
    return $text.ToString().Trim()
}

function Read-ModelResponseBody {
    param($Response)
    $stream = $Response.GetResponseStream()
    $buffer = New-Object byte[] 8192
    $memory = New-Object IO.MemoryStream
    try {
        while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($memory.Length + $count -gt 8388608) { throw 'model response exceeds 8 MiB' }
            $memory.Write($buffer, 0, $count)
        }
        return $script:ModelUtf8NoBom.GetString($memory.ToArray())
    }
    finally { $stream.Dispose(); $memory.Dispose() }
}

function Invoke-ModelChatOnce {
    param(
        [Parameter(Mandatory = $true)][string]$System,
        [Parameter(Mandatory = $true)][string]$User,
        # B1 后续：预算字段名。个别中转站 / 新版接口不认 max_tokens，会回 400 要求改用
        # max_completion_tokens（model-transport.js 的 JS 侧早就有这条回退，PS 侧一直缺）。
        [string]$MaxTokensField = "max_tokens"
    )
    $payload = @{
        model = $script:ModelName
        stream = $false
        $MaxTokensField = $script:ModelMaxTokens
        messages = @(
            @{ role = "system"; content = $System }
            @{ role = "user"; content = $User }
        )
    }
    # B2：家族判定读 model-families.json（与 JS 侧 model-config.js 同一份真相源），不再各写一份正则。
    $family = $null
    if ($script:ModelProvider -eq "deepseek") { $family = Get-ModelFamily -Model $script:ModelName }
    if ($family) {
        if ($family.topLevelEffort) {
            # kimi-k3：始终推理，只认顶层 reasoning_effort，发 thinking 会被拒。
            $payload.reasoning_effort = [string]$family.effort
        }
        elseif ($family.noThinkingParam) {
            # kimi-k2.7-*：传 thinking 会报错 ⇒ 什么都不发（始终思考由厂商托管）。
        }
        else {
            $thinkingEnabled = $true
            if ($family.canDisable) { $thinkingEnabled = $script:ModelThinking }
            if ($family.thinkingOnly) {
                if ($thinkingEnabled) { $payload.thinking = @{ type = "enabled" } } else { $payload.thinking = @{ type = "disabled" } }
            }
            elseif ($thinkingEnabled) {
                $payload.thinking = @{ type = "enabled" }
                if (-not [string]::IsNullOrWhiteSpace([string]$family.effort)) { $payload.reasoning_effort = [string]$family.effort }
            }
            else {
                $payload.thinking = @{ type = "disabled" }
            }
        }
    }
    $bytes = $script:ModelUtf8NoBom.GetBytes(($payload | ConvertTo-Json -Depth 8 -Compress))
    try {
        $request = [Net.HttpWebRequest]::Create($script:ModelUri)
        $request.Method = "POST"
        $request.ContentType = "application/json; charset=utf-8"
        $request.Accept = "application/json"
        $request.AllowAutoRedirect = $false
        $request.Timeout = 500000
        $request.ReadWriteTimeout = 500000
        if ($script:ModelAuthMode -eq "bearer") {
            [void]$request.Headers.Add("Authorization", "Bearer " + $script:ModelKey)
        }
        $requestStream = $request.GetRequestStream()
        $requestStream.Write($bytes, 0, $bytes.Length)
        $requestStream.Close()
        $httpResponse = $request.GetResponse()
        try {
            if ([int]$httpResponse.StatusCode -ge 300) { throw 'model endpoint redirect is not supported' }
            $contentType = $httpResponse.ContentType
            $raw = Read-ModelResponseBody $httpResponse
        }
        finally { $httpResponse.Close() }
    }
    catch {
        $webException = $_.Exception
        if ($webException.InnerException -is [Net.WebException]) { $webException = $webException.InnerException }
        if ($webException -is [Net.WebException] -and $webException.Response) {
            $status = [int]$webException.Response.StatusCode
            $detail = ""
            try {
                $errorStream = $webException.Response.GetResponseStream()
                if ($errorStream) {
                    $reader = New-Object IO.StreamReader($errorStream, [Text.Encoding]::UTF8)
                    $detail = $reader.ReadToEnd()
                    $reader.Dispose()
                }
            }
            catch { }
            $webException.Response.Close()
            if ($status -eq 400 -and $MaxTokensField -ne "max_completion_tokens" -and (Test-MaxTokensUnsupported -Detail $detail)) {
                return Invoke-ModelChatOnce -System $System -User $User -MaxTokensField "max_completion_tokens"
            }
            throw ("{0} HTTP {1}" -f $script:ModelProvider, $status)
        }
        throw ("{0} request failed" -f $script:ModelProvider)
    }
    return ConvertFrom-ModelResponse -Raw $raw -ContentType $contentType
}

function Invoke-ModelChat {
    param(
        [Parameter(Mandatory = $true)][string]$System,
        [Parameter(Mandatory = $true)][string]$User
    )
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            return Invoke-ModelChatOnce -System $System -User $User
        }
        catch {
            $message = $_.Exception.Message
            $retryable =
                $message -match "returned empty content" -or
                $message -match "HTTP (408|409|425|429|5\d\d)" -or
                $message -match "request failed"
            if (-not $retryable -or $attempt -eq 3) { throw }
            Write-Host ("MODEL RETRY provider={0} attempt={1}" -f $script:ModelProvider, ($attempt + 1))
            Start-Sleep -Seconds ([Math]::Pow(2, $attempt - 1))
        }
    }
}
