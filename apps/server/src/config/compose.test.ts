import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checkComposePorts,
  checkServerListener,
  composeListener,
} from "./compose";
import { formatIssue } from "./issues";

const fix =
  'Publish it only on the host\'s tailnet address, such as "100.71.226.67:7400:7400" (decision 0022).';

function check(text: string, serverPort?: number): string[] {
  return checkComposePorts("compose.yaml", text, serverPort).map(formatIssue);
}

const serverFile = "/etc/aphelion/server.yaml";

function listener(address: string, port: number): string[] {
  return checkServerListener(serverFile, { address, port }).map(formatIssue);
}

const addressRefusal = (found: string) =>
  `${serverFile}: address: is ${found}. With --compose it must be ${composeListener.address}, so a published port can reach the server inside the container.`;

const portRefusal = (found: number) =>
  `${serverFile}: port: is ${String(found)}. With --compose it must be ${String(composeListener.port)}, the port the host firewall opens.`;

const forwardRefusal = (index: number, found: string, serverPort: number) =>
  `compose.yaml:${String(5 + index)}:9: services.aphelion.ports[${String(index)}]: ${found}, but it must forward to TCP port ${String(serverPort)}, the server's port in server.yaml.`;

function withPorts(...entries: string[]): string {
  return [
    "services:",
    "  aphelion:",
    "    image: aphelion",
    "    ports:",
    ...entries.map((entry) => `      - ${entry}`),
  ].join("\n");
}

describe("accepts", () => {
  test.each([
    '"100.71.226.67:7400:7400"',
    '"100.71.226.67:7400:7400/tcp"',
    '"100.64.0.0:7400:7400"',
    '"100.127.255.255:7400-7401:7400-7401"',
    '"100.71.226.67::7400"',
    "{ target: 7400, published: 7400, host_ip: 100.71.226.67 }",
  ])("a port published on the tailnet: %s", (entry) => {
    expect(check(withPorts(entry))).toEqual([]);
  });

  test("services that publish nothing", () => {
    const text = [
      "services:",
      "  aphelion:",
      "    image: aphelion",
      "    expose: ['7400']",
      "  helper:",
      "    image: helper",
      "    network_mode: none",
    ].join("\n");
    expect(check(text)).toEqual([]);
  });

  test("the resolved output of docker compose config", () => {
    const text = [
      "name: aphelion",
      "services:",
      "  aphelion:",
      "    image: aphelion",
      "    networks:",
      "      default: null",
      "    ports:",
      "      - mode: ingress",
      "        host_ip: 100.71.226.67",
      "        target: 7400",
      '        published: "7400"',
      "        protocol: tcp",
      "networks:",
      "  default:",
      "    name: aphelion_default",
    ].join("\n");
    expect(check(text)).toEqual([]);
  });

  test("a bridge network in NAT mode, with other driver options", () => {
    const text = [
      withPorts('"100.71.226.67:7400:7400"'),
      "networks:",
      "  default:",
      "    driver: bridge",
      "    driver_opts:",
      "      com.docker.network.bridge.name: aphelion0",
      "      com.docker.network.bridge.gateway_mode_ipv4: nat",
      "      com.docker.network.bridge.gateway_mode_ipv6: nat",
    ].join("\n");
    expect(check(text)).toEqual([]);
  });

  test("JSON from docker compose config --format json, read like YAML", () => {
    const resolved = {
      name: "aphelion",
      services: {
        aphelion: {
          image: "aphelion",
          ports: [
            {
              mode: "ingress",
              host_ip: "100.71.226.67",
              target: 7400,
              published: "7400",
              protocol: "tcp",
            },
          ],
        },
      },
      networks: { default: { name: "aphelion_default" } },
    };
    expect(check(JSON.stringify(resolved, null, 2))).toEqual([]);
    expect(check(JSON.stringify(resolved))).toEqual([]);
  });

  test("tailnet ports shared through a YAML merge key", () => {
    const text = [
      "x-ports: &ports",
      "  ports: ['100.71.226.67:7400:7400']",
      "services:",
      "  aphelion:",
      "    <<: *ports",
      "    image: aphelion",
    ].join("\n");
    expect(check(text)).toEqual([]);
  });
});

