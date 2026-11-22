import { defaultConfigDir } from "../config";
import { defaultLifetimeDays } from "../devices";
import { defaultStateDir } from "./args";

export const helpText = `Aphelion server and command line

Usage:
  aphelion --headless [--config-dir DIR] [--state-dir DIR]
      Start the server. The container runs this.

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

  aphelion --version
  aphelion --help

--config-dir is ${defaultConfigDir} and --state-dir is ${defaultStateDir} unless given.`;
