.PHONY: test api ui

# Canonical interpreter. Override with `make PYTHON=python3 ...` if needed.
PYTHON ?= ./venv64/bin/python

test:
	pytest

api:
	uvicorn backend.keibamon_api.main:app --reload

ui:
	cd frontend && npm run dev


jravan-import:
	$(PYTHON) tools/jravan/import_delta.py --from /Volumes/KEIBA/keibamon-xfer
