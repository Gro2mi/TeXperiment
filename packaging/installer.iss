; Inno Setup script: per-user installer for the TeXperiment desktop app.
; Built by packaging/build.ps1 / CI with the version passed as /DVERSION.

#define MyAppName "TeXperiment"
#ifndef VERSION
#define VERSION "0.1.0"
#endif

[Setup]
AppId={{7A1F2E5B-8C3D-4E9A-B6F0-52D7A1C4E8B2}
AppName={#MyAppName}
AppVersion={#VERSION}
AppVerName={#MyAppName} {#VERSION}
AppPublisher={#MyAppName}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
; per-user install: no admin rights, no UAC prompt
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=TeXperimentSetup-{#VERSION}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\TeXperiment.exe
CloseApplications=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\TeXperiment\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\TeXperiment.exe"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\TeXperiment.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"
Name: "texassoc"; Description: "Associate &.tex files with {#MyAppName}"; GroupDescription: "Other tasks:"

[Registry]
; per-user (HKCU) file association — no admin needed
Root: HKCU; Subkey: "Software\Classes\TeXperiment.tex"; ValueType: string; ValueData: "TeXperiment LaTeX document"; Flags: uninsdeletekey; Tasks: texassoc
Root: HKCU; Subkey: "Software\Classes\TeXperiment.tex\DefaultIcon"; ValueType: string; ValueData: "{app}\TeXperiment.exe,0"; Tasks: texassoc
Root: HKCU; Subkey: "Software\Classes\TeXperiment.tex\shell\open\command"; ValueType: string; ValueData: """{app}\TeXperiment.exe"" ""%1"""; Tasks: texassoc
Root: HKCU; Subkey: "Software\Classes\.tex\OpenWithProgids"; ValueType: string; ValueName: "TeXperiment.tex"; ValueData: ""; Flags: uninsdeletevalue; Tasks: texassoc
Root: HKCU; Subkey: "Software\Classes\.tex"; ValueType: string; ValueName: ""; ValueData: "TeXperiment.tex"; Flags: uninsdeletevalue; Tasks: texassoc

[Run]
Filename: "{app}\TeXperiment.exe"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; user data (~/.texperiment: settings, projects registry, dictionaries,
; tectonic bundle cache) is intentionally left in place across updates
; and uninstalls.
