"""Weekend race pipeline: selection -> posting -> day-of curve -> results.

The repeatable weekend loop (see docs/adr/0003-weekend-pipeline.md). Four stages,
each owned by a specific device per docs/device-topology.md:

  1. select   (Mac)          -- pick runners/races from the lake.
  2. post     (Mac)          -- freeze our model fair-odds + gate pre-market.
  3. track    (capture host) -- live odds time-series, announcement -> post.
  4. settle   (Mac)          -- settle at official final payouts; score the card.

Stages 1/2/4 are recoverable batch jobs. Stage 3 is the only live, race-day-
critical job and cannot be re-run (a missed curve is gone). Keep them separate.
"""
from __future__ import annotations

__all__ = ["model_card", "pipeline"]
