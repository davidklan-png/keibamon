"""thursday_sync.py -- Thursday "sync down" on the capture PC.

The capture PC is a *mirror*: it runs no dev work, it only pulls the code that
was pushed from the Mac and then proves it is fit to capture the weekend. This
wraps the three Thursday steps into one guarded command:

  1. DEVICE GUARD   - refuse to run unless this host is `capture-pc`
                      (so the dirty Mac/sandbox tree is never fast-forwarded).
  2. SYNC DOWN      - git fetch && git pull --ff-only origin main
                      (mirror the pushed code; never merge, never rebase).
  3. PREFLIGHT      - plugged in, won't sleep, JV-Link / Data Lab logged in.

Exit code is 0 only when every gate passes, so it is safe to chain in a
scheduled task or a race-day checklist.

    python tools/thursday_sync.py            # full run: guard -> pull -> preflight
    python tools/thursday_sync.py --check    # preflight only (no git, read-only)
    python tools/thursday_sync.py --no-pull  # guard + preflight, skip the pull
    python tools/thursday_sync.py --fix      # also try to disable AC sleep
    python tools/thursday_sync.py --yes      # auto-confirm the manual JV-Link gate
    python tools/thursday_sync.py --force    # bypass the capture-pc device guard

Design notes for the maintainer:
  * stdlib only (+ optional pywin32 for the deep JV-Link probe) so it runs in
    the PC's 32-bit JV-Link venv with no extra installs.
  * Every check returns PASS / WARN / FAIL. WARN never fails the run; FAIL does.
  * Off-Windows (Mac / sandbox) the Windows-only probes report SKIP, so you can
    smoke-test the plumbing anywhere. The device guard still blocks a real run.
"""
from __future__ import annotations

import argparse
import os
import platform
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
IS_WINDOWS = platform.system() == "Windows"

# ---- result vocabulary -----------------------------------------------------
PASS, WARN, FAIL, SKIP = "PASS", "WARN", "FAIL", "SKIP"
_MARK = {PASS: "[ OK ]", WARN: "[WARN]", FAIL: "[FAIL]", SKIP: "[skip]"}


class Result:
    def __init__(self, name: str, status: str, detail: str = "", hint: str = ""):
        self.name, self.status, self.detail, self.hint = name, status, detail, hint

    def line(self) -> str:
        s = f"  {_MARK[self.status]} {self.name}"
        if self.detail:
            s += f" — {self.detail}"
        if self.hint and self.status in (WARN, FAIL):
            s += f"\n         ↳ {self.hint}"
        return s


def _run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, cwd=str(cwd or REPO), capture_output=True, text=True
    )


# ---- 1. device guard -------------------------------------------------------
def device_role() -> str:
    """Reuse whichdevice's source of truth so the two tools never disagree."""
    sys.path.insert(0, str(REPO / "tools"))
    try:
        import whichdevice  # noqa: WPS433 (local import is intentional)

        cfg = whichdevice._read_device_file()  # noqa: SLF001
        return cfg.get("role") or whichdevice._infer_role()  # noqa: SLF001
    except Exception:  # pragma: no cover - fall back to a local read
        df = REPO / ".device"
        if df.exists():
            for ln in df.read_text().splitlines():
                ln = ln.split("#", 1)[0].strip()
                if ln.startswith("role") and "=" in ln:
                    return ln.split("=", 1)[1].strip().strip("'\"")
        return "capture-pc" if IS_WINDOWS else "unknown"


def check_device(force: bool) -> Result:
    role = device_role()
    if role == "capture-pc":
        return Result("device is capture-pc", PASS, role)
    if force:
        return Result("device guard bypassed (--force)", WARN, f"role={role}",
                      "Pulling --ff-only on a non-mirror host can fail on a dirty tree.")
    return Result(
        "device is capture-pc", FAIL, f"role={role}",
        "This is the PC-only sync-down. Run it on the capture PC, or pass --force "
        "if you really mean to. On the Mac/sandbox, push/commit there instead.",
    )


