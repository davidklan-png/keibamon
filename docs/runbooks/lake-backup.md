# Runbook: weekly lake backup (USB KEIBA)

**Decision (2026-07-08, David):** maintain a weekly backup of the lake on the
USB volume `KEIBA`. This is the mitigation for the single-disk risk called out
in `docs/codebase-review-2026-07-08.md` #1 — after the ADR-0004 cutover the Mac
is the only machine holding the lake, and intraday odds curves **cannot be
backfilled**. The backup is a cutover prerequisite (see
`overlap-capture-weekend.md` cutover criteria).

## Cadence and trigger

Weekly, on the Mac, after the Sunday-night settle (weekend pipeline stage 4).
Settling is already a manual Mac step, so the backup rides the same session —
plug in KEIBA, then:

```bash
make lake-backup
```

## What it does

`rsync -a --delete` mirror of `./data/` →
`/Volumes/KEIBA/keibamon-lake-backup/data/`, then stamps
`LAST_BACKUP` (UTC ISO) at the backup root. Refuses to run if KEIBA is not
mounted. `--delete` keeps the mirror exact — corrupt or mistakenly deleted
lake files propagate on the *next* run, so the window to notice a bad state is
one week.

## Verify (30 seconds, do it each time)

```bash
cat /Volumes/KEIBA/keibamon-lake-backup/LAST_BACKUP   # should be just now
du -sh /Volumes/KEIBA/keibamon-lake-backup/data       # ~same as du -sh data
```

## Restore

```bash
rsync -a /Volumes/KEIBA/keibamon-lake-backup/data/ data/
```

Restore to an empty `./data` on a fresh machine, then rerun silver/gold/marts
builders if anything downstream looks stale — bronze + normalized are the
payload that matters.

## Known limits (accepted)

- Single restore point, one week granularity, no off-site copy. A
  lost-or-dead USB *and* a dead Mac disk in the same week is unrecoverable.
  Off-site (R2/Backblaze) was considered and deferred — revisit if the odds
  time-series becomes the live betting signal.
- Secrets (`.env`, `CF_*`) are deliberately NOT backed up to the USB. Recreate
  from the Cloudflare dashboard on restore.