describe("refuses", () => {
  test.each([
    ['"0.0.0.0:7400:7400"', "0.0.0.0"],
    ['"[::]:7400:7400"', "[::]"],
    ['"::1:7400:7400"', "::1"],
    ['"127.0.0.1:7400:7400"', "127.0.0.1"],
    ['"10.0.0.133:7400:7400"', "10.0.0.133"],
    ['"100.63.255.255:7400:7400"', "100.63.255.255"],
    ['"100.128.0.1:7400:7400"', "100.128.0.1"],
  ])("a port published on another address: %s", (entry, address) => {
    expect(check(withPorts(entry))).toEqual([
      `compose.yaml:5:9: services.aphelion.ports[0]: publishes the port on ${address}, which isn't a tailnet address (100.64.0.0/10). ${fix}`,
    ]);
  });

  test.each(['"7400:7400"', '"7400"', "7400", '"7400/tcp"'])(
    "a port published with no host address: %s",
    (entry) => {
      expect(check(withPorts(entry))).toEqual([
        `compose.yaml:5:9: services.aphelion.ports[0]: publishes the port on every host address. ${fix}`,
      ]);
    },
  );

  test("long syntax with no host_ip or the IPv6 any address", () => {
    const text = withPorts(
      "{ target: 7400, published: 7400 }",
      '{ target: 7401, host_ip: "::" }',
    );
    expect(check(text)).toEqual([
      `compose.yaml:5:9: services.aphelion.ports[0]: publishes the port on every host address. ${fix}`,
      `compose.yaml:6:34: services.aphelion.ports[1].host_ip: publishes the port on ::, which isn't a tailnet address (100.64.0.0/10). ${fix}`,
    ]);
  });

  test("the host's network, and every bad port in every service", () => {
    const text = [
      withPorts('"100.71.226.67:7400:7400"', '"0.0.0.0:9000:9000"'),
      "  helper:",
      "    image: helper",
      "    network_mode: host",
      "    ports: ['8080:8080']",
    ].join("\n");
    expect(check(text)).toEqual([
      `compose.yaml:6:9: services.aphelion.ports[1]: publishes the port on 0.0.0.0, which isn't a tailnet address (100.64.0.0/10). ${fix}`,
      `compose.yaml:9:19: services.helper.network_mode: shares the host's network, which publishes every port on every host address. ${fix}`,
      `compose.yaml:10:13: services.helper.ports[0]: publishes the port on every host address. ${fix}`,
    ]);
  });

  test("a network named or driven by host", () => {
    const text = [
      withPorts('"100.71.226.67:7400:7400"'),
      "    networks: [outside]",
      "networks:",
      "  outside:",
      "    external: true",
      "    name: host",
      "  other:",
      "    driver: host",
    ].join("\n");
    expect(check(text)).toEqual([
      `compose.yaml:9:5: networks.outside: is the host's network, which publishes every port on every host address. ${fix}`,
      `compose.yaml:12:5: networks.other: is the host's network, which publishes every port on every host address. ${fix}`,
    ]);
  });

  test.each([
    ["gateway_mode_ipv4", "routed"],
    ["gateway_mode_ipv4", "nat-unprotected"],
    ["gateway_mode_ipv6", "routed"],
    ["gateway_mode_ipv6", "nat-unprotected"],
  ])("a bridge network with %s: %s", (option, mode) => {
    const text = [
      withPorts('"100.71.226.67:7400:7400"'),
      "networks:",
      "  default:",
      "    driver_opts:",
      `      com.docker.network.bridge.${option}: ${mode}`,
    ].join("\n");
    expect(check(text)).toEqual([
      `compose.yaml:9:52: networks.default.driver_opts.com.docker.network.bridge.${option}: is "${mode}", which lets other machines reach the container directly, whatever host address its ports name. Leave it at "nat", the default.`,
    ]);
  });

  test.each(["macvlan", "ipvlan", "overlay"])(
    "a network with the %s driver",
    (driver) => {
      const text = [
        withPorts('"100.71.226.67:7400:7400"'),
        "networks:",
        "  default:",
        `    driver: ${driver}`,
      ].join("\n");
      expect(check(text)).toEqual([
        "compose.yaml:8:13: networks.default.driver: is not bridge. The check vouches only for ports published through a bridge network in NAT mode.",
      ]);
    },
  );

  test("a network defined outside the file", () => {
    const text = [
      withPorts('"100.71.226.67:7400:7400"'),
      "networks:",
      "  default:",
      "    external: true",
      "    name: shared",
    ].join("\n");
    expect(check(text)).toEqual([
      "compose.yaml:8:15: networks.default.external: is defined outside this file, so the check can't see its driver or options.",
    ]);
  });

  test("the same refusals in JSON as in YAML", () => {
    const json = JSON.stringify(
      {
        services: {
          aphelion: { image: "aphelion", ports: ["0.0.0.0:7400:7400"] },
        },
      },
      null,
      2,
    );
    expect(check(json)).toEqual([
      `compose.yaml:6:9: services.aphelion.ports[0]: publishes the port on 0.0.0.0, which isn't a tailnet address (100.64.0.0/10). ${fix}`,
    ]);
  });

  test("another container's network", () => {
    const text = withPorts('"100.71.226.67:7400:7400"').replace(
      "    ports:",
      "    network_mode: container:proxy\n    ports:",
    );
    expect(check(text)).toEqual([
      "compose.yaml:4:19: services.aphelion.network_mode: shares the network of a container outside this file, so the check can't see which ports it publishes.",
    ]);
  });

  test("a file it can't read as Compose", () => {
    expect(check("services:\n  - name: a\n   image: b\n")).toEqual([
      "compose.yaml:3:1: Sequence item without - indicator",
    ]);
    expect(check(withPorts().replace("ports:", "ports: 7400"))).toEqual([
      "compose.yaml:4:12: services.aphelion.ports: Invalid input: expected array, received number",
    ]);
  });
});

