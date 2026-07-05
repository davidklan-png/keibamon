# Keibamon — one-month product plan (summer 2026 → autumn-G1 launch)

Window: ~4 weekends in July 2026 (summer graded weekends) → an "amazing app" by
August → ramp into the autumn G1 season. Anchored fact: the autumn G1 series opens
**Sep 27 (Sprinters Stakes)** and runs to Arima Kinen (late Dec). July/Aug are
G2/G3 only — quiet weekends, perfect for hardening before keiba attention spikes.

## The vision (in your words, sharpened)

Keibamon is the **shared research companion that powers productive horse-racing
conversations between friends.** You and a friend at the OTB on a big weekend, each
with the most trustworthy research tool on the market, comparing reads and building
tickets together. The product isn't a tip sheet and isn't a solo data dump — it's the
thing that makes the social ritual of racing better.

That reframes the whole roadmap: the moat isn't the data (netkeiba has more); it's
**trust + the shared experience.**

## What similar apps do well — and where they leave a gap

| App / class | Does well | Gap we exploit |
|---|---|---|
| **netkeiba** (the gorilla) | Data depth, community "collective intelligence," AI 予想, paid expert handicapper picks, subscriptions | Tip/予想-centric and monetizes picks; JP-only; solo consumption; cluttered |
| **JRA-VAN / TARGET frontier** | Authoritative official data, deep power-user analysis | Desktop, expert-only, no social, no mobile-at-track UX |
| **Sports Navi / SPAIA** | Clean, free, casual AI 予想 | Shallow; still solo; tip-flavored; JP-only |
| **Western (DRF, Racing Post, Timeform, TVG)** | Gold-standard past performances, news, integrated betting | Tips culture, betting funnels, solo; nothing for *friends researching together* |

The pattern across all of them: they either **sell you picks** (the thing you
explicitly reject) or **dump data**, and they are **solo**. Racing is intensely
social — but that social life happens in LINE groups, Discord, and at the rail, not in
any tool. **No one has built the research tool designed for friends to use together.**

## What the market wants (your core segment first)

1. **Social-casual bettors (you + your friend).** Want to feel informed, have fun, and
   have a good argument about a race — not get fleeced, not become a spreadsheet jockey.
   Underserved by both the tip sellers and the power tools.
2. **Foreign fans, expats, and learners.** Keiba is booming in global interest but the
   apps are JP-only; `en.netkeiba` is thin. A genuinely bilingual companion that
   *decodes the card* is a wide-open lane.
3. **Lapsed/curious fans.** Intimidated by the wall of kanji and the sucker-bet anxiety;
   a legible, honest on-ramp brings them back.

## Differentiation & the moat

Four assets, in order of defensibility:

1. **The shared/social research layer — the real moat.** Friends researching together,
   sharing reads, talking through a race. This is a network effect: once your group is
   on it, it's where the conversation lives. Nobody else is building this. *This is the
   bet.*
2. **The honesty brand.** A research spine that *proved* the market is efficient and
   refuses to sell an edge. Structurally hard for tip-revenue competitors to copy
   without cannibalizing their own business. It's the trust that makes the social layer
   worth joining.
3. **Bilingual EN/日本語.** A segment moat the JP incumbents won't chase.
4. **Rigorous data + honest math** (the lake, PIT correctness, calibrated baseline, the
   WIDE-multi-win fix). Table stakes done right — necessary, not sufficient. Don't try
   to out-data netkeiba; win on trust + social + bilingual + clean UX.

**Moat in one line:** the only *trustworthy, bilingual, shared* place to research a
race with your friends.

## The build: four-weekend milestone plan

Each July weekend is a **live dress rehearsal** on a real summer graded card (the
Roundup cron already runs), with you + your friend as the first real users. Build on
what's shipped: the social layer (follows/cheers/profiles/feed/share), the impression
store, the Roundup, mark-card tickets, bilingual i18n.

**Weekend 1 — Shared reads.** Make impressions shareable: you and a followed friend can
see each other's marks (anchor/like/price/avoid) on a race, with a "compare our reads"
view. This is the conversation substrate — the smallest thing that turns solo research
into a shared session. *Outcome: you and your friend can see each other's reads on this
weekend's graded card.*

**Weekend 2 — The race conversation.** A lightweight per-race shared space for a friend
group: notes/comments tied to specific runners, and visibility into each other's
structured tickets. This is the "productive conversation" core — the OTB table, in the
app. *Outcome: a real back-and-forth about a race happens in-app, not in a side chat.*

**Weekend 3 — OTB/track mode + the on-ramp.** Phone-first polish for use at the OTB/rail
(fast, glanceable, the two-path entry), a newcomer first-run that decodes the card
(glossary surfaced in context), and an **invite-a-friend** flow — the network-effect
kickstart. *Outcome: a new friend can be invited, onboarded, and contributing reads
within one race.*

**Weekend 4 — The weekend ritual loop + launch hardening.** Close the loop:
Friday-research → Saturday/Sunday at the OTB → settle & recap, with a shareable
weekend-recap card. Plus reliability, performance, and the August launch checklist.
*Outcome: the full ritual works end-to-end and is ready to open up.*

Then **August**: open invites beyond your circle, seed a handful of friend-groups,
polish from their use — landing an "amazing app" before **Sep 27 (Sprinters Stakes)**,
when autumn-G1 attention makes the ramp land.

## North star & metrics (resist the tipster trap)

Do **not** optimize for betting volume or "hit rate" — that's the road to becoming a tip
seller and it kills the moat. The north star is **shared, productive research sessions.**

- Primary: **active friend-pairs/groups per race weekend** (two+ people sharing reads on
  the same race).
- Engagement: reads shared, races discussed, tickets co-built.
- Retention: do you *and your friend* come back next weekend (week-over-week pair
  retention) — the truest signal the ritual is real.
- Reach: bilingual usage split; invites sent → accepted.

## Risks to manage

- **Honesty under growth pressure.** The fastest revenue is selling picks; doing it
  forfeits the moat. Hold the line — the trust *is* the product.
- **Social cold-start.** Don't launch an empty public feed; seed friend-to-friend
  invites where the value is immediate (you + one friend = a working session).
- **Scope creep into a data arms race.** You won't beat netkeiba on data. Every weekend's
  build should serve *the shared conversation*, not feature parity.
- **Single-operator reliability.** The cron + CI-from-main hardening (done today) is the
  floor; a blank app during the ramp is fatal. Keep that discipline.

## Sources

- [JRA graded race schedule 2026 (japanracing.jp)](https://japanracing.jp/en/racing/schedule/graded/list/2026.html) · [Sprinters Stakes G1 — Sep 27, 2026](https://japanracing.jp/en/racing/schedule/graded/list/2026/0927sprinters.html) · [Japan Cup — Nov 29, 2026](https://japanracing.jp/en/racing/schedule/graded/list/2026/1129jc.html)
- [netkeiba (feature/market reference)](https://en.netkeiba.com/) · [netkeiba app listing](https://play.google.com/store/apps/details?id=jp.co.netdreamers.netkeiba&hl=en_US)
