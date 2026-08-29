#!/usr/bin/env python3
"""Drive a command in a real PTY, responding to prompts in a JSON spec.

Usage: pty_driver.py <json-file> <timeout-seconds>

json-file schema:
{
  "cmd": ["node", "src/cli.js"],
  "cwd": "...",
  "env": {"HOME": "..."},
  "steps": [
    {"trigger": "请选择功能", "send": "3\\n"},
    {"trigger": "请输入歌曲 ID", "send": "123456\\n"},
    {"trigger": "请粘贴新的网易云网页 Cookie", "send": "MUSIC_U=PASTE\\r"},
    {"after": 0.1, "send": "\\n"}   # optional: send after fixed delay,
                                     # no trigger wait (simulates paste burst
                                     # arriving in separate reads)
  ],
  "done": "再见"   # optional: stop after seeing this
}

Writes the child's exit code to stdout on the last line: "EXIT:<code>"
Full captured output is on stdout before it.
"""

import fcntl
import json
import os
import pty
import select
import signal
import sys
import termios
import time


def main():
    spec_path, timeout_s = sys.argv[1], float(sys.argv[2])
    with open(spec_path) as f:
        spec = json.load(f)

    steps = spec.get("steps", [])
    done_marker = spec.get("done")
    pid, master_fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env.update(spec.get("env", {}))
        os.chdir(spec.get("cwd", "/"))
        os.execvpe(spec["cmd"][0], spec["cmd"], env)

    os.set_blocking(master_fd, False)
    output = bytearray()
    step_idx = 0
    start = time.time()
    last_data = time.time()
    prev_send = time.time()

    while True:
        now = time.time()
        if now - start > timeout_s:
            os.kill(pid, signal.SIGKILL)
            break
        r, _, _ = select.select([master_fd], [], [], 0.05)
        if r:
            try:
                data = os.read(master_fd, 65536)
            except OSError:
                break
            if data:
                output += data
                last_data = now

        text = output.decode("utf-8", "replace")
        if step_idx < len(steps):
            step = steps[step_idx]
            if "after" in step:
                if now - prev_send >= step["after"]:
                    send = step["send"].encode("utf-8").decode("unicode_escape").encode("latin1")
                    os.write(master_fd, send)
                    step_idx += 1
                    prev_send = time.time()
                    last_data = time.time()
            else:
                trigger = step["trigger"]
                if trigger in text:
                    time.sleep(0.2)
                    send = step["send"].encode("utf-8").decode("unicode_escape").encode("latin1")
                    os.write(master_fd, send)
                    step_idx += 1
                    prev_send = time.time()
                    last_data = time.time()
                elif now - last_data > 3:
                    # prompt not appearing; abort
                    os.kill(pid, signal.SIGKILL)
                    break
        elif done_marker and done_marker in text:
            break
        elif step_idx >= len(steps) and now - last_data > 2:
            break

    # wait up to 3s for the child to exit on its own (graceful exit path)
    deadline = time.time() + 3
    rc = None
    while time.time() < deadline:
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
        except (ChildProcessError, OSError):
            rc = -1
            break
        if wpid == pid:
            rc = os.waitstatus_to_exitcode(status) if status else 0
            break
        try:
            data = os.read(master_fd, 65536)
            if data:
                output += data
        except OSError:
            pass
        time.sleep(0.05)
    if rc is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            _, status = os.waitpid(pid, 0)
            rc = os.waitstatus_to_exitcode(status)
        except (ChildProcessError, OSError):
            rc = -1
    os.close(master_fd)

    sys.stdout.write(output.decode("utf-8", "replace"))
    sys.stdout.write(f"\nEXIT:{rc}\n")


if __name__ == "__main__":
    main()