describe("refuses a file that isn't resolved yet", () => {
  const unresolved =
    "is not resolved. Run the check on the output of `docker compose config`, which fills in variables and merges include, extends and override files.";

  test("an interpolated network_mode, which could resolve to host", () => {
    const text = withPorts('"100.71.226.67:7400:7400"').replace(
      "    ports:",
      "    network_mode: ${MODE:-bridge}\n    ports:",
    );
    expect(check(text)).toEqual([
      `compose.yaml:4:19: services.aphelion.network_mode: ${unresolved}`,
    ]);
  });

  test.each([
    '"${TAILNET_IP}:7400:7400"',
    '"$TAILNET_IP:7400:7400"',
    '{ target: 7400, host_ip: "${TAILNET_IP}" }',
  ])("an interpolated port: %s", (entry) => {
    expect(check(withPorts(entry))).toEqual([
      `compose.yaml:5:9: services.aphelion.ports[0]: ${unresolved}`,
    ]);
  });

  test("interpolated service networks", () => {
    const text = withPorts('"100.71.226.67:7400:7400"').replace(
      "    ports:",
      "    networks: [$NETWORK]\n    ports:",
    );
    expect(check(text)).toEqual([
      `compose.yaml:4:15: services.aphelion.networks: ${unresolved}`,
    ]);
  });

  test("extends and include, which pull in other files", () => {
    const text = [
      "include: [other.yaml]",
      withPorts('"100.71.226.67:7400:7400"').replace(
        "    image: aphelion",
        "    extends: { file: base.yaml, service: aphelion }",
      ),
    ].join("\n");
    expect(check(text)).toEqual([
      `compose.yaml:1:10: include: ${unresolved}`,
      `compose.yaml:4:14: services.aphelion.extends: ${unresolved}`,
    ]);
  });

  test("a Compose YAML tag such as !reset", () => {
    const text = withPorts().replace("    ports:", "    ports: !reset []");
    expect(check(text)).toEqual([
      `compose.yaml:4:12: A YAML tag ${unresolved}`,
    ]);
  });
});

describe("the server listener", () => {
  test("accepts 0.0.0.0 on the firewall port", () => {
    expect(listener(composeListener.address, composeListener.port)).toEqual([]);
  });

  test("refuses a loopback address", () => {
    expect(listener("127.0.0.1", composeListener.port)).toEqual([
      addressRefusal("127.0.0.1"),
    ]);
  });

  test.each(["::", "172.17.0.2"])("refuses address %s", (address) => {
    expect(listener(address, composeListener.port)).toEqual([
      addressRefusal(address),
    ]);
  });

  test("refuses a port other than the firewall port", () => {
    expect(listener(composeListener.address, 7401)).toEqual([
      portRefusal(7401),
    ]);
  });

  test("refuses a wrong address and a wrong port together", () => {
    expect(listener("127.0.0.1", 7401)).toEqual([
      addressRefusal("127.0.0.1"),
      portRefusal(7401),
    ]);
  });

  test("the firewall script opens the same port", async () => {
    const firewall = await readFile(
      join(import.meta.dirname, "../../../../deploy/host/firewall"),
      "utf8",
    );
    const port = firewall.match(/^readonly port=(\d+)$/m)?.[1];
    expect(port).toBe(String(composeListener.port));
  });
});

