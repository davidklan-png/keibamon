# Going-handling validation

Validation is implemented in `tools/validate_going_features.py`.

Run:

```bash
PYTHONPATH=src python -m keibamon_core.ingestion.going_features
python tools/validate_going_features.py
```

Protocol:

- Restrict to off-going races (`going_wetness >= 3`).
- Split out-of-sample within each coverage era (`year >= 2023` dense modern era,
  older years as sparse historical coverage) so one era does not dominate the
  test fold.
- Compare multinomial race-level log-loss for:
  - baseline: market-implied win probability plus raw `going_wetness`
  - enhanced: baseline plus `going_fit_z` and `going_market_disagreement`
- Lead with the market test: top-quartile `going_market_disagreement` runners
  must show positive ROI against available win odds, not merely higher hit rate.

Current status:

- The local fixture suite validates the feature mechanics and PIT invariant.
- `sire_going_affinity` is wired from an optional silver
  `jravan_horse_pedigree` table (`horse_id`, `sire_id`). The raw BLOD/HN files
  are present locally, but the repo does not yet contain verified HN byte
  offsets for sire identity, so the builder does not guess them.
- Full production validation depends on a built `data/features/going_handling`
  dataset plus JRA-VAN silver results and races. The script prints an
  insufficient-sample message rather than manufacturing a flattering number
  when the local lake is too small.
