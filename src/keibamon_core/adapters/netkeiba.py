from __future__ import annotations

from pathlib import Path


class NetkeibaSourceAdapter:
    """Placeholder for cache-first netkeiba ingestion.

    The implementation should parse saved/cached payloads first, then use
    conservative rate-limited requests only when live fetching is explicitly
    enabled by configuration.
    """

    source_name = "netkeiba"

    def __init__(self, cache_dir: Path, live_fetch_enabled: bool = False):
        self.cache_dir = cache_dir
        self.live_fetch_enabled = live_fetch_enabled

