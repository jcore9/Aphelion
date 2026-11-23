# Write your first server plugin

In this guide you build a small Aphelion plugin and run it on your own Aphelion server. You start from a template that already works, run its tests, build it, and then edit it while it runs. Each edit reloads the plugin, and you don't restart the server.

A server plugin is a program that Aphelion starts and stops for you. It gets only the permissions that you approve. [Running plugins on the server](../reference/plugins.md) describes how that works. The template hides the details, so you don't need to read that page first.

## What you need

- [Bun](https://bun.sh), the tool that installs packages, runs the tests and builds the plugin.
- A checkout of the Aphelion repository. Run `bun install` in it once.
- For the last steps, an Aphelion server that you [installed on this machine](install.md), with `sudo` rights.

You can do the first steps without a server. The tests run on their own.

## What this guide leaves out

The server doesn't send any events yet. The template subscribes to `approval.requested`, which the server will send in a later milestone. Until then the plugin starts, subscribes and waits. The tests show what it does when an event arrives. You can't see an event arrive on a running server yet.

## Create the plugin

1. In your Aphelion checkout, run the generator. Give it a folder that doesn't exist yet, outside the checkout.

   ```sh
   bun run create:plugin ~/hello-plugin
   ```

   You should see `Created hello-plugin in ` and the path. The last part of the path becomes the plugin's id. To pick another id, add `--id my-plugin`.

2. Go to the new folder, and install its packages.

   ```sh
   cd ~/hello-plugin
   bun install
   ```

   The folder is standalone. It has its own copy of the plugin SDK in `vendor/`, packed from your checkout. You can move the folder anywhere. Keep `vendor/` with it. [Decision 0051](../decisions/0051-plugin-dev-kit.md) says why the SDK isn't downloaded from a package registry.

## Look at the plugin

Open `src/plugin.ts`:

```ts
import type { ServerPlugin } from "@aphelion/plugin-sdk";

export default {
  async start(ctx) {
    ctx.log("plugin started");
    await ctx.events.subscribe("approval.requested", (data) => {
      ctx.log(`an approval was requested: ${JSON.stringify(data)}`);
    });
  },
} satisfies ServerPlugin;
```

The plugin is one object with one function, `start`. Aphelion calls `start` after it starts your plugin. The argument `ctx` is the plugin's connection to Aphelion:

- `ctx.log(text)` writes one line to Aphelion's log.
- `ctx.events.subscribe(name, handler)` asks Aphelion to send you an event. Aphelion calls the handler each time the event happens. It refuses the request when your manifest doesn't list the event or the owner didn't grant it.
- `ctx.network.get(url)` and `ctx.secrets.use(operation, reference)` are the other two things a plugin can ask for. This plugin uses neither. Both need a permission in the manifest, and a plugin never sees the value of a secret ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)).

A manifest is the file `aphelion-plugin.json`. It names the plugin and lists the permissions it asks for. Yours asks to receive `approval.requested`:

```json
{
  "id": "hello-plugin",
  "version": "0.1.0",
  "api": "^0.2.1",
  "server": { "entry": "dist/server.mjs" },
  "permissions": { "events": ["approval.requested"] }
}
```

The other file you don't need to touch is `src/index.ts`. It connects your plugin to Aphelion through standard input and output, the two channels that Aphelion uses to talk to the plugin. [The plugin manifest](../reference/plugin-manifest.md) lists every manifest field.

## Run the tests

Open `src/plugin.test.ts`. It runs your plugin against `createTestHost`, a fake Aphelion in the SDK. The fake follows the same rules as the real one, so a test can show that a plugin without a grant is refused. The template has two tests. One grants the event and checks the log. The other grants nothing and checks that `start` fails with error `-32001`, `Not granted`.

1. Run the tests.

   ```sh
   bun run test
   ```

   You should see `Tests  2 passed (2)`.

2. Run the type check.

   ```sh
   bun run typecheck
   ```

   It prints no errors.

## Build the plugin

1. Build.

   ```sh
   bun run build
   ```

   You should see `Bundled` and a line for `server.mjs`.

2. List the result.

   ```sh
   ls dist
   ```

   You should see `aphelion-plugin.json` and `server.mjs`.

`dist/` is the folder Aphelion runs. It holds the whole plugin, so it needs no `node_modules`. The build writes `dist/aphelion-plugin.json` from your manifest, and sets `server.entry` to `server.mjs`.

## Start Aphelion in dev mode

Dev mode lets you replace a running plugin without restarting the server. It is off in a normal install. You turn it on for one folder, and Aphelion shows that folder inside the container as `/opt/aphelion/dev-plugin`, read-only.

Aphelion refuses to run a plugin from a folder that the plugin could change. The plugin runner checks this on every start. For the files in `dist/`, it means two things:

- No file or folder may belong to user id `10004`, the `aphelion-plugins` user.
- User `10004` must not be able to write to any file or folder. Files that you create as yourself and that other users can't write to are fine.

