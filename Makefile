.PHONY: test api ui

test:
	pytest

api:
	uvicorn backend.keibamon_api.main:app --reload

ui:
	cd frontend && npm run dev


jravan-import:
	python tools/jravan/import_delta.py --from /Volumes/KEIBA/keibamon-xfer
