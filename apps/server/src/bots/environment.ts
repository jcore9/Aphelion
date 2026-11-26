export function botEnvironment(
  provider: string,
  home: string,
): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    TZ: "UTC",
    TMPDIR: "/tmp",
    ...(provider === "claude" ? { DISABLE_AUTOUPDATER: "1" } : {}),
  };
}
