import { defaultConfigDir } from "../config";
import { defaultLifetimeDays } from "../devices";
import { defaultPluginsDir, defaultStateDir, defaultToolsDir } from "./args";

export const helpText = `Aphelion server and command line

Usage:
  aphelion --headless [--config-dir DIR] [--state-dir DIR]
                      [--plugin-runner-fds REPLIES,REQUESTS]
                      [--plugin-dev FOLDER]
      Start the server. The container runs this. With --plugin-runner-fds,
      the server reads the plugin runner's replies on descriptor REPLIES,
      writes its requests on REQUESTS, and starts every installed plugin.
      With --plugin-dev, the server also lets plugin dev reload the approved
      plugin in FOLDER.

  aphelion config check [--config-dir DIR] [--state-dir DIR] [--compose FILE]
      Check the config files, the modes of both folders and, with --compose,
      the ports a Compose file publishes. FILE is the output of
      docker compose --profile '*' config, or - to read it from standard input.

  aphelion device add NAME [--days DAYS] [--state-dir DIR]
      Add a device and print its token once. DAYS is from 1 to 365,
      ${String(defaultLifetimeDays)} by default.

  aphelion device list [--state-dir DIR]
      List devices and whether each token is active, expired or revoked.

  aphelion device revoke ID [--state-dir DIR]
      Stop a device's token at once.

  aphelion plugin install FOLDER [--approve DIGEST] [--state-dir DIR]
                          [--plugins-dir DIR]
      Preview the permissions for an unpacked plugin. Repeat with the displayed
      digest to save the grants. FOLDER can't be a folder that plugin update
      manages in --plugins-dir.

  aphelion plugin update ID [--approve DIGEST] [--state-dir DIR]
                         [--plugins-dir DIR]
      Check the GitHub repository that plugin ID names for a newer release,
      check that GitHub built it, and preview what it changes. Repeat with the
      displayed digest to install it and restart the plugin on it.

  aphelion plugin enable ID [--approve DIGEST] [--state-dir DIR]
      Switch a plugin back on after a restore switched it off. Prints the
      permissions the plugin already has, then switches it on and restarts it
      when repeated with the displayed digest.

  aphelion plugin rollback ID [--state-dir DIR] [--plugins-dir DIR]
      Go back to the version plugin ID ran before its last update or install,
      and restart the plugin on it.

  aphelion plugin restart ID [--state-dir DIR]
      Ask the running server to restart plugin ID on its approved version.

  aphelion plugin dev FOLDER [--state-dir DIR]
      Reload the approved plugin in FOLDER through the running server, then
      reload it again each time its files change. Works only when the server
      runs with --plugin-dev FOLDER. Ctrl-C stops watching.

  aphelion tool list [--tools-dir DIR]
      List the AI tools on Aphelion's list. A tab-separated table of the name,
      the pinned version, whether it is installed, unavailable on this
      processor or not installed, and the command that checks its sign-in.

  aphelion tool install NAME [--state-dir DIR] [--tools-dir DIR]
      Download the pinned build of an AI tool from the list, check it against
      the list's SHA-256 and size, and install it. Running it again for the
      installed version changes nothing.

  aphelion tool remove NAME [--state-dir DIR] [--tools-dir DIR]
      Remove an installed AI tool. Its sign-in stays in the bots volume.

  aphelion restore finish [--state-dir DIR]
      Run once after restoring a backup, before the server starts. Revokes
      every device token, switches every plugin off, and lists the commands
      that switch the plugins back on.

  aphelion --version
  aphelion --help

--config-dir is ${defaultConfigDir}, --state-dir is ${defaultStateDir},
--plugins-dir is ${defaultPluginsDir} and --tools-dir is ${defaultToolsDir} unless given.`;
