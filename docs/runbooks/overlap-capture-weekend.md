# Runbook: overlap-capture weekend (PC → Mac cutover gate)

**Goal.** Capture one weekend where both the Mac scrape and the official JV-Link pull
cover the same races, then run the cross-validation gate. A `VERDICT: PASS` (0.0000%)
is the evidence that earns the ADR-0004 PC-cutover checkbox. **Until the gate passes,
the PC stays.**

**Roles.** Mac (`mac-dev`) runs the pipeline + scrape + gate. PC (`capture-pc`) runs
the final official JV-Link pull and exports bronze on the USB. The PC is the oracle;
the Mac is the judge.

**Detailed steps live in** `docs/prompts/weekend-run-mac.md` and
`docs/prompts/weekend-run-pc.md` — this is the human checklist + timing that ties them
together. Substitute `DATE=YYYYMMDD`, `VENUE=<slug>` throughout.

---

## Thursday — sync + scrape card + select + post (Mac)

- [ ] `python tools/whichdevice.py` → `mac-dev`.
- [ ] Green test, then **push** so the PC can mirror: `pytest -q` → `git push origin main`.
- [ ] **Scrape the card once entries post:** `scrape_ingest.py --date $DATE` →
      populates entries + each race's `grade`, `netkeiba_race_id`, and post time.
      **This is what `track --grades` resolves from on race day** — skip it and the
      one-command track has nothing to look up (it will warn and skip, not guess).
- [ ] `weekend_run.py select --date $DATE --grades G1,G2,G3` → confirm it lists the
      graded races (this weekend: the 2 Sunday GⅢ). Drop `--grades` to see the full card.
- [ ] `post` (pipeline fn) → freeze our model odds **pre-market**. Confirm
      `posted_before_market = True`. (Source `CF_*` first.)

> Why now: posting before the market prints is the whole point of the calibration
> record. A late post still logs, but flagged contaminated. And the card scrape must
> precede race-day `track --grades` — that's the dependency that makes it lookup-free.

## Thursday — sync down (PC)

