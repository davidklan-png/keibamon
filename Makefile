.PHONY: test api ui form-marts

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
