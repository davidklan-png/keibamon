# Runbook: capture-PC ACP fix + weekend re-capture (2026-07-02)

**Deadline: before the first pool opens Saturday 2026-07-04.** The ACP guard on
`main` makes the capture PC *refuse to run* while its codepage is wrong — no fix
means **no capture** on 07-04/05, and realtime odds curves cannot be backfilled.

## Background (one paragraph)

The 2026-06-30 USB snapshot arrived with 77% of RACE records mojibake'd
(`ƒn[ƒtƒFƒ“`-style). Root cause: JV-Link returns Shift-JIS as COM BSTRs which
Windows converts using the ANSI codepage; the PC's ACP had reverted to 1252
(English) sometime after the clean 06-17 capture — the capture *code* did not
change. Both corrupt snapshots are quarantined at `data/_quarantine/` on the Mac
and are 100% lossless-recoverable (the C1 orphan bytes survived); recovery
and/or this re-capture restores the 06-27/28 weekend. Full forensics:
`docs/jra-van-windows-ingestion.md` §9 (cp1252 mojibake recovery path).

## Steps (on the capture PC)

1. **Preflight:** `python tools\jravan\check_acp.py` → expect FAIL with ACP 1252
   (confirms diagnosis).
2. **Fix the locale (admin):** Control Panel → Region → Administrative →
   "Change system locale…" → **Japanese (Japan)**. Leave **"Beta: Use Unicode
   UTF-8" UNCHECKED**. Reboot.
3. **Verify:** `python tools\jravan\check_acp.py` → PASS (932).
4. **Sync code:** confirm branch `main`, `git pull --ff-only`. The ACP guard +
   mojibake canary only exist on main — a divergent branch bypasses both.
5. **Quarantine the PC-side corrupt bronze** (same incident, captured locally
   first): move `D:\keibamon\data\raw\jravan\20260630T214859` and
   `...\20260626T115545_masters` into `D:\keibamon\data\_quarantine\`.
6. **Roll back watermarks to re-pull the weekend:** in
   `D:\keibamon\data\raw\jravan\_state.json`, set every spec's watermark that is
   `> 20260625000000` down to `20260625000000` (covers the 06-26 masters pull and
   the 06-27/28 cards; JVOpen re-serves historical normal data). Keep a copy of
   the original file next to it as `_state.json.pre-recapture`.
7. **Re-capture:** `set KEIBAMON_LAKE=D:\keibamon\data` then
   `C:\keibamon\venv32\Scripts\python tools\jravan\ingest_jvlink.py pull`.
   The guard now passes; the canary will hard-fail the run if any mojibake
   slips through (it must not).
8. **Export to USB:** run the usual `export_delta.py` flow; carry to the Mac;
   import lands in repo-`./data` (canonical — do NOT set `KEIBAMON_LAKE` on the
   Mac; `~/keibamon-data` is a symlink now).
9. **Weekend capture readiness:** verify the realtime runner / scheduled task
   for 07-04 is armed and the PC will not sleep.

## After import on the Mac

Rebuild silver/gold/marts wholesale; if the R-derived recovery snapshots from
`data/_quarantine/` were built in the meantime, quarantine them in favor of this
clean re-capture. Verify latest `race_date` reaches 2026-06-28 and
jockey/trainer masters regenerate from KS/CH bronze (~1,560 / ~1,475 rows).
