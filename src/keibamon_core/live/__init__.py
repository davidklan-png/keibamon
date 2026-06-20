"""Live registration-exposure feed (ADR-0006).

Turns scraped entries (registered races) + live odds into the single
``live_snapshot`` document the Worker's ``/api/live`` route serves to the app,
so a race appears the moment it is registered -- grayed, with estimated odds --
and upgrades to live the moment pari-mutuel odds open.
"""
