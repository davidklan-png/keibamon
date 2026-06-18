# CLI agent task: final JV-Link oracle pull + export + sync (CAPTURE PC)

You are the agent on the **capture PC (`capture-pc`)**, Windows, JV-Link host.
Read `CLAUDE.md`, `docs/device-topology.md`, `docs/adr/0004-mac-only-scrape-sourced.md`.
**First**, run `python tools/whichdevice.py` and confirm it prints `capture-pc`. If
not, STOP. Use the PC's **32-bit** JV-Link venv for ingest (JV-Link COM is 32-bit) —
not the Mac's `venv64`.

Your job this weekend is to produce the **official JV-Link oracle** that the Mac's
cross-validation gate checks the scrape against (ADR-0004 prerequisite), and to keep
this checkout in sync with origin. You are NOT running the weekend pipeline — that is
Mac-only now. You are the deprecated-but-still-docked official source during the
hybrid transition.

Set `DATE` to this weekend's race date (`YYYYMMDD`).

## Step 0 — sync code from origin (the Mac pushed first)

```
python tools\thursday_sync.py
```

`thursday_sync.py` is the PC's one-shot **code-sync** entrypoint: it guards on
`capture-pc`, verifies the working tree is clean, then runs `git fetch origin
main` + `git pull --ff-only origin main`, then preflights (plugged in / won't
sleep / JV-Link / `CF_*` present). `--ff-only` so a surprise local commit can't
create a silent merge — the tool surfaces it as FAIL instead. Flags: `--check`
(preflight only), `--no-pull`, `--fix` (disable AC sleep), `--yes` (confirm the
JV-Link gate). The PC is a clean mirror of origin; it is not a place we author
code.

> **Code vs data — do not conflate.** `thursday_sync.py` moves **code only**
> (over git). Lake **bronze still crosses the airgap on the USB** in Step 3 —
> that is a different job and stays until the ADR-0004 cutover gate passes on a
> real overlap weekend. One syncs the repo; the other moves the data oracle.

## Step 1 — preflight

- Confirm the PC is plugged in, will not sleep, and JV-Link / Data Lab is logged in.
- Confirm the JV-Link COM client responds (the same preflight `ingest_jvlink.py`
  does at startup). A failed auth here means no oracle this weekend.
- Note: the **realtime/速報 entitlement is not held** (ADR-0002 blocked), so you do
  the **bulk/蓄積 pull only**, after the races have run and official results land.
  Do not attempt `JVRTOpen`.

## Step 2 — final official bulk pull → bronze

After the card's results are official (typically the evening of the race day), pull
the 蓄積系 data — entries, results, payouts, odds — into bronze:

```
python tools/jravan/ingest_jvlink.py   # bulk -> bronze (see the tool's --help for
                                        # the date/scope flags; scope to $DATE's card)
```

This bronze is the **immutable record of truth** the gate trusts. Verify the pull
landed results AND payouts for the weekend's races (not just entries) — the gate's
payout oracle needs `jravan_payouts`.

## Step 3 — export the bronze delta to the USB

The PC is airgapped from the lake; bronze crosses to the Mac on the USB only.

```
python tools/jravan/export_delta.py --to /Volumes/KEIBA/keibamon-xfer
# (Windows path equivalent for the KEIBA volume; see the tool's --help)
```

Confirm the export manifest lists this weekend's races. Then hand the USB to the Mac,
where `make jravan-import` ingests it and the cross-val gate runs (Mac prompt, Step 3
& 5).

## Step 4 — record what you pulled

```
git status     # expect clean (you authored nothing)
```

If `whichdevice` or the ingest wrote any machine-local log you want preserved, leave
it for the human — do **not** commit or push from the PC. Per the topology, code
authorship and pushes happen on the Mac; the PC only pulls.

## Guardrails

- Confirm `capture-pc` before acting; use the 32-bit JV-Link venv, never `venv64`.
- Bulk pull only (no realtime entitlement). Pull only AFTER official results land.
- Bronze crosses to the Mac via the USB only — nothing else crosses that line.
- Do not `git push` from the PC; pull-only mirror of origin.
- This is the **final** official pull of the cutover sequence: once the Mac gate
  prints `VERDICT: PASS` on this overlap, the human decides whether the PC is
  switched off. Until then, stay docked and available.
```
