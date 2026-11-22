import { describe, expect, test } from "vitest";
import { checkComposePorts } from "./compose";
import { formatIssue } from "./issues";

const fix =
  'Publish it only on the host\'s tailnet address, such as "100.71.226.67:7400:7400" (decision 0022).';

function check(text: string): string[] {
  return checkComposePorts("compose.yaml", text).map(formatIssue);
}

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
    ['"${TAILNET_IP}:7400:7400"', "${TAILNET_IP}"],
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

  test("a file it can't read as Compose", () => {
    expect(check("services:\n  - name: a\n   image: b\n")).toEqual([
      "compose.yaml:3:1: Sequence item without - indicator",
    ]);
    expect(check(withPorts().replace("ports:", "ports: 7400"))).toEqual([
      "compose.yaml:4:12: services.aphelion.ports: Invalid input: expected array, received number",
    ]);
  });
});