- [ ] `python tools\whichdevice.py` → `capture-pc`.
- [ ] `python tools\thursday_sync.py` → one-shot **code-sync**: device guard →
      `git fetch` + `git pull --ff-only origin main` → preflight (plugged in /
      won't sleep / JV-Link / `CF_*`). This mirrors the Mac's pushed code; it
      moves **code only**.
- [ ] If the tool reports FAIL, stop and reconcile on the Mac — do not merge on
      the PC (it is a pull-only mirror).

## Race day (Sat/Sun) — track the live curve (Mac), graded races only

Live odds are **graded-only by policy** (G1/G2/G3) — keeps polling polite (ADR-0004).

- [ ] Mac **stationary, lid forced open**; disable lid-close sleep in System Settings.
- [ ] Source `CF_*`.
- [ ] **Preferred — one command, no lookups:**
      `weekend_run.py track --date $DATE --grades G1,G2,G3`
      resolves *which* races are graded, their race numbers, netkeiba ids, and post
      times from the lake — no hand-entered race numbers or nk ids, across all venues
      that day. (This weekend: the 2 Sunday GⅢ — Fuchu Himba S at Tokyo, Shirasagi S
      at Hanshin.)
- [ ] *Fallback only if grade-resolve is unavailable:* name them explicitly with
      `--venue $VENUE --races <n> --nk-race-ids <...> --post-times-jst <HH:MM>`.
- [ ] Watch the cycle line: `last_banked` climbing, `last_push=ok`. A
      `preflight warnings:` line = fix sleep/creds **without** stopping the loop.
- [ ] Leave running until after the last graded race posts.

> This is the only unrecoverable job: no realtime entitlement, no `0B41/0B42`
> backfill. A missed curve is gone. The June 14 loss was a closed lid — don't repeat it.

## Saturday night — official pull + USB export (PC)

- [ ] After results are official, bulk/蓄積 pull: `tools/jravan/ingest_jvlink.py`
      (32-bit JV-Link venv; **not** `venv64`). No `JVRTOpen` — entitlement not held.
- [ ] Verify the pull landed **results AND payouts** (not just entries) for the card.
- [ ] Export bronze delta to USB: `tools/jravan/export_delta.py --to <KEIBA volume>`.
- [ ] Hand the USB to the Mac. (PC never pushes; pull-only mirror.)

## Sunday — import + settle + gate (Mac)

- [ ] Scrape the official surfaces into silver: `tools/scrape_ingest.py --date $DATE --venue $VENUE`.
- [ ] Import the PC's oracle: `make jravan-import`, then rebuild silver→gold→marts
      (use the canonical command in `ingestion/runner.py` / Makefile — don't invent one).
- [ ] **Settle + score**: `pipeline.settle(... include_run=True)` → calibration report
      (sliced by `posted_before_market`). Calibration, not edge.
- [ ] **Run the gate**: `tools/validate_scrape_vs_jravan.py --date $DATE`.

### The decision point

- [ ] **`VERDICT: PASS`** (0.0000% on all four oracles + settle equivalence) →
      record this as the **first** passing overlap. Fill the ADR-0004 cutover
      checkbox's date. Do **not** power off the PC on one weekend — see "Cutover" below.
- [ ] **Any mismatch** → the gate prints the offending races/diff. Almost always a
      **parser delta vs live netkeiba payloads** (the open ADR-0004 item). Fix the
      parser → re-run `scrape_ingest` → re-run the gate. PC stays.

## Sunday — re-sync (Mac)

- [ ] `git add -A && git commit -m "weekend $DATE: run + cross-val (<verdict>)"`.
- [ ] `pytest -q` (stay green) → `git push origin main`.

---

## Cutover criteria (don't shortcut these)

One clean overlap is **necessary, not sufficient**. Before actually switching off the PC:

- [ ] **≥ 2–3 consecutive weekends** at `VERDICT: PASS` (the scrape is brittle; one
      pass can be luck on a simple card).
- [ ] Parser-vs-live-payload item closed (ADR-0004 checkbox).
- [ ] Mac live-capture reliability proven (lid-open discipline held a full day without
      a missed curve).
- [x] Loud scrape-failure monitoring in place (a silent scrape outage = a lost,
      unrecoverable race day). Implemented in `src/keibamon_core/alerting.py`
      (wired into `track`): export `KEIBAMON_NTFY_TOPIC=<long-random-topic>` in
      the same sourced profile as the `CF_*` creds and subscribe to that topic
      in the ntfy phone app. Check this box only after a test alert has
      actually appeared on the phone. *(Live 2026-07-08 — topic in
      `~/.keibamon/cf.env`, subscribed on iPhone, test alert "keibamon test"
      received.)*
- [x] Weekly lake backup running (`make lake-backup` → USB KEIBA, see
      `docs/runbooks/lake-backup.md`) with at least one verified backup on the
      stick. Post-cutover the Mac is the only machine holding the lake and the
      odds curves cannot be backfilled — do not power off the PC while the lake
      exists on exactly one disk. *(First verified backup: 2026-07-08 —
      LAST_BACKUP 2026-07-08T06:50:06Z, 4273 content files mirrored exactly to
      `/Volumes/KEIBA/keibamon-lake-backup/data`.)*

When all hold, the human flips it: archive the final JV-Link bronze as the historical
record of truth, set the PC's `.device` aside, update `device-topology.md` from
"deprecated" to "retired", and check the last ADR-0004 box.

## Abort / fallback

- Mac track dies mid-day → restart `track` (it resumes via `odds_snapshots` dedupe);
  the curve has a gap but isn't duplicated. The gap is permanent — note it.
- PC JV-Link auth fails → no oracle this weekend; gate will print `NO-OVERLAP-YET`.
  The pipeline still ran (calibration on scraped data), but the cutover clock doesn't
  advance. Fix auth, try next weekend.
- Gate mismatch you can't resolve same-day → leave the PC on; the official data is
  already safe in bronze. No deadline pressure — the PC staying is the safe state.
