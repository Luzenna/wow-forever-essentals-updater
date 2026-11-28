"""Scenario: auto update mode, in a real terminal.

1. Settings > Auto update mode > On, with real keys; the screen must say so and config.json must change.
2. A session started with auto_update on and one addon selected installs it by itself, without a question,
   and lands on a redrawn menu that says everything is up to date.
Talks to GitHub for real (What's Training). Run from the repo root:  python scripts/ui/auto-update.py
"""
import json, os, shutil, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drive import Session

repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
base = tempfile.mkdtemp(prefix="wfe-ui-")
home, addons = os.path.join(base, "home"), os.path.join(base, "AddOns")
os.makedirs(home); os.makedirs(addons)
cfg_path = os.path.join(home, "config.json")
cfg = lambda: json.load(open(cfg_path, encoding="utf8"))
argv = ["node", "src/main.ts", "--addons", addons, "--no-self-update"]
problems = []

def write_cfg(**kw):
    json.dump({"selected": ["whatstraining"], **kw}, open(cfg_path, "w", encoding="utf8"))

try:
    # 1. the switch
    write_cfg()
    s = Session(argv, home=home, cwd=repo, rows=45, cols=110)
    try:
        s.wait_for("What would you like to do?", 90)
        for _ in range(4): s.send(s.DOWN)
        s.send(s.ENTER)                                   # Settings
        s.wait_for("Auto update mode", 30)
        print("--- settings ---\n" + s.screen())
        for _ in range(3): s.send(s.DOWN)
        s.send(s.ENTER)                                   # Auto update mode
        s.wait_for("Auto update mode (now: off)", 30)
        s.send(s.DOWN); s.send(s.ENTER)                   # On
        s.wait_for("on: install everything new by itself", 30)   # the Settings rows show the state
        after = s.screen()
        print("\n--- after switching on ---\n" + after)
        if cfg().get("auto_update") is not True:
            problems.append("config.json did not get auto_update: true")
        if "Auto update mode (now" in after:
            problems.append("the choice list is still on screen after choosing")
    finally:
        s.close()

    # 2. it installs by itself
    write_cfg(auto_update=True)
    s = Session(argv, home=home, cwd=repo, rows=45, cols=110)
    try:
        s.wait_for("Auto update: installing", 90)
        s.wait_for("Auto update:", 90)
        s.wait_for("What would you like to do?", 120)
        scr = s.screen()
        print("\n--- auto update session ---\n" + scr)
        if not os.path.isdir(os.path.join(addons, "WhatsTraining")):
            problems.append("WhatsTraining was not installed by auto update mode")
        if "Auto update: installed What's Training" not in scr:
            problems.append("no 'Auto update: installed What's Training' line on the redrawn menu")
        if "everything is up to date" not in scr:
            problems.append("the menu does not say everything is up to date after the auto install")
        if "[y/N]" in s.raw or "Continue anyway" in s.raw:
            problems.append("auto update mode asked a question")
    finally:
        s.close()
finally:
    shutil.rmtree(base, ignore_errors=True)
if problems:
    print("\nFAILED:\n  - " + "\n  - ".join(problems))
    sys.exit(1)
print("\nOK")
