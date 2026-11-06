; Script Inno Setup — Vacuum Desktop (Windows x64)
; Compilé par scripts/build-setup.js (qui passe AppVersion et SourceDir).

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\win-unpacked"
#endif

#define AppName "Vacuum Desktop"
#define AppExe "Vacuum Desktop.exe"
#define AppPublisher "Vacuum"
; Anciennes versions (BetterYoutube Desktop, ReTube), désinstallées automatiquement en gardant les données
#define OldAppId "{6C1F5B8E-3D2A-4B7C-9E41-B7D0A2F35C91}"
#define OldAppId2 "{A3E2C7D4-58B1-4F0E-9C6A-2D7F1B9E4A60}"

[Setup]
AppId={{E7B94F21-6C3D-4A85-B1F0-9D2E5C8A7B34}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Installation par utilisateur par défaut (pas besoin d'admin), avec choix "pour tous" possible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=VacuumDesktop-Setup-{#AppVersion}-x64
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
; English by default; the language dialog lets the user pick another one
ShowLanguageDialog=yes
LanguageDetectionMethod=none

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[CustomMessages]
english.CreateDesktopIcon=Create a desktop shortcut
english.LaunchApp=Launch {#AppName}
english.RemoveData=Also delete your data (YouTube sign-in, settings, cache)?
french.CreateDesktopIcon=Créer une icône sur le Bureau
french.LaunchApp=Lancer {#AppName}
french.RemoveData=Supprimer aussi vos données (connexion YouTube, paramètres, cache) ?
spanish.CreateDesktopIcon=Crear un acceso directo en el escritorio
spanish.LaunchApp=Abrir {#AppName}
spanish.RemoveData=¿Borrar también tus datos (sesión de YouTube, ajustes, caché)?
german.CreateDesktopIcon=Desktop-Verknüpfung erstellen
german.LaunchApp={#AppName} starten
german.RemoveData=Auch deine Daten löschen (YouTube-Anmeldung, Einstellungen, Cache)?
italian.CreateDesktopIcon=Crea un collegamento sul desktop
italian.LaunchApp=Avvia {#AppName}
italian.RemoveData=Eliminare anche i tuoi dati (accesso a YouTube, impostazioni, cache)?
brazilianportuguese.CreateDesktopIcon=Criar um atalho na área de trabalho
brazilianportuguese.LaunchApp=Abrir o {#AppName}
brazilianportuguese.RemoveData=Apagar também seus dados (login do YouTube, configurações, cache)?

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM ""{#AppExe}"""; Flags: runhidden; RunOnceId: "KillApp"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM yt-dlp.exe"; Flags: runhidden; RunOnceId: "KillYtdlp"

[Code]
function OldUninstaller(Root: Integer; Id: String): String;
var S: String;
begin
  Result := '';
  if RegQueryStringValue(Root, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + Id + '_is1', 'UninstallString', S) then
    Result := RemoveQuotes(S);
end;

procedure RemoveOld(Id: String);
var U: String; Code: Integer;
begin
  U := OldUninstaller(HKCU, Id);
  if U = '' then U := OldUninstaller(HKLM, Id);
  if (U <> '') and FileExists(U) then
    Exec(U, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function AppLanguageCode(): String;
begin
  case ActiveLanguage() of
    'french': Result := 'fr';
    'spanish': Result := 'es';
    'german': Result := 'de';
    'italian': Result := 'it';
    'brazilianportuguese': Result := 'pt-BR';
  else
    Result := 'en';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    RemoveOld('{#OldAppId}');
    RemoveOld('{#OldAppId2}');
  end;
  // The language picked in the installer becomes the app's default language
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\resources\install-language'), AppLanguageCode(), False);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{userappdata}\{#AppName}');
    if DirExists(DataDir) and not UninstallSilent then
      if MsgBox(CustomMessage('RemoveData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