# ---- 2. sync down ----------------------------------------------------------
def sync_down(allow_dirty: bool) -> list[Result]:
    out: list[Result] = []

    branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    if branch != "main":
        out.append(Result("on branch main", FAIL, f"on '{branch}'",
                           "The mirror tracks main. `git switch main` first."))
        return out
    out.append(Result("on branch main", PASS))

    dirty = _run(["git", "status", "--porcelain"]).stdout.strip()
    if dirty:
        n = len(dirty.splitlines())
        status = WARN if allow_dirty else FAIL
        out.append(Result(
            "working tree clean", status, f"{n} uncommitted path(s)",
            "The PC is a mirror and should never have local edits. Investigate, "
            "or `git stash`/reset. Use --allow-dirty to pull anyway.",
        ))
        if status == FAIL:
            return out
    else:
        out.append(Result("working tree clean", PASS))

    before = _run(["git", "rev-parse", "HEAD"]).stdout.strip()

    fetch = _run(["git", "fetch", "origin", "main"])
    if fetch.returncode != 0:
        out.append(Result("git fetch origin main", FAIL, fetch.stderr.strip()[:200],
                           "Check network / GitHub auth on the PC."))
        return out
    out.append(Result("git fetch origin main", PASS))

    pull = _run(["git", "pull", "--ff-only", "origin", "main"])
    if pull.returncode != 0:
        out.append(Result(
            "git pull --ff-only origin main", FAIL, pull.stderr.strip()[:200],
            "Not fast-forwardable — the mirror diverged. Do NOT merge here; "
            "reconcile on the Mac and re-push.",
        ))
        return out

    after = _run(["git", "rev-parse", "HEAD"]).stdout.strip()
    if before == after:
        out.append(Result("git pull --ff-only origin main", PASS, "already up to date"))
    else:
        n = _run(["git", "rev-list", "--count", f"{before}..{after}"]).stdout.strip()
        out.append(Result("git pull --ff-only origin main", PASS,
                          f"+{n} commit(s) → {after[:7]}"))
    return out


# ---- 3. preflight ----------------------------------------------------------
def check_ac_power() -> Result:
    if not IS_WINDOWS:
        return Result("plugged in (AC power)", SKIP, "non-Windows host")
    try:
        import ctypes

        class SPS(ctypes.Structure):
            _fields_ = [
                ("ACLineStatus", ctypes.c_byte),
                ("BatteryFlag", ctypes.c_byte),
                ("BatteryLifePercent", ctypes.c_byte),
                ("SystemStatusFlag", ctypes.c_byte),
                ("BatteryLifeTime", ctypes.c_ulong),
                ("BatteryFullLifeTime", ctypes.c_ulong),
            ]

        s = SPS()
        if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(s)):
            return Result("plugged in (AC power)", WARN, "power status unavailable",
                          "Confirm the charger is connected.")
        ac = s.ACLineStatus  # 0 offline, 1 online, 255 unknown
        if ac == 1:
            return Result("plugged in (AC power)", PASS, "on AC")
        if ac == 0:
            return Result("plugged in (AC power)", FAIL, "on battery",
                          "Plug in the charger — a race day cannot run off battery.")
        return Result("plugged in (AC power)", WARN, "AC status unknown",
                      "No battery / desktop? Confirm mains power.")
    except Exception as e:  # pragma: no cover
        return Result("plugged in (AC power)", WARN, f"probe error: {e}")