The [plugin reference](../reference/plugins.md#how-your-plugin-is-started) lists every check.

1. Add two lines to the server's settings file. Replace the path with the absolute path to your `dist/` folder.

   ```sh
   sudo tee -a /opt/aphelion/deploy/.env <<'EOF'
   APHELION_PLUGIN_DEV_DIR=/home/you/hello-plugin/dist
   COMPOSE_FILE=compose.yaml:compose.plugin-dev.yaml
   EOF
   ```

   `COMPOSE_FILE` is the same as running `docker compose -f compose.yaml -f compose.plugin-dev.yaml`. The second file is the dev override. It mounts your folder and turns dev mode on.

2. Restart the service. Run every `docker compose` command from `/opt/aphelion/deploy`.

   ```sh
   sudo systemctl restart aphelion
   cd /opt/aphelion/deploy
   ```

3. Check the log.

   ```sh
   sudo journalctl -u aphelion --since "2 minutes ago" | grep "plugin dev mode is on"
   ```

   You should see a line with `plugin dev mode is on`. If you don't, the override didn't load. Check `.env` for a typo.

To go back to a normal install, delete the two lines from `.env` and restart the service.

## Approve the plugin

Aphelion starts a plugin only after you approve its permissions. Approve the folder once. Run the command without `--approve` first, to preview the permissions.

```sh
sudo docker compose exec -T --user harness aphelion aphelion plugin install /opt/aphelion/dev-plugin
```

You should see the plugin's name and a line that starts with `events` and names `"approval.requested"`, then a line that ends with `--approve` and a long hexadecimal number. Run the command again, with the whole number in place of `<number>` and no angle brackets.

```sh
sudo docker compose exec -T --user harness aphelion aphelion plugin install /opt/aphelion/dev-plugin --approve <number>
```

You should see `Plugin permissions saved.`

## Watch the folder

1. Start `plugin dev`. It asks the server to start your plugin, and then asks again each time a file in the folder changes.

   ```sh
   sudo docker compose exec --user harness aphelion aphelion plugin dev /opt/aphelion/dev-plugin
   ```

   You should see `Watching /opt/aphelion/dev-plugin.` and then `Reloaded hello-plugin: running`.

2. In a second terminal, look at the server's log. You should see the plugin's `plugin started` line.

   ```sh
   sudo journalctl -u aphelion -f | grep "plugin started"
   ```

3. In a third terminal, in `~/hello-plugin`, start the watcher.

   ```sh
   bun run watch
   ```

   It builds once, and then builds again each time a file in `src/` changes.

4. Change the text in `src/plugin.ts`, for example `"plugin started"` to `"plugin started again"`, and save the file.

   Within a second or two, the build output shows a new build. Then `plugin dev` prints `Reloaded hello-plugin: running` once more, and the second terminal shows the new line. The server didn't restart.

Press Ctrl-C in the `plugin dev` terminal to stop watching. The plugin keeps running under the server. A restart of the service starts it again, because it stays approved.

## When the manifest changes

An approval covers one exact manifest. Suppose you add a permission or change the version in `aphelion-plugin.json`, then build. `bun run watch` copies the manifest only when it starts. Run `bun run build` to copy it. Then `plugin dev` prints a refusal that says `hello-plugin stays stopped: the manifest changed since it was approved`, and the plugin stops.

1. Run the two `plugin install` commands again, to preview and then approve.
2. Change a file, for example with `touch ~/hello-plugin/dist/server.mjs`. `plugin dev` reloads only after a change, not when you approve.

## If something is refused

| `plugin dev` prints | Why | What to do |
| --- | --- | --- |
| `Plugin dev mode is off` | The server has no dev socket. | Check the first steps in [Start Aphelion in dev mode](#start-aphelion-in-dev-mode). |
| `dev mode reloads only /opt/aphelion/dev-plugin` | You gave another folder. | Use the folder from the override. |
| `isn't approved` | You haven't approved the folder yet. | Run the two `plugin install` commands. |
| `stays stopped` | The manifest changed since you approved it, or it isn't valid JSON or a valid manifest. | See [When the manifest changes](#when-the-manifest-changes). |
| `Reloaded hello-plugin: crashed` | The plugin exited, or the runner refused the folder, for example because user `10004` can write to it. | Read the server log with `sudo journalctl -u aphelion`. |

## Next

- [The plugin API reference](../reference/plugin-api.md) lists every type and function that the SDK exports, such as `PluginContext` and `createTestHost`.
- [The plugin reference](../reference/plugins.md) lists the messages between Aphelion and a plugin, the errors, and what a crash does.
- [Dev mode](../reference/plugins.md#dev-mode) and [`aphelion plugin dev`](../reference/cli.md#aphelion-plugin-dev-folder) describe the socket and the command exactly.
- To run a finished plugin on a server, copy `dist/` to `/opt/aphelion/deploy/plugins/<name>` as root and follow [Install a plugin](install.md#install-a-plugin).
