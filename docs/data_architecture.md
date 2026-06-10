# Data Architecture

Keibamon uses a medallion-style local data lake.

## Bronze

Bronze stores source snapshots exactly as received. The raw bytes or text and
metadata are retained so parsers can be replayed when schemas change.

Required metadata:

- `source_name`
- `source_record_id`
- `raw_uri`
- `content_hash`
- `ingested_at`
- `published_time`
- `available_at`

## Silver

Silver tables are canonical typed records. They normalize source-specific
payloads into stable analytical entities:

- races
- race entries
- results
- odds
- body weights
- racecourse/travel context
- weather observations and forecasts
- news/events
- analyst notes and subjective annotations

## Gold

Gold tables are point-in-time feature tables. Each feature row has an
`as_of_time`; every upstream record used to build it must have
`available_at <= as_of_time`.

## Marts

Marts are analyst-friendly views optimized for DuckDB queries and API reads.
They are replaceable derived assets, not sources of truth.

