// A desktop notification, best effort and fire-and-forget: a toast on Windows (through the
// PowerShell that ships with it), notify-send on Linux / Steam Deck when it is installed.
// Anything that goes wrong is ignored; the terminal bell the menu also rings is the fallback.
import { spawn } from 'node:child_process';

// Toast with the AppID Windows PowerShell is registered under, so Windows shows it without
// the app having to register one. Title and text travel in the environment, never in the script.
const WIN_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02')
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:WFE_NOTIFY_TITLE)) | Out-Null
$text.Item(1).AppendChild($xml.CreateTextNode($env:WFE_NOTIFY_BODY)) | Out-Null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

export function desktopNotify(title: string, body: string): void {
  try {
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_SCRIPT], {
        env: { ...process.env, WFE_NOTIFY_TITLE: title, WFE_NOTIFY_BODY: body }, stdio: 'ignore', windowsHide: true,
      })
      : process.platform === 'linux'
        ? spawn('notify-send', ['--app-name=WoW Forever Essentials Updater', title, body], { stdio: 'ignore' })
        : null;
    child?.on('error', () => {});
    child?.unref();
  } catch {
    // no notification is not worth an error
  }
}
