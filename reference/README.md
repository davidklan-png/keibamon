# reference/ — JV-Data spec documents (LOCAL ONLY)

Drop the JRA-VAN JV-Data specification PDFs here. This folder is the Mac-side
mirror of `D:\JRA-VAN\reference` on the ingestion PC.

## Compliance — do not commit the PDFs

JV-Data carries redistribution restrictions (see ADR-0001) and this repo pushes
to a **public** GitHub remote. Everything in this folder **except this README**
is gitignored, so the spec PDFs stay local. Do not move them into `docs/` —
that tree is tracked and published.

## Layout

```
reference/
  README.md            (tracked — this file)
  jravan/              (gitignored — put the spec PDFs here)
    JV-Data_仕様書_*.pdf
    ...
```

## What it's for

The silver parser (`src/keibamon_core/adapters/jravan.py`) parses fixed-width
JV-Data records by **byte offset**. The header fields and the SE id fields are
confirmed against live data, but the deep fields — surface, distance, finish
position, carried weight, finish time, odds pools — are stubbed `# [SPEC]` and
emit `None` until their byte offsets are filled in from these PDFs. The record
of interest first is **RA** (race detail) and **SE** (horse-in-race); then the
**O1–O6** odds pools.
