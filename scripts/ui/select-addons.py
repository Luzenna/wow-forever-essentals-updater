"""Scenario: open "Choose which addons I want" in a real terminal, tick one addon, confirm.

Fails (exit 1) if the screen is wrong: stale dashboard above the list, or a detour into
Spoken's voice packs. Run from the repo root:  python scripts/ui/select-addons.py
"""
import os, shutil, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drive import Session

repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
base = tempfile.mkdtemp(prefix="wfe-ui-")
home, addons = os.path.join(base, "home"), os.path.join(base, "AddOns")
os.makedirs(home); os.makedirs(addons)
s = Session(["node", "src/main.ts", "--addons", addons, "--no-self-update"], home=home, cwd=repo, rows=45, cols=110)
problems = []
try:
    s.wait_for("What would you like to do?", 90)
    s.send(s.DOWN); s.send(s.ENTER)                      # "Choose which addons I want"
    s.wait_for("Which addons do you want?", 30)
    opened = s.screen()
    print("--- list as opened ---\n" + opened)
    if "What would you like to do?" in opened or "Your addons" in opened:
        problems.append("the old dashboard/menu is still on screen above the list")
    for _ in range(4): s.send(s.DOWN)                    # DialogKey is the fifth item
    s.send(s.SPACE)
    if "● DialogKey" not in s.screen():
        problems.append("Space did not tick the highlighted addon")
    s.send(s.ENTER)
    s.wait_for("What would you like to do?", 30)         # must land back on the main menu
    after = s.screen()
    print("\n--- after confirming ---\n" + after)
    if "Spoken voice packs" in after:
        problems.append("confirming one addon dragged the user into the Spoken voice packs")
    if "Which addons do you want?" in after:
        problems.append("the list is still on screen after confirming")
    if "●  DialogKey" not in after:
        problems.append("DialogKey is not shown as selected on the dashboard")
finally:
    s.close()
    shutil.rmtree(base, ignore_errors=True)
if problems:
    print("\nFAILED:\n  - " + "\n  - ".join(problems))
    sys.exit(1)
print("\nOK")
