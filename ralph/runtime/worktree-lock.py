"""製品Ralphのworktree実行lock。Runnerが強制終了しても旧Agentが保持するfdで排他を保つ。"""
import fcntl
import os
import signal
import subprocess
import sys

lock_path, *command = sys.argv[1:]
os.makedirs(os.path.dirname(lock_path), exist_ok=True)
with open(lock_path, "a") as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("Worktree is already running: " + lock_path, file=sys.stderr)
        sys.exit(75)
    child = subprocess.Popen(command, start_new_session=True, pass_fds=(lock.fileno(),))

    def stop(signum, _frame):
        try:
            # Loopだけへ停止を通知する。実行中Agentの完了を待つ既存契約を保つ。
            os.kill(child.pid, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    code = child.wait()
    sys.exit(code if code >= 0 else 128 - code)
