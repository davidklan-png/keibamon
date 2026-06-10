.PHONY: test api ui

test:
	pytest

api:
	uvicorn backend.keibamon_api.main:app --reload

ui:
	cd frontend && npm run dev

