#define AppVersion GetEnv("OLIVIA_SOUL_VERSION")
#define StageDir GetEnv("OLIVIA_SOUL_STAGE")
#define OutputDir GetEnv("OLIVIA_SOUL_OUTPUT")

[Setup]
AppId={{70CB4313-7339-4EF0-87ED-E9D45A67B952}
AppName=OliviaSoul-community
AppVersion={#AppVersion}
AppPublisher=Olivia Soul
DefaultDirName={code:GetDefaultDir}
DefaultGroupName=OliviaSoul-community
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=OliviaSoul-{#AppVersion}-Setup
SetupIconFile={#StageDir}\app-v9.ico
UninstallDisplayIcon={app}\app-v9.ico
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
ShowLanguageDialog=yes
LanguageDetectionMethod=uilanguage
UsePreviousLanguage=yes
DisableDirPage=no
DisableWelcomePage=no
CloseApplications=yes
RestartApplications=no
AppMutex=Local\OliviaSoul.SingleInstance

[Languages]
Name: "english"; MessagesFile: "{#StageDir}\installer\English.isl"
Name: "chinesesimplified"; MessagesFile: "{#StageDir}\installer\ChineseSimplified.isl"

[Messages]
chinesesimplified.WelcomeLabel2=此向导将安装 [name/ver]。%n%n安装前请退出游戏和 OliviaSoul。升级时建议先备份 UserData，并选择原安装目录；无需先卸载旧版。%n%n请勿将本软件安装到游戏目录或盘符根目录。
english.WelcomeLabel2=This wizard will install [name/ver].%n%nClose the game and OliviaSoul first. When upgrading, back up UserData and use the existing installation folder; uninstalling the old version is not required.%n%nDo not install into the game folder or a drive root.
chinesesimplified.SelectDirDesc=选择 OliviaSoul 的安装位置。
english.SelectDirDesc=Choose where to install OliviaSoul.
chinesesimplified.SelectDirLabel3=请选择独立、可写的安装目录。升级时请沿用原安装目录。
english.SelectDirLabel3=Choose a separate, writable folder. For upgrades, use the existing installation folder.
chinesesimplified.FinishedLabel=OliviaSoul 已安装完成。%n%n首次使用请先启动 OliviaSoul，在“客户端与桌面”选择游戏并启用服务，再启动游戏。
english.FinishedLabel=OliviaSoul has been installed.%n%nBefore first use, start OliviaSoul, select the game and enable the service under Client & Desktop, then start the game.

[CustomMessages]
chinesesimplified.RestoreGameRunning=请先完全退出游戏后重试。
english.RestoreGameRunning=Fully exit the game, then try again.
chinesesimplified.RestoreSteamRunning=请先完全退出 Steam 后重试。
english.RestoreSteamRunning=Fully exit Steam, then try again.
chinesesimplified.RestoreBackupInvalid=客户端原始备份缺失或无法验证。请保留 UserData 和备份并联系支持。
english.RestoreBackupInvalid=The original client backup is missing or could not be verified. Keep UserData and backups, and contact support.
chinesesimplified.RestorePathInvalid=已登记的客户端路径不可访问。请恢复原安装路径后重试。
english.RestorePathInvalid=The registered client path is inaccessible. Restore the original installation path, then try again.
chinesesimplified.RestoreTargetChanged=客户端文件或 Steam 启动项后来发生了变化。为避免覆盖您的修改，卸载已停止。
english.RestoreTargetChanged=Client files or Steam launch options have changed. Uninstall was stopped to avoid overwriting your changes.
chinesesimplified.RestoreIncomplete=安全恢复未完成。请保留 Olivia Soul、UserData 和备份并联系支持。
english.RestoreIncomplete=Safe restoration did not complete. Keep Olivia Soul, UserData and backups, and contact support.
chinesesimplified.RestoreRequired=卸载前必须恢复所有已登记且仍启用的客户端补丁（FE/WebPlayer/支持的 DLL）以及严格匹配的 Steam 启动项。任一项失败都会中止卸载；Olivia Soul、UserData、恢复工具和备份均会保留，源视频和 usersettings.dat 不会被删除或修改。
english.RestoreRequired=All registered active client patches (FE/WebPlayer/supported DLLs) and exactly matching Steam launch options must be restored before uninstalling. Any failure stops uninstall. Olivia Soul, UserData, recovery tools and backups are retained; source videos and usersettings.dat are not deleted or modified.
chinesesimplified.RestoreNoResult=卸载前必须恢复所有已登记且仍启用的客户端补丁（FE/WebPlayer/支持的 DLL）以及严格匹配的 Steam 启动项。安全恢复失败，卸载已中止；Olivia Soul、UserData、恢复工具和备份均会保留，源视频和 usersettings.dat 不会被删除或修改。请查看卸载日志后重试。
english.RestoreNoResult=Client patches and exactly matching Steam launch options must be restored before uninstalling. Safe restoration failed and uninstall was stopped. Olivia Soul, UserData, recovery tools and backups are retained; source videos and usersettings.dat are not deleted or modified. Check the uninstall log and try again.
chinesesimplified.StartupCleanupFailed=客户端资源已恢复，但 Olivia Soul 开机启动任务清理失败。卸载已中止；Olivia Soul、UserData、恢复工具和备份尚未删除，源视频和 usersettings.dat 不会被删除或修改。请重试。
english.StartupCleanupFailed=Client resources were restored, but removing the Olivia Soul startup task failed. Uninstall was stopped. Olivia Soul, UserData, recovery tools and backups are retained; source videos and usersettings.dat are not deleted or modified. Please try again.

chinesesimplified.WebView2Required=注意：Microsoft Edge WebView2 运行时是本程序运行的【必要依赖】。%n%n如果系统里没有，安装程序会自动为你安装（需要联网，约 1 分钟）；若自动安装失败，请到微软官网搜索 "WebView2 Runtime" 手动安装后再启动本程序。
english.WebView2Required=Notice: Microsoft Edge WebView2 Runtime is a REQUIRED dependency.%n%nIf it is missing, this installer will install it automatically (needs internet, about a minute). If that fails, please install "WebView2 Runtime" from Microsoft, then start the app.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
Type: filesandordirs; Name: "{app}\resources\workspace-template\.cursor\rules"
Type: files; Name: "{app}\resources\workspace-template\harness\00-strict-precheck.md"
Type: files; Name: "{app}\resources\workspace-template\harness\00-脚本算术.md"
Type: files; Name: "{app}\resources\workspace-template\harness\02-读信感.md"
Type: files; Name: "{app}\resources\workspace-template\harness\06-实时回信.md"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Olivia Soul"; Filename: "{app}\OliviaSoul.exe"; IconFilename: "{app}\app-v9.ico"; AppUserModelID: "OliviaSoul.Desktop.9"
Name: "{autodesktop}\Olivia Soul"; Filename: "{app}\OliviaSoul.exe"; IconFilename: "{app}\app-v9.ico"; AppUserModelID: "OliviaSoul.Desktop.9"; Tasks: desktopicon

[Run]
; WebView2 运行时是必要依赖：缺失时自动静默安装
Filename: "{app}\redist\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "{cm:WebView2Required}"; Flags: waituntilterminated; Check: WebView2Missing
Filename: "{app}\OliviaSoul.exe"; Description: "{cm:LaunchProgram,Olivia Soul}"; Flags: nowait postinstall skipifsilent

[Code]
function IsDriveRoot(Path: String): Boolean;
var
  Drive: String;
  Normalized: String;
begin
  Drive := ExtractFileDrive(Path);
  Normalized := RemoveBackslashUnlessRoot(Path);
  Result := (Drive <> '') and (CompareText(Normalized, AddBackslash(Drive)) = 0);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Selected: String;
begin
  Result := True;
  if CurPageID <> wpSelectDir then
    exit;
  Selected := WizardDirValue;
  if Length(Selected) = 1 then
    Selected := Selected + ':\'
  else if (Length(Selected) = 2) and (Selected[2] = ':') then
    Selected := Selected + '\';
  if IsDriveRoot(Selected) then
    WizardForm.DirEdit.Text := AddBackslash(Selected) + 'OliviaSoul';
end;

function RestoreFailureHint(Code: AnsiString): String;
begin
  if Code = 'GAME_RUNNING' then
    Result := CustomMessage('RestoreGameRunning')
  else if Code = 'STEAM_RUNNING' then
    Result := CustomMessage('RestoreSteamRunning')
  else if Code = 'BACKUP_INVALID' then
    Result := CustomMessage('RestoreBackupInvalid')
  else if Code = 'PATH_INVALID' then
    Result := CustomMessage('RestorePathInvalid')
  else if Code = 'TARGET_CHANGED' then
    Result := CustomMessage('RestoreTargetChanged')
  else
    Result := CustomMessage('RestoreIncomplete');
end;

function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
  RestoreSucceeded: Boolean;
  DisableSucceeded: Boolean;
  RestoreResultPath: String;
  RestoreDetail: AnsiString;
begin
  Result := False;
  RestoreResultPath := ExpandConstant('{tmp}\OliviaSoul-uninstall-restore.json');
  DeleteFile(RestoreResultPath);
  { Client files may have been patched by an earlier elevated mount. Request }
  { elevation only for the synchronous, fail-closed restore helper. }
  RestoreSucceeded := ShellExec('runas', ExpandConstant('{app}\runtime\node.exe'), '"' + ExpandConstant('{app}\app\desktop\uninstall-restore.js') + '" --user-data "' + ExpandConstant('{app}\UserData') + '" --result-file "' + RestoreResultPath + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if (not RestoreSucceeded) then
  begin
    if LoadStringFromFile(RestoreResultPath, RestoreDetail) then
      MsgBox(CustomMessage('RestoreRequired') + #13#10 + #13#10 + RestoreFailureHint(RestoreDetail), mbError, MB_OK)
    else
      MsgBox(CustomMessage('RestoreNoResult'), mbError, MB_OK);
    exit;
  end;
  DeleteFile(RestoreResultPath);
  DisableSucceeded := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\app\desktop\startup-task.ps1') + '" -Mode Disable', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if (not DisableSucceeded) then
  begin
    MsgBox(CustomMessage('StartupCleanupFailed'), mbError, MB_OK);
    exit;
  end;
  Result := True;
end;

{ -------------------- 必要依赖：Microsoft Edge WebView2 运行时 -------------------- }
function WebView2Missing(): Boolean;
var
  installedVersion: String;
begin
  Result := True;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', installedVersion) and (installedVersion <> '') then
    Result := False
  else if RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', installedVersion) and (installedVersion <> '') then
    Result := False;
end;

{ 装完文件后，若依赖仍缺失（自动安装失败/无网络），明确告知用户这是必要依赖 }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WebView2Missing() then
    MsgBox(ExpandConstant('{cm:WebView2Required}'), mbInformation, MB_OK);
end;

{ ---------------- 升级检测：已装过旧版就问用户，选“不升级”则中止安装 ---------------- }
var
  ExistingDir: String;
  UpgradeMode: Boolean;

function ExistingInstallDir(): String;
var
  value: String;
begin
  Result := '';
  { 1) 先查本程序自己的卸载注册项（Inno 会写入 InstallLocation） }
  if (RegQueryStringValue(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{70CB4313-7339-4EF0-87ED-E9D45A67B952}_is1', 'InstallLocation', value) and (value <> '')) then
    Result := RemoveBackslashUnlessRoot(value);
  if (Result = '') and (RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{70CB4313-7339-4EF0-87ED-E9D45A67B952}_is1', 'InstallLocation', value) and (value <> '')) then
    Result := RemoveBackslashUnlessRoot(value);
  { 2) 再查几个常见安装位置 }
  if (Result = '') and FileExists(ExpandConstant('{localappdata}\Programs\OliviaSoul\OliviaSoul.exe')) then
    Result := ExpandConstant('{localappdata}\Programs\OliviaSoul');
end;

{ 安装目录：检测到旧版就默认用它（原地升级，UserData 自然保留） }
function GetDefaultDir(Param: String): String;
begin
  if ExistingDir <> '' then Result := ExistingDir else Result := ExpandConstant('{autopf}\\OliviaSoul-community');
end;

function InitializeSetup(): Boolean;
var
  message: String;
begin
  ExistingDir := ExistingInstallDir();
  Result := True;
  if ExistingDir = '' then Exit;

  message := '检测到电脑中已经安装过 OliviaSoul：' + #13#10 + '    ' + ExistingDir + #13#10 + #13#10 +
             '是否升级到新版本？' + #13#10 + #13#10 +
               '· 选"是"：装到上面这个原目录，只替换程序文件。' + #13#10 +
               '  你的数据（UserData：曲库记录、命名、设置、信件等）由新程序直接继承，不需要迁移或导入。' + #13#10 +
             '· 选择“否”：退出安装程序，不做任何改动。' + #13#10 + #13#10 +
             '建议升级前先备份一份 UserData 文件夹。';
  if MsgBox(message, mbConfirmation, MB_YESNO) = IDYES then
    UpgradeMode := True
  else begin
    MsgBox('已取消安装，未对现有程序做任何改动。', mbInformation, MB_OK);
    Result := False;   { 中止安装，安装程序随即关闭 }
  end;
end;
