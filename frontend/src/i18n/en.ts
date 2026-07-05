// English dictionary. Keep keys in sync with ./ja.ts.
export const en = {
  app: {
    title: "Keibamon",
    subtitle: "競馬モン — turn race intuition into ticket shapes.",
    tagline:
      "Mix the odds with how you want to cheer. A recreational ticket-structure helper.",
    langToggle: "JA",
  },
  nav: {
    race: "Race",
    style: "Style",
    tickets: "Tickets",
    explain: "Why",
  },
  // Persistent bottom navigation bar (Session 1 UX refactor). Short labels for
  // the three top-level destinations, mapped onto the `view` enum
  // (browse / mine / reference). Kept terse so they fit the thumb-zone bar at
  // 390px width.
  tabs: {
    races: "Races",
    tickets: "Tickets",
    reference: "Reference",
  },
  // Single top-right account slot (Session 1 UX refactor). Signed-out
  // affordance that opens Clerk's sign-in modal.
  account: {
    signIn: "Sign in",
  },
  race: {
    title: "Pick a race",
    hint: "Start with the race date, then pick a featured race or choose from the full card.",
    live: "Live card",
    date: "Race date",
    popular: "Popular races",
    allRaces: "All races",
    selected: "Selected",
    raceDay: "Race day",
    runnersCount: "{count} runners",
    manual: "Sample card",
    reload: "Reload odds",
    runners: "Runners",
    oddsLabel: "Win odds",
    noLive: "No live card available. Start with a sample card.",
    liveUnavailable: "Live card unavailable. Sample card loaded.",
    placeholderRace: "(sample race)",
    standardCta: "Standard tickets · 3 picks",
    standardHint: "Style is optional refinement — adjust later.",
    refine: "Refine by style →",
    pendingTag: "odds pending",
    pendingBanner: "Registered — odds aren't open yet. Showing estimated odds; they'll update live when the pool opens.",
    estOdds: "est.",
    statusOpen: "odds open",
    statusRegistered: "registered",
    statusResult: "result",
    // ADR-0017: surface labels for the persistent race-context bar. The
    // publisher ships raw "turf"/"dirt" on LiveRace.surface; the bar localizes
    // it so JA reads 芝2000m and EN reads "turf 2000m".
    surfaceTurf: "turf",
    surfaceDirt: "dirt",
    // ADR-0017: aria-label for the persistent race-context bar (the bar's
    // contents are venue/R#/surface/status, so the label announces the whole
    // strip as "Race context" rather than reading the fragments flat).
    contextBar: "Race context",
    entriesPending: "Entries pending",
    // ADR-0016: inline runner-row mark control. aria-label for the unmarked
    // badge (visible to screen readers); the marked badge reuses
    // form.intuition.<kind> as its aria-label.
    markAdd: "Add a mark",
    // Clear chip in the expanded mark strip (also aria-label for the active
    // badge's "tap to clear" path).
    markClear: "Clear",
    rosterPending: "Roster pending — entries finalize closer to race day. Tap another race with a declared roster to start building tickets.",
  },
  style: {
    title: "Choose your style",
    hint: "Your play style decides the ticket shape.",
    budget: "Budget",
    unit: "Unit stake",
    advanced: "Advanced — fine-tune the shape",
    complexity: "Complexity",
    flavor: "Runner flavor",
    complexityAuto: "Let Keibamon choose",
    complexityTwo: "2-horse bets (quinella/wide/exacta)",
    complexityThree: "3-horse bets (trio/trifecta)",
    complexityStraight: "Ordered (exacta/trifecta)",
    flavorMixed: "Mix favorites and prices",
    flavorChalk: "I trust the favorites",
    flavorValue: "Find price horses",
  },
  // Session 3a: inline "Refine ▾" panel on the Tickets screen (the old Style
  // step, folded in). The panel body reuses the `style.*` / `personality.*`
  // strings; only the disclosure summary is new.
  refine: {
    summary: "Refine",
  },
  personality: {
    title: "Betting personality",
    safe: { name: "Safe-ish", desc: "Higher hit rate, smaller payouts." },
    balanced: { name: "Balanced", desc: "Plausible mix with fun upside." },
    longshot: { name: "Longshot Hunter", desc: "Chaos and bigger payouts." },
    fan: { name: "Fan Pick", desc: "Anchor tickets on one horse." },
    antiChalk: { name: "Anti-Chalk", desc: "Fade favorites, open up prices." },
  },
  tickets: {
    title: "Ticket ideas",
    remix: "Remix",
    backToStyle: "Change style",
    noCandidates: "No usable tickets for these constraints. Loosen them.",
    noRunners: "Add at least three runners first.",
    // ADR-0016: read-only echo of the marks set on Race. Header above the
    // chip strip; only renders when the race has ≥1 mark.
    yourMarks: "Your marks",
    resetStandard: "Reset to standard",
    topMix: "Top mix",
    variance: "High variance",
    lowVariance: "Low variance",
    lines: "Lines",
    cost: "Cost",
    ifHits: "If it hits",
    hitEst: "Hit est.",
    avgPayout: "Avg payout",
    wideBestCase: "Best 3-way hit",
    estReturn: "Expected return",
    estReturnLine: "Expected return per ¥100: ¥{ret} ({edge} house edge).",
    whyTicket: "Why this ticket",
    placeCta: "Place ticket",
    placeSignIn: "Sign in to place",
    updatedMarks: "Updated with your marks",
  },
  mood: {
    safer: "Safer",
    balanced: "Balanced",
    spicier: "Spicier",
  },
  betType: {
    quinella: "Quinella",
    wide: "Wide",
    exacta: "Exacta",
    trio: "Trio",
    trifecta: "Trifecta",
    bracket_quinella: "Bracket quinella",
  },
  manual: {
    title: "Build a ticket",
    editTitle: "Edit ticket",
    entryTitle: "Build manually",
    entryDesc: "Pick your own bet type and lines",
    betType: "Bet type",
    pickHorses: "Pick horses",
    pickBrackets: "Pick brackets",
    noBrackets: "Bracket data unavailable for this race — 枠連 disabled.",
    updateOdds: "Update odds",
    cancel: "Cancel",
    register: "Register",
    save: "Save",
    hitProb: "Hit chance",
    linesCount: "{n} lines",
    editAria: "Edit this ticket",
    editConflict: "Ticket settled during edit — restored.",
  },
  explain: {
    title: "Why this ticket",
    lead: "A {mood} bet. It costs {cost} and lands roughly {hit}% of the time.",
    detailsHeading: "The details",
    coverage: "Coverage",
    upside: "Upside",
    fragility: "Fragility",
    costLabel: "Cost",
    math: "How the math works",
    mathSummary: "Math and house edge",
    mathBody:
      "Odds → de-vigged win probs → Henery γ=0.856 ordering model for each ticket's hit probability. Payout applies typical JRA pool return ratios. Fair odds = 1 / hit probability.",
    close: "Close",
    back: "Back",
    fairValue: "Fair odds",
  },
  valueTag: {
    chalk: "Chalk",
    value: "Value",
    blend: "Blend",
  },
  // ADR-0007: "My Tickets" surface. NOTE: commit CTA is "Confirm" (not
  // "Lock it in") — "lock" is banned by guardrails.test.ts.
  mine: {
    home: "My tickets",
    newBet: "New bet",
    newTitle: "New bet",
    ticketTitle: "Ticket card",
    confirm: "Confirm",
    cost: "Cost",
    ifHits: "If it hits",
    returned: "Returned",
    unit: "Stake per line",
    live: "LIVE",
    result: "RESULT",
    hit: "HIT",
    miss: "MISS",
    refund: "REFUND",
    refunded: "Refunded",
    won: "You hit it",
    settled: "Settled",
    firming: "firming",
    drifting: "drifting",
    steady: "steady",
    post: "Post",
    toGo: "to post",
    raceDay: "Today’s feature",
    pickVibe: "Pick your vibe",
    safer: "Safer",
    balanced: "Balanced",
    spicier: "Spicier",
    saferDesc: "Lands often, gentle payout.",
    balancedDesc: "A real shot with fun upside.",
    spicierDesc: "Chaos — huge if it lands.",
    liveOdds: "Live odds",
    oddsRefresh: "updating live",
    finishOrder: "Finishing order",
    finishOrderUnavailable: "Result breakdown not available for this ticket.",
    watchResult: "Watch the result",
    settledToast: "You hit it! 🎉",
    tapShare: "Save & share",
    shareToast: "Ticket card copied — share away",
    share: "Share",
    shareFailed: "Couldn't export the card — try again.",
    cheer: "Cheer",
    cheering: "Cheered!",
    uncheered: "Un-cheered",
    cannotCheerOwn: "You can't cheer your own ticket.",
    rateLimited: "Too many actions — wait a moment and retry.",
    count: "{n} total",
    handle: "@you",
    setHandleTitle: "Pick your handle",
    setHandleHint: "This is how other players see you. You can change it later.",
    setHandlePlaceholder: "e.g. alyssa",
    setHandleCta: "Save handle",
    // ADR-0007 Phase 2 — server-first persistence + auto-settle strings.
    estimate: "estimate",
    empty: "No tickets yet — pick New bet to commit one.",
    offlineQueued: "Saved offline — will sync when you reconnect.",
    you: "You",
    communityCard: "{n} friends are on today’s card",
    friendsOnRace: "{n} friends on this race",
    browseRaces: "Browse races",
    // Open/Resolved split (history behind a toggle, collapsed by default).
    open: "Open",
    showHistory: "Show history ({n})",
    hideHistory: "Hide history",
    historyEmpty: "No resolved tickets yet",
    // Punter aggregates grid inside the history panel.
    stats: {
      hitMiss: "Hit/miss",
      wagered: "Wagered",
      returned: "Returned",
      net: "Net P/L",
      roi: "ROI",
      biggestWin: "Biggest win",
      biggestWinRace: "{name} · {date}",
      none: "—",
    },
  },
  // Session 2 UX refactor: honest signed-out empty state for the My Tickets
  // tab. Replaces the full SignInScreen so the bottom tab bar stays visible.
  // The marks-teaser surfaces locally-made impression marks (read from the
  // localStorage impression store) to motivate sign-in without fabricating a
  // server feed. N = distinct marked horses, M = distinct races with ≥1 mark.
  mineEmpty: {
    title: "Sign in to save your tickets",
    body: "Your tickets live on your account — sign in to keep them across devices.",
    teaser: "You’ve marked {n} horses across {m} races — sign in to save them.",
    teaserEmpty: "Mark horses as you research, then sign in to save your tickets.",
    signIn: "Sign in",
  },
  // ADR-0007 Phase 3 — public profiles + follow graph.
  profile: {
    title: "Player",
    followers: "{n} followers",
    following: "{n} following",
    follow: "Follow",
    unfollow: "Following",
    blockedSelfFollow: "You can't follow yourself.",
    noTickets: "No shared tickets yet.",
    back: "Back",
    // Phase 4 — block / report (moderation intake).
    block: "Block",
    unblock: "Unblock",
    blocked: "Blocked.",
    report: "Report",
    reportReason: "Tell us what's wrong",
    reportSent: "Report sent.",
    cannotBlockSelf: "You can't block yourself.",
  },
  // ADR-0007 Phase 1 — Clerk auth + age self-attestation.
  auth: {
    signInTitle: "Sign in to Keibamon",
    signInCta: "Continue with email or social",
    signInSubtitle:
      "Recreational ticket ideas for the weekend's card.",
    signInLegal:
      "Recreational use only. Under-20 betting is prohibited by law.",
    ageTitle: "Before you continue",
    ageConfirm: "I confirm I'm 20 or older and acknowledge the disclaimer below",
    ageContinue: "Continue",
    ageDeclineNote:
      "You can browse without signing in. Betting is restricted to those 20+.",
    // Single app-wide disclaimer — acknowledged once at the 20+ gate. The four
    // required clauses (not betting advice / winning method / profit guarantee /
    // takeout) are scanned by guardrails.test.ts so they can't drift.
    disclaimer:
      "Recreational research only. Not betting advice, not a winning method, not a profit guarantee. Pool takeout applies to every ticket.",
  },
  footer: {
    back: "Keibamon home",
  },
  // Reference section — bilingual glossary + weekend graded-stakes roundup.
  // Research framing only; never betting advice, never an edge claim. Copy is
  // scanned by guardrails.test.ts (no "guaranteed / sure thing / lock / beat
  // the market") and by weeklyReport.test.ts (no "best bet").
  reference: {
    tab: "Reference",
    home: "Reference",
    title: "Reference",
    subtitle: "Bilingual racing glossary.",
    glossary: "Glossary",
    roundup: "Weekend roundup",
    back: "Back to race builder",
  },
  glossary: {
    title: "Racing glossary",
    subtitle: "Bilingual reference — English / 日本語.",
    search: "Search terms…",
    noMatch: "No terms match that search.",
    columnEn: "English",
    columnJa: "日本語",
    columnWhat: "Explanation",
  },
  roundup: {
    title: "Weekend roundup",
    subtitle: "Point-in-time research on the weekend's graded stakes.",
    edition: "Edition",
    friday: "Friday edition",
    saturday: "Saturday refresh",
    glance: "Weekend at a glance",
    headline: "Weekend headline",
    asOf: "as of {time}",
    deepDives: "Race-by-race",
    themes: "Weekend themes",
    watchlist: "Odds movement watchlist",
    lens: "Keibamon ticket lens",
    notYet: "Coming this weekend",
    emptyTitle: "No roundup published yet",
    emptyCadence:
      "The Friday edition lands once weekend gates and entries are final; a Saturday refresh follows when live odds open. Check back on race weekend.",
    upcoming: "Upcoming graded stakes",
    noUpcoming: "No graded stakes registered on this card yet.",
    freshness: "Data freshness",
    generator: "Generator version",
    publishedAt: "Published",
    oddsAt: "Odds snapshot",
    gateAt: "Gate snapshot",
    cardAt: "Card snapshot",
    conditionAt: "Track condition",
    pending: "pending",
    est: "estimated",
    field: "Field",
    postTime: "Post",
    favorites: "Top favorites",
    draws: "Notable draws",
    going: "Going / weather",
    why: "Why this race matters",
    market: "Market shape",
    gateImpact: "Gate / draw impact",
    pace: "Pace map",
    contenders: "Contender groups",
    core: "Core contenders",
    coreDesc:
      "The market's shortest-priced runners (~6.0 or lower) — the horses most likely to be involved at the finish.",
    price: "Price horses",
    priceDesc:
      "Mid-market runners (~6–20) with a realistic shot at the frame — the tier most exotic tickets lean on for value.",
    fragile: "Fragile favorites",
    fragileDesc:
      "Short-priced favorites (~5.0 or lower) carrying a flagged weakness — worth watching, not worth assuming.",
    chaos: "Chaos slots",
    chaosDesc:
      "The longest-priced runners on the card — included mainly to widen exotic combinations, not as a genuine forecast.",
    trend: "Trend analysis",
    tickets: "Ticket construction notes",
    buildTickets: "Build tickets from my {n} reads",
    safeish: "Safe-ish",
    balanced: "Balanced",
    spicy: "Spicy / Longshot Hunter",
    cost: "Cost",
    rationale: "Why this shape",
    risk: "Risk",
    lensSafeish: "Best race for Safe-ish",
    lensBalanced: "Best race for Balanced",
    lensLongshot: "Best race for Longshot Hunter",
    lensFragile: "Most fragile favorite",
    lensSimplify: "Best race to keep simple",
    signal: {
      firming: "firming",
      drifting: "drifting",
      steady: "steady",
      unknown: "—",
    },
  },
  // Milestone 4: form/context panel — recreational context to shape
  // intuition, NOT an edge claim, tip, or advice. Copy stays descriptive
  // (starts / win% / splits / market-vs-result note). Guardrail words
  // "guaranteed / sure thing / lock / beat the market" are BANNED and
  // checked by guardrails.test.ts. "anchor" is the user's mark label, not
  // the betting sense of "lock".
  form: {
    title: "Form",
    subtitle: "Context to shape your intuition.",
    career: "Career",
    starts: "{n} starts",
    record: "{wins}-{top3} (win {win}% · top3 {top3Pct}%)",
    noStarts: "No recorded starts yet.",
    recentTitle: "Recent finishes",
    splitsTitle: "Splits",
    // Inline subtitle after "Splits" — explains what the dash notation means.
    // Chip itself uses `recordChip` (e.g. "3W / 7") so this is the section
    // framing: wins from starts, sliced by surface / distance / going.
    splitsSubtitle: "wins from starts by condition",
    // Chip notation: 3 wins from 7 starts. Replaces the opaque "7-3" that
    // first-timers couldn't parse (looked like a score/tie).
    recordChip: "{wins}W / {starts}",
    surface: "Surface",
    distance: "Distance",
    going: "Going",
    wet: "Wet",
    dry: "Dry",
    styleTitle: "Running style",
    styleNote: "A rough proxy from finish + closing split.",
    marketTitle: "Market vs result",
    marketNote: {
      outrun: "Tends to outrun the market odds.",
      runsToOdds: "Tends to run to the market odds.",
      neutral: "Around the market odds.",
    },
    jockeyTitle: "Jockey",
    jockeyCareer: "Jockey career",
    jockeyCombos: "Top combos",
    // Inline subtitle after "Top combos" — same notation fix as splits.
    combosSubtitle: "wins from mounts",
    jockeyNoId: "Jockey context coming soon.",
    noHistory: "No past form on record for this runner.",
    horseNoHistory: "No past form on record for this horse.",
    jockeyNoHistory: "No past form on record for this jockey.",
    backToTickets: "Back to tickets",
    loadError: "Couldn't load form — try again.",
    retry: "Retry",
    // When the form endpoints aren't deployed yet (404 in production as of
    // 2026-06-25). Distinct from loadError — no Retry, just context.
    comingSoonTitle: "Coming this weekend",
    comingSoonBody:
      "Form context lands soon — the betting loop works as usual.",
    close: "Close",
    tapHint: "Tap a runner for form context.",
    intuitionTitle: "Your mark",
    intuition: {
      like: "Like",
      distrust: "Distrust",
      priceHorse: "Price horse",
      avoid: "Avoid",
      anchor: "Anchor",
    },
    intuitionHint: "Marks shape your ticket — they don't predict outcomes.",
  },
  // ADR-0011 Phase 2 — two-path entry (Quick ticket / Research) + odds-drift
  // chip. Both lanes share the same drill-down + impression store, so a mark
  // made on either surface shows on the other. Copy stays factual: the drift
  // chip describes the change, never recommends a wager. Guardrail-clean (no
  // "lock / guaranteed / sure thing / beat the market").
  lane: {
    quick: "Quick ticket",
    research: "Research",
    quickHint:
      "Jump straight to building tickets from the live card.",
    researchHint:
      "Open the weekend roundup and drill into any contender.",
    introTitle: "Two ways in",
    switchedTo: "Lane saved",
    // aria-label for the in-view segmented control (Session 1 UX refactor —
    // lane choice moved out of the header into the Races view).
    pickLane: "Choose how to start",
  },
  drift: {
    likedAt: "marked at",
    nowAt: "now",
    shorter: "shorter",
    longer: "longer",
  },
  // ADR-0011 Phase 3a — set-family box view (Option A) + fill guide (Option B).
  // Renders the user's OWN marked set as one box per bet type. Descriptive
  // copy only; never betting advice. Guardrail-clean (no lock/guaranteed/
  // sure thing/beat the market).
  setFamily: {
    title: "Box these horses",
    boxThese: "Box these {n} horses",
    points: "pts",
    cost: "Cost",
    hitProb: "Hit est.",
    bestCase: "If it hits",
    bracketQuinella: "Bracket quinella",
  },
  fillGuide: {
    title: "Fill guide",
    box: "BOX",
    formation: "FORMATION",
    wheel: "WHEEL",
    axis: "axis",
    ordered: "Ordered finish",
    pos1: "1st",
    pos2: "2nd",
    pos3: "3rd",
    unit: "Points",
    total: "Total",
    perPoint: "Per point",
    share: "Share",
  },
  formation: {
    title: "Ordered boxes",
  },
  wheel: {
    title: "Axis wheels",
  },
};
