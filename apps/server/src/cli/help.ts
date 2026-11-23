import { defaultConfigDir } from "../config";
import { defaultLifetimeDays } from "../devices";
import { defaultPluginsDir, defaultStateDir } from "./args";

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
      Preview the permissions for an unpacked plugin. Repeat with the displayed
      digest to save the grants.

  aphelion plugin update ID [--approve DIGEST] [--state-dir DIR]
                         [--plugins-dir DIR]
      Check the GitHub repository that plugin ID names for a newer release,
      check that GitHub built it, and preview what it changes. Repeat with the
      displayed digest to install it and restart the plugin on it.

  aphelion plugin rollback ID [--state-dir DIR] [--plugins-dir DIR]
      Go back to the version plugin ID ran before its last update or install,
      and restart the plugin on it.

  aphelion plugin dev FOLDER [--state-dir DIR]
      Reload the approved plugin in FOLDER through the running server, then
      reload it again each time its files change. Works only when the server
      runs with --plugin-dev FOLDER. Ctrl-C stops watching.

  aphelion --version
  aphelion --help

--config-dir is ${defaultConfigDir}, --state-dir is ${defaultStateDir} and
--plugins-dir is ${defaultPluginsDir} unless given.`;
