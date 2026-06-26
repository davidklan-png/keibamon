# Racing Glossary

A bilingual reference for horse-racing terms used across this project, covering
JRA (Japan Racing Association) and international English usage side by side.
Japanese is shown in native script only (kanji and kana) — no romanization or
reading aids — so each entry is what you would actually see on a race card,
betting ticket, or in the JV-Data spec.

## Race types, grades & classes

| English | 日本語 | Explanation |
|---|---|---|
| Flat race | 平地競走 | A race on the flat (no jumps); the default JRA race type. |
| Jump race | 障害競走 | A steeplechase or hurdle race over obstacles. |
| Grade 1 | Ｇ１ | The highest tier of graded stakes; the championship-level races. |
| Grade 2 | Ｇ２ | The second tier of graded stakes, just below G1. |
| Grade 3 | Ｇ３ | The third tier of graded stakes. |
| Graded stakes | 重賞 | Any G1, G2, or G3 race; the prestige races that define a season. |
| Listed race | リステッド競走 | A quality race one step below graded status. |
| Stakes race | 重賞競走 | A prestige race offering added prize money. |
| Open class | オープン | The top class, open to any horse regardless of past wins. |
| Allowance / condition race | 条件戦 | A class restricted by number of career wins or earnings. |
| Maiden race (debut) | 新馬 | A race for two-year-olds making their first start. |
| Maiden (winless) | 未勝利 | A race for horses that have never won. |
| Non-graded open | 平場 | An open-class race that is not graded. |
| Filly/mare only | 牝馬限定 | A race restricted to female horses. |
| Juvenile | ２歳戦 | Races for two-year-olds, the youngest racing age. |

## Tracks & conditions

| English | 日本語 | Explanation |
|---|---|---|
| Turf | 芝 | A grass racing surface. |
| Dirt | ダート | A dirt (sand) racing surface. |
| Surface | 馬場 | The track surface itself (turf or dirt). |
| Going / track condition | 馬場状態 | The official state of the ground, from firm to heavy. |
| Firm | 良 | Fast, dry going — the firmest condition. |
| Good-to-soft | 稍重 | Slightly soft going, one step off firm. |
| Soft | 重 | Soft, rain-affected going. |
| Heavy | 不良 | The wettest, heaviest going; badly rain-affected. |
| Distance | 距離 | Race length, measured in metres. |
| Furlong | ハロン | One-eighth of a mile (~200 m); used for split timings. |
| Inside course | 内回り | The shorter, inner loop at courses that have two. |
| Outside course | 外回り | The longer, outer loop at courses that have two. |
| Homestretch | 直線 | The final straight run to the finish line. |
| Corner | コーナー | A bend on the course; JRA courses are right- or left-handed. |

## Race mechanics & running style

| English | 日本語 | Explanation |
|---|---|---|
| Starting gate | ゲート | The stall each horse breaks from at the start. |
| Break / start | スタート | The jump from the gate at the beginning of a race. |
| Slow start | 出遅れ | Breaking slowly and losing early position. |
| Bracket number | 枠番 | A group number (1–8) used for betting; one bracket can hold up to three horses. |
| Horse number | 馬番 | The individual number (1–18) a horse wears, the primary race key. |
| Post position / draw | 枠番 | The gate position drawn before the race; inside draws are favored. |
| Pace | ペース | The early speed of the race; fast pace tire horses, slow pace favors closers. |
| Front-runner | 逃げ | A horse that leads from the start and tries to wire the field. |
| Pace presser | 先行 | A horse that runs near the lead, just behind the frontrunner. |
| Stalker | 差し | A horse that sits mid-pack and challenges late. |
| Closer | 追込 | A horse that drops back and makes one late run from behind. |
| Pack | 馬群 | The main group of horses racing together. |
| Final fraction | 上がり | The closing section time, usually the last three furlongs. |
| Furlong split | ハロンタイム | The time taken over a single furlong section. |

## Horses & people

