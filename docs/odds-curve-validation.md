# Odds-curve validation

Validation is implemented in `tools/validate_curve_signal.py`.

Run:

```bash
PYTHONPATH=src python -m keibamon_core.ingestion.curve_features
python tools/validate_curve_signal.py
```

Protocol:

- Select at a real pre-post decision time from `gold/odds_curve`.
- Use only odds snapshots with `available_at <= as_of_time`.
- De-vig the win market at the decision snapshot before treating odds as
  probabilities.
- Settle hypothetical win bets with official final `jravan_payouts`, not the
  odds visible at decision time.
- Report infinitesimal-stake ROI and capacity-adjusted ROI separately.
- Include robustness by removing the largest payoffs.

Current status:

- The pipeline builds and unit-tests on synthetic PIT odds curves.
- The PC ingest now requests JRA-VAN `0B41/0B42`, but meaningful out-of-sample
  ROI needs those time-series files, or enough accumulated netkeiba snapshots,
  in the local lake. Until then the script reports insufficient sample instead
  of manufacturing a flattering result.
