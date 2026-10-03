#!/usr/bin/env python3
"""Drive the real Pi CLI inside `asciinema rec` through a real PTY. Usage: drive.py SCENARIO OUT.cast"""
import re, sys, time, json
import pexpect

S = "$SCRATCH"
WORK = "/tmp/pbo28-demo-VySR/work"
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]")

scenario, out = sys.argv[1], sys.argv[2]
extra = {"a": "", "b": "--continue", "c": "--continue", "d": "--continue"}[scenario]
cmd = f"{S}/tools/bin/asciinema rec -q --return --overwrite -f asciicast-v2 -c './run-pi.sh {extra}' {out}"
child = pexpect.spawn("bash", ["-c", cmd], cwd=WORK, dimensions=(42, 150), encoding="utf-8", timeout=5,
                      env={"PATH": "$NODE_BIN:/usr/bin:/bin:/usr/local/bin", "TERM": "xterm-256color", "HOME": "$HOME",
                           "LANG": "C.UTF-8", "SHELL": "/bin/bash", "COLORTERM": "truecolor"})
buf = ""
log = []

def pump(t=0.2):
    global buf
    end = time.time() + t
    while time.time() < end:
        try:
            buf += child.read_nonblocking(65536, timeout=0.1)
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            return False
    return True

def plain():
    return re.sub(r"\s+", " ", ANSI.sub(" ", buf))

def wait(text, timeout=60):
    start = len(plain())
    end = time.time() + timeout
    while time.time() < end:
        if not pump(0.3):
            break
        if text in plain()[max(0, start - 200):]:
            log.append({"wait": text, "ok": True})
            return True
    log.append({"wait": text, "ok": False})
    print(f"TIMEOUT waiting for {text!r}", file=sys.stderr)
    return False

def type_(s, enter=True):
    for ch in s:
        child.send(ch)
        pump(0.025)
    if enter:
        pump(0.4)
        child.send("\r")
    log.append({"typed": s})

def key(k, pause=0.8):
    child.send({"enter": "\r", "esc": "\x1b", "right": "\x1b[C", "left": "\x1b[D", "down": "\x1b[B", "up": "\x1b[A"}[k])
    log.append({"key": k})
    pump(pause)

DECIDE = ('The classifier is already selected with /openai-decisions. Call openai_decide exactly once with '
          'state {"change":"README typo fix","tests":"pass"} and questions: route (choice: review or proceed), '
          'ready (bool), risk (score 1-5). Then list the typed answers.')

wait("pi exit", 0) if False else None
pump(8)  # startup
if scenario == "a":
    type_("/openai-decisions models"); wait("Catalog entries", 20); pump(3)
    type_("/openai-decisions use openrouter/~typesafe/jev-latest"); wait("Decisions enabled for", 20); pump(3)
    type_("/openai-tier fast"); pump(3)
    type_("/openai-tier"); pump(3)
    type_(DECIDE); wait("typed answers", 5); wait("openai_decide", 90); wait("authorization to act", 120); pump(8)
    type_("/openai-settings"); wait("Better OpenAI Settings", 20); pump(1)
    type_("Diag", enter=False); pump(1.5); key("enter", 2); key("enter", 2); wait("Last injected", 10); pump(6)
    key("esc", 1.5); key("esc", 1.5); key("esc", 2)
    type_("/session"); pump(5)
    type_("/quit")
elif scenario == "b":
    pump(2)
    type_("/openai-decisions use openai/gpt-6-astra"); wait("Unknown native classifier", 20); pump(3)
    type_("/openai-decisions use nosuch/classifier"); wait("Unknown native classifier", 20); pump(3)
    type_("/openai-decisions use typesafe/jev-latest"); wait("Decisions enabled for", 20); pump(3)
    type_(DECIDE); wait("Decision provider failed", 120); pump(15)
    type_("/openai-decisions off"); wait("Decision requests disabled", 20); pump(3)
    type_(DECIDE); wait("Decisions are disabled", 120); pump(15)
    type_("/session"); pump(5)
    type_("/quit")
elif scenario == "c":
    pump(2)
    type_("/openai-tier"); pump(4)
    type_("/openai-settings"); wait("Better OpenAI Settings", 20); pump(2)
    key("enter", 2)            # Service tier submenu
    key("right", 3)            # fast -> ultrafast (inactive on this route: warning, no fast suffix)
    key("right", 3)            # ultrafast -> standard
    key("esc", 2); key("down", 1); key("enter", 2)  # Footer submenu
    key("right", 2.5)          # replace -> status
    key("esc", 1.5); key("esc", 3)
    type_("/openai-tier"); pump(4)
    type_("Reply with one short line: tier check done."); wait("tier check done", 5); pump(20)
    type_("/openai-settings"); wait("Better OpenAI Settings", 20); pump(1)
    key("down", 1); key("enter", 2); key("right", 2); key("right", 2)  # status -> off -> replace
    key("esc", 1.5); key("esc", 3)
    type_("/session"); pump(5)
    type_("/quit")
elif scenario == "d":
    pump(2)
    type_("/openai-tier"); pump(4)
    type_("/session"); pump(5)
    type_("/quit")
pump(6)
try:
    child.expect(pexpect.EOF, timeout=30)
except pexpect.TIMEOUT:
    pass
child.close()
log.append({"asciinema_exit": child.exitstatus})
print(json.dumps(log, indent=1))
open(out + ".plain.txt", "w").write(plain())
