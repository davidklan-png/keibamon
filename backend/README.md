# backend/keibamon_api — kept deliberately (parity oracle)

This FastAPI app is **not** the production form service — that moved to the
racing Worker + D1 (`src/form/*`, see memory/ADRs on the form-service D1
migration). It is retained as the **Python parity oracle**: the TS routes in
`src/form/` were ported from `main.py` here, and the parity suite
(`tools/form/generate_parity_fixtures.py` + root worker tests) checks the TS
implementation against this reference behavior.

Do not delete in a cleanup pass without first retiring the parity gate.
`make api` still serves it locally for debugging.
