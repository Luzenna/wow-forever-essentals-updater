"""Drive the real CLI inside a pseudo-terminal and read the screen the way a user sees it.

Windows uses ConPTY (pywinpty), Linux/macOS a Unix pty (ptyprocess); `pyte` renders the screen.
See "Testing the interactive menu" in CLAUDE.md.

Usage as a module:
    from drive import Session
    s = Session(["node", "src/main.js", "--addons", addons, "--no-self-update"], home=home, rows=40, cols=110)
    s.wait_for("What would you like to do?")
    s.send(Session.DOWN); s.send(Session.ENTER)
    print(s.screen())
    s.close()
"""
import os
import threading
import time

import pyte

if os.name == "nt":
    from winpty import PtyProcess
else:
    from ptyprocess import PtyProcess


class Session:
    UP, DOWN, ENTER, SPACE, ESC = "\x1b[A", "\x1b[B", "\r", " ", "\x1b"

    def __init__(self, argv, home, cwd=None, rows=40, cols=110, env=None):
        self.rows, self.cols = rows, cols
        self.screen_ = pyte.Screen(cols, rows)
        self.stream = pyte.Stream(self.screen_)
        self.lock = threading.Lock()
        self.raw = ""
        e = dict(os.environ)
        e.update({"WFE_UPDATER_HOME": home, "FORCE_COLOR": "1", "TERM": "xterm-256color"})
        e.update(env or {})
        self.proc = PtyProcess.spawn(argv, cwd=cwd, env=e, dimensions=(rows, cols))
        self.alive = True
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while True:
            try:
                data = self.proc.read(65536)
            except EOFError:
                break
            except Exception:
                break
            if not data:
                if not self.proc.isalive():
                    break
                time.sleep(0.02)
                continue
            with self.lock:
                self.raw += data
                self.stream.feed(data)
        self.alive = False

    def screen(self):
        with self.lock:
            lines = [l.rstrip() for l in self.screen_.display]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines)

    def send(self, keys, settle=0.35):
        self.proc.write(keys)
        time.sleep(settle)

    def wait_for(self, text, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            if text in self.screen():
                time.sleep(0.2)
                return True
            time.sleep(0.15)
        raise TimeoutError(f"never saw {text!r}. Screen was:\n{self.screen()}")

    def close(self):
        try:
            self.proc.terminate(force=True)
        except Exception:
            pass