| English | 日本語 | Explanation |
|---|---|---|
| Colt / horse | 牡馬 | An intact male horse. |
| Filly / mare | 牝馬 | A female horse. |
| Gelding | セン馬 | A castrated male horse. |
| Sire | 種牡馬 | A stallion standing at stud; a horse's father. |
| Dam / broodmare | 繁殖牝馬 | A mare kept for breeding; a horse's mother. |
| Pedigree | 血統 | A horse's lineage and family record. |
| Pedigree registration no. | 血統登録番号 | The unique 10-digit ID assigned to each horse (the `horse_id` join key). |
| Jockey | 騎手 | The rider. |
| Trainer | 調教師 | The person who conditions and prepares the horse. |
| Owner | 馬主 | The horse's registered owner. |
| Stable | 厩舎 | A trainer's yard; all horses under one trainer. |
| Training center | トレーニングセンター | The Miho or Ritto facility where horses are conditioned (Miho/美浦, Ritto/栗東). |

## Betting / wagering

| English | 日本語 | Explanation |
|---|---|---|
| Pari-mutuel | パリミュチュエル | The pool system where odds are set by the money wagered, not a bookmaker. |
| Win | 単勝 | Bet on a horse to finish first. |
| Place | 複勝 | Bet on a horse to finish in the top two (small fields) or top three. |
| Bracket quinella | 枠連 | Pick the two brackets that finish first and second, any order. |
| Quinella | 馬連 | Pick the two horses that finish first and second, any order. |
| Wide | ワイド | Pick two horses to both finish in the top three, any order. |
| Exacta | 馬単 | Pick the first two horses in exact finishing order. |
| Trio | 三連複 | Pick the three horses that finish in the top three, any order. |
| Trifecta | 三連単 | Pick the first three horses in exact finishing order. |
| Odds | オッズ | The payout multiplier for a winning bet, set by the pool. |
| Payout | 払戻金 | The yen returned on a winning bet, per 100-yen stake. |
| Pool | プール | All money wagered on a bet type for one race, before takeout. |
| Vote count | 票数 | The number of 100-yen tickets on a combination; true liquidity (the `H1` field). |
| Takeout | 控除率 | The percentage the track deducts from each pool before paying out. |
| Favorite | 人気 | The betting public's most-backed horse; lowest odds. |
| Popularity rank | 人気順 | A horse's rank by money wagered, 1st being the favorite. |

## Statistics & analysis

| English | 日本語 | Explanation |
|---|---|---|
| Speed figure | スピード指数 | A normalized number rating how fast a horse ran. |
| Pace figure | ペース指数 | A measure of how fast the early pace of a race was. |
| Class rating | クラス指数 | A number estimating the quality of competition a horse has faced. |
| Implied probability | 暗黙確率 | `1 / decimal odds`, the win chance the market price implies before takeout. |
| Devigged probability | 還元確率 | Implied probability with the track takeout removed, summing to 1 across the field. |
| Market baseline | 市場ベースライン | The no-skill benchmark model (Model 0); devigged odds are the prediction. |
| Favorite-longshot bias | 人気薄バイアス | The tendency for longshots to be over-bet and favorites under-bet relative to true chance. |
| Calibration | 較正 | Whether a model's predicted probabilities match observed outcome rates. |
| Walk-forward | ウォークフォワード | Fitting on the past only, then rolling forward one race at a time to avoid leakage. |
| Point-in-time | ポイントインタイム | A rule that a decision at time `t` may use only data with `available_at <= t`. |
| Backtest | バックテスト | Replaying a strategy over historical races to estimate performance. |
| Return on investment | 回収率 | Money returned divided by money wagered; the core profit metric. |
| Expected value | 期待値 | Average return per bet if the same wager were repeated many times. |
| Log-loss | 対数損失 | A probability-forecast accuracy score that penalizes confident wrong calls. |
| Brier score | ブライアスコア | The mean squared error between predicted probabilities and outcomes. |
| Out-of-sample | サンプル外 | Evaluated on races the model was not trained on, the honest test of edge. |
