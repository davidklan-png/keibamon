// ============================================================================
// Racing glossary — bilingual reference data for the in-app Glossary view.
//
// Source of truth: docs/racing-glossary.md. Keep this module in sync if the
// markdown changes (and vice-versa). glossary.test.ts pins the shape so a
// malformed section fails the suite.
//
// Each term carries: English label, 日本語 label (native script only — no
// romanization), and a short English explanation. The Glossary view matches a
// search query against all three fields.
//
// Editorial guardrails (enforced by glossary.test.ts): explanations are
// descriptive reference text. They must NOT contain advice / edge-claim
// language (guaranteed / sure thing / lock / beat the market / best bet). This
// mirrors the i18n honesty guardrails — the glossary is reference material, not
// a tip sheet.
// ============================================================================

export interface GlossaryTerm {
  en: string;
  ja: string;
  explanation: string;
}

export interface GlossarySection {
  id: string;
  titleEn: string;
  titleJa: string;
  terms: GlossaryTerm[];
}

export const GLOSSARY_SECTIONS: GlossarySection[] = [
  {
    id: "types",
    titleEn: "Race types, grades & classes",
    titleJa: "競走の種類・グレード・クラス",
    terms: [
      { en: "Flat race", ja: "平地競走", explanation: "A race on the flat (no jumps); the default JRA race type." },
      { en: "Jump race", ja: "障害競走", explanation: "A steeplechase or hurdle race over obstacles." },
      { en: "Grade 1", ja: "Ｇ１", explanation: "The highest tier of graded stakes; the championship-level races." },
      { en: "Grade 2", ja: "Ｇ２", explanation: "The second tier of graded stakes, just below G1." },
      { en: "Grade 3", ja: "Ｇ３", explanation: "The third tier of graded stakes." },
      { en: "Graded stakes", ja: "重賞", explanation: "Any G1, G2, or G3 race; the prestige races that define a season." },
      { en: "Listed race", ja: "リステッド競走", explanation: "A quality race one step below graded status." },
      { en: "Stakes race", ja: "重賞競走", explanation: "A prestige race offering added prize money." },
      { en: "Open class", ja: "オープン", explanation: "The top class, open to any horse regardless of past wins." },
      { en: "Allowance / condition race", ja: "条件戦", explanation: "A class restricted by number of career wins or earnings." },
      { en: "Maiden race (debut)", ja: "新馬", explanation: "A race for two-year-olds making their first start." },
      { en: "Maiden (winless)", ja: "未勝利", explanation: "A race for horses that have never won." },
      { en: "Non-graded open", ja: "平場", explanation: "An open-class race that is not graded." },
      { en: "Filly/mare only", ja: "牝馬限定", explanation: "A race restricted to female horses." },
      { en: "Juvenile", ja: "２歳戦", explanation: "Races for two-year-olds, the youngest racing age." },
    ],
  },
  {
    id: "tracks",
    titleEn: "Tracks & conditions",
    titleJa: "馬場・条件",
    terms: [
      { en: "Turf", ja: "芝", explanation: "A grass racing surface." },
      { en: "Dirt", ja: "ダート", explanation: "A dirt (sand) racing surface." },
      { en: "Surface", ja: "馬場", explanation: "The track surface itself (turf or dirt)." },
      { en: "Going / track condition", ja: "馬場状態", explanation: "The official state of the ground, from firm to heavy." },
      { en: "Firm", ja: "良", explanation: "Fast, dry going — the firmest condition." },
      { en: "Good-to-soft", ja: "稍重", explanation: "Slightly soft going, one step off firm." },
      { en: "Soft", ja: "重", explanation: "Soft, rain-affected going." },
      { en: "Heavy", ja: "不良", explanation: "The wettest, heaviest going; badly rain-affected." },
      { en: "Distance", ja: "距離", explanation: "Race length, measured in metres." },
      { en: "Furlong", ja: "ハロン", explanation: "One-eighth of a mile (~200 m); used for split timings." },
      { en: "Inside course", ja: "内回り", explanation: "The shorter, inner loop at courses that have two." },
      { en: "Outside course", ja: "外回り", explanation: "The longer, outer loop at courses that have two." },
      { en: "Homestretch", ja: "直線", explanation: "The final straight run to the finish line." },
      { en: "Corner", ja: "コーナー", explanation: "A bend on the course; JRA courses are right- or left-handed." },
    ],
  },
  {
    id: "mechanics",
    titleEn: "Race mechanics & running style",
    titleJa: "競走メカニクス・脚質",
    terms: [
      { en: "Starting gate", ja: "ゲート", explanation: "The stall each horse breaks from at the start." },
      { en: "Break / start", ja: "スタート", explanation: "The jump from the gate at the beginning of a race." },
      { en: "Slow start", ja: "出遅れ", explanation: "Breaking slowly and losing early position." },
      { en: "Bracket number", ja: "枠番", explanation: "A group number (1–8) used for betting; one bracket can hold up to three horses." },
      { en: "Horse number", ja: "馬番", explanation: "The individual number (1–18) a horse wears, the primary race key." },
      { en: "Post position / draw", ja: "枠番", explanation: "The gate position drawn before the race; inside draws are favored." },
      { en: "Pace", ja: "ペース", explanation: "The early speed of the race; fast pace tire horses, slow pace favors closers." },
      { en: "Front-runner", ja: "逃げ", explanation: "A horse that leads from the start and tries to wire the field." },
      { en: "Pace presser", ja: "先行", explanation: "A horse that runs near the lead, just behind the frontrunner." },
      { en: "Stalker", ja: "差し", explanation: "A horse that sits mid-pack and challenges late." },
      { en: "Closer", ja: "追込", explanation: "A horse that drops back and makes one late run from behind." },
      { en: "Pack", ja: "馬群", explanation: "The main group of horses racing together." },
      { en: "Final fraction", ja: "上がり", explanation: "The closing section time, usually the last three furlongs." },
      { en: "Furlong split", ja: "ハロンタイム", explanation: "The time taken over a single furlong section." },
    ],
  },
  {
    id: "horses",
    titleEn: "Horses & people",
    titleJa: "馬・関係者",
    terms: [
      { en: "Colt / horse", ja: "牡馬", explanation: "An intact male horse." },
      { en: "Filly / mare", ja: "牝馬", explanation: "A female horse." },
      { en: "Gelding", ja: "セン馬", explanation: "A castrated male horse." },
      { en: "Sire", ja: "種牡馬", explanation: "A stallion standing at stud; a horse's father." },
      { en: "Dam / broodmare", ja: "繁殖牝馬", explanation: "A mare kept for breeding; a horse's mother." },
      { en: "Pedigree", ja: "血統", explanation: "A horse's lineage and family record." },
      { en: "Pedigree registration no.", ja: "血統登録番号", explanation: "The unique 10-digit ID assigned to each horse (the horse_id join key)." },
      { en: "Jockey", ja: "騎手", explanation: "The rider." },
      { en: "Trainer", ja: "調教師", explanation: "The person who conditions and prepares the horse." },
      { en: "Owner", ja: "馬主", explanation: "The horse's registered owner." },
      { en: "Stable", ja: "厩舎", explanation: "A trainer's yard; all horses under one trainer." },
      { en: "Training center", ja: "トレーニングセンター", explanation: "The Miho or Ritto facility where horses are conditioned (Miho/美浦, Ritto/栗東)." },
    ],
  },
  {
    id: "betting",
    titleEn: "Betting / wagering",
    titleJa: "投票・オッズ",
    terms: [
      { en: "Pari-mutuel", ja: "パリミュチュエル", explanation: "The pool system where odds are set by the money wagered, not a bookmaker." },
      { en: "Win", ja: "単勝", explanation: "Bet on a horse to finish first." },
      { en: "Place", ja: "複勝", explanation: "Bet on a horse to finish in the top two (small fields) or top three." },
      { en: "Bracket quinella", ja: "枠連", explanation: "Pick the two brackets that finish first and second, any order." },
      { en: "Quinella", ja: "馬連", explanation: "Pick the two horses that finish first and second, any order." },
      { en: "Wide", ja: "ワイド", explanation: "Pick two horses to both finish in the top three, any order." },
      { en: "Exacta", ja: "馬単", explanation: "Pick the first two horses in exact finishing order." },
      { en: "Trio", ja: "三連複", explanation: "Pick the three horses that finish in the top three, any order." },
      { en: "Trifecta", ja: "三連単", explanation: "Pick the first three horses in exact finishing order." },
      { en: "Odds", ja: "オッズ", explanation: "The payout multiplier for a winning bet, set by the pool." },
      { en: "Payout", ja: "払戻金", explanation: "The yen returned on a winning bet, per 100-yen stake." },
      { en: "Pool", ja: "プール", explanation: "All money wagered on a bet type for one race, before takeout." },
      { en: "Vote count", ja: "票数", explanation: "The number of 100-yen tickets on a combination; true liquidity." },
      { en: "Takeout", ja: "控除率", explanation: "The percentage the track deducts from each pool before paying out." },
      { en: "Favorite", ja: "人気", explanation: "The betting public's most-backed horse; lowest odds." },
      { en: "Popularity rank", ja: "人気順", explanation: "A horse's rank by money wagered, 1st being the favorite." },
    ],
  },
  {
    id: "stats",
    titleEn: "Statistics & analysis",
    titleJa: "統計・分析",
    terms: [
      { en: "Speed figure", ja: "スピード指数", explanation: "A normalized number rating how fast a horse ran." },
      { en: "Pace figure", ja: "ペース指数", explanation: "A measure of how fast the early pace of a race was." },
      { en: "Class rating", ja: "クラス指数", explanation: "A number estimating the quality of competition a horse has faced." },
      { en: "Implied probability", ja: "暗黙確率", explanation: "1 / decimal odds, the win chance the market price implies before takeout." },
      { en: "Devigged probability", ja: "還元確率", explanation: "Implied probability with the track takeout removed, summing to 1 across the field." },
      { en: "Market baseline", ja: "市場ベースライン", explanation: "The no-skill benchmark model; devigged odds are the prediction." },
      { en: "Favorite-longshot bias", ja: "人気薄バイアス", explanation: "The tendency for longshots to be over-bet and favorites under-bet relative to true chance." },
      { en: "Calibration", ja: "較正", explanation: "Whether a model's predicted probabilities match observed outcome rates." },
      { en: "Walk-forward", ja: "ウォークフォワード", explanation: "Fitting on the past only, then rolling forward one race at a time to avoid leakage." },
      { en: "Point-in-time", ja: "ポイントインタイム", explanation: "A rule that a decision at time t may use only data with available_at <= t." },
      { en: "Backtest", ja: "バックテスト", explanation: "Replaying a strategy over historical races to estimate performance." },
      { en: "Return on investment", ja: "回収率", explanation: "Money returned divided by money wagered; the core profit metric." },
      { en: "Expected value", ja: "期待値", explanation: "Average return per bet if the same wager were repeated many times." },
      { en: "Log-loss", ja: "対数損失", explanation: "A probability-forecast accuracy score that penalizes confident wrong calls." },
      { en: "Brier score", ja: "ブライアスコア", explanation: "The mean squared error between predicted probabilities and outcomes." },
      { en: "Out-of-sample", ja: "サンプル外", explanation: "Evaluated on races the model was not trained on, the honest test of edge." },
    ],
  },
];

// Combined flat list (handy for search + count assertions).
export const ALL_GLOSSARY_TERMS: GlossaryTerm[] = GLOSSARY_SECTIONS.flatMap(
  (s) => s.terms,
);
