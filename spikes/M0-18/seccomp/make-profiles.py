import json, sys, copy, pathlib

CLONE_NEWNET = 0x40000000
here = pathlib.Path(sys.argv[1])
base = json.loads((here / "docker-29.10.0-default.json").read_text())

def profile(names, deny_netns):
    p = copy.deepcopy(base)
    rules = []
    plain = [n for n in names if not (deny_netns and n in ("clone", "unshare"))]
    if plain:
        rules.append({"names": plain, "action": "SCMP_ACT_ALLOW",
                      "comment": "M0-18: namespace calls for bwrap, without CAP_SYS_ADMIN"})
    if deny_netns:
        for n in ("clone", "unshare"):
            if n in names:
                rules.append({"names": [n], "action": "SCMP_ACT_ALLOW",
                              "args": [{"index": 0, "value": CLONE_NEWNET, "valueTwo": 0, "op": "SCMP_CMP_MASKED_EQ"}],
                              "excludes": {"arches": ["s390", "s390x"]},
                              "comment": "M0-18: any namespace flag except CLONE_NEWNET"})
    p["syscalls"].extend(rules)
    return p

variants = {
    "userns-full": (["clone", "unshare", "setns", "mount", "umount2", "pivot_root"], False),
    "userns-nonet": (["clone", "unshare", "setns", "mount", "umount2", "pivot_root"], True),
    "userns-nosetns": (["clone", "unshare", "mount", "umount2", "pivot_root"], False),
    "userns-nosetns-nonet": (["clone", "unshare", "mount", "umount2", "pivot_root"], True),
    "userns-nopivot": (["clone", "unshare", "mount", "umount2"], False),
    "userns-noumount": (["clone", "unshare", "mount", "pivot_root"], False),
    "userns-onlyclone": (["clone", "unshare"], False),
}
for name, (names, nonet) in variants.items():
    (here / f"{name}.json").write_text(json.dumps(profile(names, nonet), indent=2) + "\n")
    print(name)
