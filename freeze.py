#!/usr/bin/env python3
"""freeze.py IN.cast T OUT.cast: collapse all output up to T seconds into one frame (a static screen at T)."""
import json, sys
src, t, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
lines = open(src).read().splitlines()
data = "".join(json.loads(l)[2] for l in lines[1:] if json.loads(l)[0] <= t and json.loads(l)[1] == "o")
with open(out, "w") as f:
    f.write(lines[0] + "\n" + json.dumps([0.0, "o", data]) + "\n")
