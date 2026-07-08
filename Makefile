.PHONY: test api ui form-marts lake-backup

# Canonical interpreter. Override with `make PYTHON=python3 ...` if needed.
PYTHON ?= ./venv64/bin/python

test:
	pytest

api:
	uvicorn backend.keibamon_api.main:app --reload

ui:
	cd frontend && npm run dev

# Milestone 4 lookup -- build horse_form + jockey_form marts from silver.
form-marts:
	$(PYTHON) -m keibamon_core.marts.form


jravan-import:
	$(PYTHON) tools/jravan/import_delta.py --from /Volumes/KEIBA/keibamon-xfer

# Weekly lake backup → USB KEIBA (run on the Mac after Sunday settle).
# Mirror of ./data; intraday odds curves cannot be backfilled, so this backup
# is the only copy besides the live disk. See docs/runbooks/lake-backup.md.
LAKE_BACKUP_DEST ?= /Volumes/KEIBA/keibamon-lake-backup
lake-backup:
	@test -d /Volumes/KEIBA || { echo "ERROR: USB volume KEIBA not mounted"; exit 1; }
	mkdir -p $(LAKE_BACKUP_DEST)
	rsync -a --delete --exclude='.DS_Store' data/ $(LAKE_BACKUP_DEST)/data/
	date -u +"%Y-%m-%dT%H:%M:%SZ" > $(LAKE_BACKUP_DEST)/LAST_BACKUP
	@echo "Lake backed up to $(LAKE_BACKUP_DEST) ($$(du -sh $(LAKE_BACKUP_DEST)/data | cut -f1))"
