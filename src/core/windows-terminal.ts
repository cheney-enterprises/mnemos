/**
 * Windows Terminal fragment installer.
 *
 * When mnemos bridge runs on Windows, this installs:
 *   1. mnemos-icon.svg → %APPDATA%\mnemos\mnemos-icon.svg
 *   2. A WT fragment  → %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\mnemos\mnemos.json
 *
 * The fragment adds an "Mnemos" profile to Windows Terminal with the Mnemos circle icon,
 * so any user who installs mnemos gets the branded tab automatically.
 *
 * Non-fatal: if anything fails (non-Windows, WT not installed, permissions) we log
 * a warning and continue. Never block the bridge install.
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to assets/mnemos-icon.svg inside the package. */
function getPackageIconPath(): string {
  // __dirname is dist/core/ at runtime; assets/ is two levels up
  return path.resolve(__dirname, "..", "..", "assets", "mnemos-icon.svg");
}

/** %APPDATA%\mnemos\mnemos-icon.svg */
function getInstalledIconPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "mnemos", "mnemos-icon.svg");
}

/** %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\mnemos\mnemos.json */
function getFragmentPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Microsoft", "Windows Terminal", "Fragments", "mnemos", "mnemos.json");
}

function buildFragment(iconPath: string): object {
  return {
    $help: "https://aka.ms/terminal-documentation",
    $schema: "https://aka.ms/terminal-profiles-schema#fragment",
    profiles: [
      {
        name: "Mnemos",
        icon: iconPath,
        // Use the system's default shell — we're branding the tab, not changing the shell.
        commandline: process.env.COMSPEC ?? "cmd.exe",
        startingDirectory: "%USERPROFILE%",
        hidden: false,
      },
    ],
  };
}

export interface WindowsTerminalInstallResult {
  installed: boolean;
  iconPath?: string;
  fragmentPath?: string;
  skipped?: string;
  error?: string;
}

export async function installWindowsTerminalProfile(): Promise<WindowsTerminalInstallResult> {
  if (process.platform !== "win32") {
    return { installed: false, skipped: "not Windows" };
  }

  try {
    const srcIcon = getPackageIconPath();
    const dstIcon = getInstalledIconPath();
    const fragmentPath = getFragmentPath();

    // Verify source icon exists (it's bundled in the package)
    try {
      await fs.access(srcIcon);
    } catch {
      return { installed: false, error: `Source icon not found at ${srcIcon}` };
    }

    // Copy icon to %APPDATA%\mnemos\
    await fs.mkdir(path.dirname(dstIcon), { recursive: true });
    await fs.copyFile(srcIcon, dstIcon);

    // Write the WT fragment
    await fs.mkdir(path.dirname(fragmentPath), { recursive: true });
    const fragment = buildFragment(dstIcon);
    await fs.writeFile(fragmentPath, JSON.stringify(fragment, null, 2), "utf-8");

    return { installed: true, iconPath: dstIcon, fragmentPath };
  } catch (err) {
    return { installed: false, error: String(err) };
  }
}

export async function uninstallWindowsTerminalProfile(): Promise<WindowsTerminalInstallResult> {
  if (process.platform !== "win32") {
    return { installed: false, skipped: "not Windows" };
  }

  try {
    const fragmentPath = getFragmentPath();
    await fs.rm(fragmentPath, { force: true });
    // Leave the icon in place — it's harmless and avoids re-copy on reinstall.
    return { installed: false, fragmentPath };
  } catch (err) {
    return { installed: false, error: String(err) };
  }
}
