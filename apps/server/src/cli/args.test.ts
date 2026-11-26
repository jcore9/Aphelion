import { describe, expect, test } from "vitest";
import { defaultConfigDir } from "../config";
import {
  defaultPluginsDir,
  defaultStateDir,
  defaultToolsDir,
  parseCommandLine,
} from "./args";

const accepted = (argv: string[]) => {
  const result = parseCommandLine(argv);
  if (!result.ok) throw new Error(result.message);
  return result.command;
};

const refused = (argv: string[]) => {
  const result = parseCommandLine(argv);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(result.command)}`);
  return result.message;
};

describe("accepted command lines", () => {
  test.each([
    [[], { kind: "help" }],
    [["--help"], { kind: "help" }],
    [["-h"], { kind: "help" }],
    [["device", "add", "--help"], { kind: "help" }],
    [["--help", "--unknown"], { kind: "help" }],
    [["--version"], { kind: "version" }],
    [
      ["--headless"],
      {
        kind: "headless",
        configDir: defaultConfigDir,
        stateDir: defaultStateDir,
        pluginRunnerFds: undefined,
        pluginDev: undefined,
      },
    ],
    [
      ["--headless", "--config-dir", "/c", "--state-dir=/s"],
      {
        kind: "headless",
        configDir: "/c",
        stateDir: "/s",
        pluginRunnerFds: undefined,
        pluginDev: undefined,
      },
    ],
    [
      ["--headless", "--plugin-runner-fds", "3,4"],
      {
        kind: "headless",
        configDir: defaultConfigDir,
        stateDir: defaultStateDir,
        pluginRunnerFds: { replies: 3, requests: 4 },
        pluginDev: undefined,
      },
    ],
    [
      [
        "--headless",
        "--plugin-runner-fds",
        "3,4",
        "--plugin-dev",
        "/opt/aphelion/dev-plugin",
      ],
      {
        kind: "headless",
        configDir: defaultConfigDir,
        stateDir: defaultStateDir,
        pluginRunnerFds: { replies: 3, requests: 4 },
        pluginDev: "/opt/aphelion/dev-plugin",
      },
    ],
    [
      ["plugin", "update", "weather"],
      {
        kind: "plugin update",
        stateDir: defaultStateDir,
        pluginsDir: defaultPluginsDir,
        plugin: "weather",
        approve: undefined,
      },
    ],
    [
      [
        "plugin",
        "update",
        "weather",
        "--approve",
        "abc",
        "--plugins-dir",
        "/p",
      ],
      {
        kind: "plugin update",
        stateDir: defaultStateDir,
        pluginsDir: "/p",
        plugin: "weather",
        approve: "abc",
      },
    ],
    [
      ["plugin", "install", "/srv/weather", "--plugins-dir", "/p"],
      {
        kind: "plugin install",
        stateDir: defaultStateDir,
        pluginsDir: "/p",
        folder: "/srv/weather",
        approve: undefined,
      },
    ],
    [
      ["plugin", "restart", "weather", "--state-dir", "/s"],
      { kind: "plugin restart", stateDir: "/s", plugin: "weather" },
    ],
    [
      ["plugin", "rollback", "weather", "--state-dir", "/s"],
      {
        kind: "plugin rollback",
        stateDir: "/s",
        pluginsDir: defaultPluginsDir,
        plugin: "weather",
      },
    ],
    [["tool", "list"], { kind: "tool list", toolsDir: defaultToolsDir }],
    [
      ["tool", "install", "claude", "--tools-dir", "/t", "--state-dir", "/s"],
      {
        kind: "tool install",
        stateDir: "/s",
        toolsDir: "/t",
        name: "claude",
      },
    ],
    [
      ["tool", "remove", "opencode"],
      {
        kind: "tool remove",
        stateDir: defaultStateDir,
        toolsDir: defaultToolsDir,
        name: "opencode",
      },
    ],
    [
      ["tool", "update"],
      {
        kind: "tool update",
        stateDir: defaultStateDir,
        toolsDir: defaultToolsDir,
      },
    ],
    [
      ["tool", "update", "codex", "--tools-dir", "/t", "--state-dir", "/s"],
      { kind: "tool update", stateDir: "/s", toolsDir: "/t", name: "codex" },
    ],
    [["tool", "check"], { kind: "tool check" }],
    [
      ["plugin", "dev", "/opt/aphelion/dev-plugin"],
      {
        kind: "plugin dev",
        stateDir: defaultStateDir,
        folder: "/opt/aphelion/dev-plugin",
      },
    ],
    [
      ["config", "check"],
      {
        kind: "config check",
        configDir: defaultConfigDir,
        stateDir: defaultStateDir,
        compose: undefined,
      },
    ],
    [
      ["config", "check", "--compose", "-"],
      {
        kind: "config check",
        configDir: defaultConfigDir,
        stateDir: defaultStateDir,
        compose: "-",
      },
    ],
    [
      ["device", "add", "my laptop"],
      {
        kind: "device add",
        stateDir: defaultStateDir,
        name: "my laptop",
        days: undefined,
      },
    ],
    [
      ["device", "add", "phone", "--days", "365"],
      {
        kind: "device add",
        stateDir: defaultStateDir,
        name: "phone",
        days: 365,
      },
    ],
    [["device", "list"], { kind: "device list", stateDir: defaultStateDir }],
    [
      ["plugin", "enable", "weather"],
      {
        kind: "plugin enable",
        stateDir: defaultStateDir,
        plugin: "weather",
        approve: undefined,
      },
    ],
    [
      ["plugin", "enable", "weather", "--approve", "abc"],
      {
        kind: "plugin enable",
        stateDir: defaultStateDir,
        plugin: "weather",
        approve: "abc",
      },
    ],
    [
      ["restore", "finish"],
      { kind: "restore finish", stateDir: defaultStateDir },
    ],
    [
      ["restore", "finish", "--state-dir", "/data"],
      { kind: "restore finish", stateDir: "/data" },
    ],
    [
      ["device", "revoke", "0123456789abcdef"],
      {
        kind: "device revoke",
        stateDir: defaultStateDir,
        id: "0123456789abcdef",
      },
    ],
  ])("%j", (argv, command) => {
    expect(accepted(argv)).toEqual(command);
  });
});

describe("refused command lines", () => {
  test.each([
    [["bogus"], 'unknown command "bogus"'],
    [["device"], 'unknown command "device"'],
    [["device", "remove", "x"], 'unknown command "device remove"'],
    [
      ["--headless", "config", "check"],
      '"headless" takes no arguments, but got 2',
    ],
    [["--version", "--headless"], '--headless isn\'t an option of "version"'],
    [["--headless", "--days", "3"], '--days isn\'t an option of "headless"'],
    [
      ["config", "check", "--days", "3"],
      '--days isn\'t an option of "config check"',
    ],
    [
      ["device", "list", "--config-dir", "/c"],
      '--config-dir isn\'t an option of "device list"',
    ],
    [["device", "add"], '"device add" needs a name'],
    [["device", "add", "a", "b"], '"device add" takes one name, but got 2'],
    [
      [
        "device",
        "revoke",
        "0123456789abcdef",
        "aph_dev_0123456789abcdef_secret",
      ],
      '"device revoke" takes one id, but got 2',
    ],
    [["aph_dev_0123456789abcdef_secret"], "unknown command"],
    [
      ["device", "add", "x", "--days", "0", "--days", "30"],
      "--days is given twice",
    ],
    [["device", "list", "--state-dir="], "--state-dir can't be empty"],
    [["config", "check", "--config-dir", ""], "--config-dir can't be empty"],
    [
      ["device", "add", " laptop"],
      "the device name must be 1 to 64 characters",
    ],
    [
      ["device", "add", "x", "--days", "0"],
      "--days must be a whole number of days from 1 to 365",
    ],
    [
      ["device", "add", "x", "--days", "366"],
      "--days must be a whole number of days from 1 to 365",
    ],
    [
      ["device", "add", "x", "--days", "1.5"],
      "--days must be a whole number of days",
    ],
    [["device", "revoke", "laptop"], "the device id must be 16 hex digits"],
    [["--nope"], "unknown option --nope"],
    [["device", "revoke", "--aph_dev_0123456789abcdef_x"], "unknown option"],
    [["config", "check", "--compose"], "--compose needs a value"],
    [
      ["--headless", "--plugin-runner-fds", "3"],
      "--plugin-runner-fds must be two file descriptor numbers, such as 3,4",
    ],
    [
      ["--headless", "--plugin-runner-fds", "0,1"],
      "--plugin-runner-fds must name descriptors from 3 up",
    ],
    [
      ["--headless", "--plugin-runner-fds", "3,3"],
      "--plugin-runner-fds must name two different descriptors",
    ],
    [
      ["--headless", "--plugin-dev", "dev-plugin"],
      "--plugin-dev must be an absolute path",
    ],
    [["plugin", "dev"], '"plugin dev" needs a folder'],
    [["tool", "install"], '"tool install" needs a tool name'],
    [
      ["tool", "install", "gemini"],
      "the tool name must be claude, codex, grok or opencode",
    ],
    [
      ["tool", "list", "--state-dir", "/s"],
      '--state-dir isn\'t an option of "tool list"',
    ],
    [
      ["tool", "update", "gemini"],
      "the tool name must be claude, codex, grok or opencode",
    ],
    [
      ["tool", "update", ""],
      "the tool name must be claude, codex, grok or opencode",
    ],
    [
      ["tool", "update", "claude", "codex"],
      '"tool update" takes no more than one tool name, but got 2',
    ],
    [["tool", "check", "claude"], '"tool check" takes no arguments, but got 1'],
    [
      ["tool", "check", "--tools-dir", "/t"],
      '--tools-dir isn\'t an option of "tool check"',
    ],
    [
      ["tool", "remove", "claude", "--tools-dir", "tools"],
      "--tools-dir must be an absolute path",
    ],
    [["plugin", "rollback"], '"plugin rollback" needs a plugin id'],
    [
      ["plugin", "rollback", "weather", "--approve", "abc"],
      '--approve isn\'t an option of "plugin rollback"',
    ],
    [
      ["plugin", "dev", "/a", "--plugin-dev", "/a"],
      '--plugin-dev isn\'t an option of "plugin dev"',
    ],
    [
      ["config", "check", "--plugin-runner-fds", "3,4"],
      '--plugin-runner-fds isn\'t an option of "config check"',
    ],
  ])("%j", (argv, message) => {
    expect(refused(argv)).toContain(message);
    expect(refused(argv)).not.toContain("aph_dev_");
  });
});