def check_wont_sleep(fix: bool) -> Result:
    if not IS_WINDOWS:
        return Result("won't sleep (AC standby off)", SKIP, "non-Windows host")
    q = _run(["powercfg", "/q", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE"])
    if q.returncode != 0:
        return Result("won't sleep (AC standby off)", WARN, "powercfg query failed",
                      "Manually verify Sleep is set to 'Never' on AC.")
    idx = None
    for ln in q.stdout.splitlines():
        if "Current AC Power Setting Index" in ln:
            try:
                idx = int(ln.split(":")[1].strip(), 16)
            except ValueError:
                idx = None
    if idx == 0:
        return Result("won't sleep (AC standby off)", PASS, "AC standby = Never")
    if fix:
        r = _run(["powercfg", "/change", "standby-timeout-ac", "0"])
        if r.returncode == 0:
            return Result("won't sleep (AC standby off)", PASS,
                          "AC standby set to Never (--fix)")
        return Result("won't sleep (AC standby off)", FAIL, "could not apply --fix",
                      "Run as admin: powercfg /change standby-timeout-ac 0")
    mins = "?" if idx is None else f"{idx // 60} min"
    return Result("won't sleep (AC standby off)", FAIL, f"AC standby = {mins}",
                  "A closed/idle host kills capture. Pass --fix, or run: "
                  "powercfg /change standby-timeout-ac 0")


def check_jvlink(assume_ok: bool) -> Result:
    """JV-Link / Data Lab login can't be fully verified headlessly.

    Tiered: (1) is the COM class registered? (2) optional deep probe via
    pywin32 (JVInit + JVStatus). If neither is conclusive, this is a manual
    gate — pass --yes / answer 'y' once you've eyeballed the JV-Link tray /
    Data Lab login.
    """
    if not IS_WINDOWS:
        return Result("JV-Link / Data Lab logged in", SKIP, "non-Windows host")

    # (1) registry: is JVDTLab.JVLink even installed?
    reg = _run(["reg", "query", r"HKCR\JVDTLab.JVLink"])
    if reg.returncode != 0:
        return Result("JV-Link / Data Lab logged in", FAIL, "JVDTLab.JVLink not registered",
                      "JV-Link/Data Lab is not installed (or 64-bit shell). Install/repair it.")

    # (2) optional deep probe (needs 32-bit python + pywin32 + a real SID)
    sid = os.environ.get("JVLINK_SID")
    try:
        import win32com.client  # type: ignore

        jv = win32com.client.Dispatch("JVDTLab.JVLink")
        rc = int(jv.JVInit(sid or "UNKNOWN"))
        if rc == 0 and sid:
            return Result("JV-Link / Data Lab logged in", PASS, "JVInit OK")
        if rc == 0:
            return Result("JV-Link / Data Lab logged in", WARN,
                          "JVInit OK but JVLINK_SID unset",
                          "Set JVLINK_SID to your software ID for a full check.")
        return Result("JV-Link / Data Lab logged in", FAIL, f"JVInit rc={rc}",
                      "Open JV-Link settings and re-enter the Data Lab login.")
    except Exception:
        pass  # pywin32 absent / wrong-bitness: fall through to manual gate

    if assume_ok:
        return Result("JV-Link / Data Lab logged in", PASS,
                      "installed; confirmed by --yes")
    if sys.stdin and sys.stdin.isatty():
        ans = input("    ?  Is JV-Link / Data Lab logged in and ready? [y/N] ").strip().lower()
        if ans == "y":
            return Result("JV-Link / Data Lab logged in", PASS, "confirmed interactively")
        return Result("JV-Link / Data Lab logged in", FAIL, "not confirmed",
                      "Open JV-Link, sign into Data Lab, then re-run.")
    return Result("JV-Link / Data Lab logged in", WARN,
                  "installed; login not auto-verifiable",
                  "Eyeball the JV-Link tray / Data Lab login, then re-run with --yes.")


def check_cf_creds() -> Result:
    """Bonus mirror-of-CLAUDE.md check: the dashboard push fails silently
    without CF_* in the shell, and that bites on the capture host."""
    if os.environ.get("CF_API_TOKEN"):
        return Result("CF_* creds in env (D1 push)", PASS)
    return Result("CF_* creds in env (D1 push)", WARN, "not set",
                  "push_to_d1 will fail silently. Source CF_* before the feed starts.")


# ---- driver ----------------------------------------------------------------
def banner(text: str) -> None:
    print(f"\n=== {text} ===")


def summarize(results: list[Result]) -> int:
    fails = [r for r in results if r.status == FAIL]
    warns = [r for r in results if r.status == WARN]
    banner("THURSDAY SYNC-DOWN")
    if fails:
        print(f"  RESULT: NOT READY — {len(fails)} blocking, {len(warns)} warning(s).")
        for r in fails:
            print(f"    FAIL: {r.name} ({r.detail})")
        return 1
    if warns:
        print(f"  RESULT: READY (with {len(warns)} warning(s) to eyeball).")
        return 0
    print("  RESULT: READY — all gates green.")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Thursday sync-down for the capture PC.")
    p.add_argument("--check", action="store_true", help="preflight only; no git")
    p.add_argument("--no-pull", action="store_true", help="skip the git sync")
    p.add_argument("--fix", action="store_true", help="try to disable AC sleep")
    p.add_argument("--yes", action="store_true", help="auto-confirm the JV-Link gate")
    p.add_argument("--force", action="store_true", help="bypass the capture-pc guard")
    p.add_argument("--allow-dirty", action="store_true", help="pull even if tree is dirty")
    args = p.parse_args(argv)

    results: list[Result] = []

    banner("1. DEVICE GUARD")
    g = check_device(args.force)
    print(g.line())
    results.append(g)
    if g.status == FAIL:
        return summarize(results)  # never touch git on the wrong host

    do_pull = not (args.check or args.no_pull)
    if do_pull:
        banner("2. SYNC DOWN  (git fetch && git pull --ff-only origin main)")
        for r in sync_down(args.allow_dirty):
            print(r.line())
            results.append(r)
    else:
        banner("2. SYNC DOWN  (skipped)")
        print("  [skip] git sync skipped (--check/--no-pull)")

    banner("3. PREFLIGHT")
    for r in (
        check_ac_power(),
        check_wont_sleep(args.fix),
        check_jvlink(args.yes),
        check_cf_creds(),
    ):
        print(r.line())
        results.append(r)

    return summarize(results)


if __name__ == "__main__":
    raise SystemExit(main())