describe("the aphelion service container port", () => {
  test.each([
    '"100.71.226.67:8443:7400"',
    '"100.71.226.67:8443:7400/tcp"',
    '"100.71.226.67::7400"',
    "{ target: 7400, published: 8443, host_ip: 100.71.226.67 }",
    "{ target: '7400', published: '8443', host_ip: 100.71.226.67 }",
    "{ target: 7400, published: 8443, host_ip: 100.71.226.67, protocol: tcp }",
  ])("accepts a host port that forwards to the server: %s", (entry) => {
    expect(check(withPorts(entry), composeListener.port)).toEqual([]);
  });

  test("accepts a service that publishes no port", () => {
    const omitted = ["services:", "  aphelion:", "    image: aphelion"].join(
      "\n",
    );
    const empty = withPorts().replace("    ports:", "    ports: []");
    expect(check(omitted, composeListener.port)).toEqual([]);
    expect(check(empty, composeListener.port)).toEqual([]);
  });

  test("accepts another service publishing a different container port", () => {
    const text = [
      withPorts('"100.71.226.67:8443:7400"'),
      "  helper:",
      "    image: helper",
      "    ports: ['100.71.226.67:8080:8080']",
    ].join("\n");
    expect(check(text, composeListener.port)).toEqual([]);
  });

  test("a server port other than 7400 that the container port matches fails only the listener check", () => {
    expect(listener(composeListener.address, 7401)).toEqual([
      portRefusal(7401),
    ]);
    expect(check(withPorts('"100.71.226.67:8443:7401"'), 7401)).toEqual([]);
  });

  test("refuses a container port that differs from the server port", () => {
    expect(check(withPorts('"100.71.226.67:7400:7401"'), 7400)).toEqual([
      forwardRefusal(0, "forwards to container port 7401", 7400),
    ]);
  });

  test("refuses a range on the container side", () => {
    expect(
      check(withPorts('"100.71.226.67:8443:7400-7401"'), composeListener.port),
    ).toEqual([
      forwardRefusal(
        0,
        "forwards to container port 7400-7401",
        composeListener.port,
      ),
    ]);
    expect(
      check(
        withPorts(
          '{ target: "7400-7401", published: 8443, host_ip: 100.71.226.67 }',
        ),
        composeListener.port,
      ),
    ).toEqual([
      forwardRefusal(
        0,
        "forwards to container port 7400-7401",
        composeListener.port,
      ),
    ]);
  });

  test("refuses a UDP port, because the server and the firewall take only TCP", () => {
    expect(
      check(withPorts('"100.71.226.67:8443:7400/udp"'), composeListener.port),
    ).toEqual([
      forwardRefusal(
        0,
        "forwards to container port 7400/udp",
        composeListener.port,
      ),
    ]);
    expect(
      check(
        withPorts(
          "{ target: 7400, published: 8443, host_ip: 100.71.226.67, protocol: udp }",
        ),
        composeListener.port,
      ),
    ).toEqual([
      forwardRefusal(
        0,
        "forwards to container port 7400/udp",
        composeListener.port,
      ),
    ]);
  });

  test("refuses a published port with no container port", () => {
    expect(
      check(
        withPorts("{ host_ip: 100.71.226.67, published: 8443 }"),
        composeListener.port,
      ),
    ).toEqual([
      forwardRefusal(0, "has no container port", composeListener.port),
    ]);
  });

  test("refuses a file with no aphelion service", () => {
    const text = [
      "services:",
      "  helper:",
      "    image: helper",
      "    ports: ['100.71.226.67:8080:8080']",
    ].join("\n");
    expect(check(text)).toEqual([]);
    expect(check(text, composeListener.port)).toEqual([
      "compose.yaml:2:3: services: has no service named aphelion, so the check can't see which ports reach the server. Aphelion's Compose file names the server's service aphelion.",
    ]);
  });

  test("still refuses a port that is not on the tailnet when the container port matches", () => {
    expect(check(withPorts('"7400"'), composeListener.port)).toEqual([
      `compose.yaml:5:9: services.aphelion.ports[0]: publishes the port on every host address. ${fix}`,
    ]);
  });
});
