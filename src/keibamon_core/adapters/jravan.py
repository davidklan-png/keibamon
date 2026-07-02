"""JRA-VAN source adapter (silver parsing).

Mirrors NetkeibaSourceAdapter: the live PULL is done elsewhere (the Windows-only
JV-Link worker in tools/jravan/, since JV-Link is 32-bit COM). This adapter runs
on any platform and turns the RAW bronze snapshots written by that worker
(data/raw/jravan/<snapshot_id>/<spec>.ndjson.gz) into canonical silver records.

Bronze stores records exactly as received (Shift-JIS text, decoded to a Python
str on ingest + the source-metadata fields). All JV-Data field parsing lives
here so it can be replayed when the spec understanding improves -- this is the
right home for the fixed-byte field maps and for the data-quality trap rules.

WHY BYTE OFFSETS, NOT STRING INDICES
------------------------------------
JV-Data field positions in the spec PDF are measured in *Shift-JIS bytes*. Full-
width Japanese characters are 2 bytes in Shift-JIS but 1 char in a decoded
Python str, so an RA record is 1272 bytes / 1133 chars -- a 139-position drift.
Slicing the decoded str by spec offsets therefore misaligns every field after
the first kana/kanji. We re-encode each record back to cp932 (Shift-JIS) and
slice on BYTES, then decode each field. See parse_fixed().

Bronze stored the *decoded* str rather than raw bytes; round-tripping str ->
cp932 is lossless for valid JV-Data, and parse_fixed asserts the re-encoded
length matches the record's expected length so a bad round-trip fails loudly
rather than silently shifting fields. (If we ever see round-trip failures in
the wild, the durable fix is to have the bronze worker persist raw bytes,
e.g. base64, for true replayability -- tracked as a follow-on, not needed now.)
"""
from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

ENCODING = "cp932"  # Microsoft superset of Shift-JIS; what JV-Link emits.


# --------------------------------------------------------------------------- #
# Field spec
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Field:
    """One fixed-width field. ``start``/``length`` are BYTE positions (0-indexed)
    into the cp932-encoded record, exactly as printed in the JV-Data spec PDF."""

    name: str
    start: int
    length: int
    kind: str = "str"


# kind -> converter(decoded_stripped_str) -> typed value (or None when blank).
def _to_int(s: str) -> int | None:
    s = s.strip()
    return int(s) if s.isdigit() else None


def _to_date8(s: str) -> str | None:
    """YYYYMMDD -> YYYY-MM-DD ISO date string (None if not 8 digits)."""
    s = s.strip()
    return f"{s[0:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 and s.isdigit() else None


def _to_time_mmssf(s: str) -> float | None:
    """JV finish time 'MSST' -> seconds. '1234' = 1 min 23.4 s -> 83.4.

    Spec: SE.走破タイム is '9分99秒9' (1+2+1 digits). '0000' = unset and '9999'
    = DNF/excluded sentinel, both -> None.
    """
    s = s.strip()
    if not s.isdigit() or s in ("0000", "9999") or int(s) == 0:
        return None
    tenths = int(s[-1])
    secs = int(s[-3:-1])
    mins = int(s[:-3]) if len(s) > 3 else 0
    return mins * 60 + secs + tenths / 10


def _to_furlong(s: str) -> float | None:
    """Furlong split '999' -> seconds (99.9s scale, /10). '000' = unset -> None.
    NB: SE/RA last-4F is a phantom default '000' (see DATA_TRAPS); use last-3F."""
    s = s.strip()
    if not s.isdigit() or int(s) == 0 or s == "999":
        return None
    return int(s) / 10


def _to_tenths_sec(s: str) -> float | None:
    """HC/WC training times in units of 0.1 s -> seconds. '0556' -> 55.6; '160' ->
    16.0. Length-agnostic (HC has 3- and 4-byte fields, WC likewise). All-zeros
    '0000'/'000' = not measured -> None; all-nines '9999'/'999' = over cap -> None."""
    s = s.strip()
    if not s.isdigit() or int(s) == 0:
        return None
    if set(s) == {"9"}:
        return None
    return int(s) / 10


def _tenths_kg(s: str) -> float | None:
    """Carried weight '負担重量' in units of 0.1 kg -> kg. '550' -> 55.0."""
    v = _to_int(s)
    return v / 10 if v else None


def _odds_x10(s: str) -> float | None:
    """Win odds in units of 0.1 -> decimal odds. '0035' -> 3.5; '9999'/0 -> None."""
    v = _to_int(s)
    return None if not v or v == 9999 else v / 10


CONVERTERS: dict[str, Callable[[str], object]] = {
    "str": lambda s: s.strip(),
    "int": _to_int,
    "date8": _to_date8,
    "time_mmssf": _to_time_mmssf,
    "furlong": _to_furlong,
    "tenths_sec": _to_tenths_sec,
    "tenths_kg": _tenths_kg,
    "odds_x10": _odds_x10,
}


# JV-Data 2009.トラックコード -> canonical surface (schemas.Race.surface).
#   10-22 平地 芝 = turf | 23-26,29 平地 ダート = dirt | 27-28 平地 サンド = synthetic
#   51-59 障害 (jump, mostly turf) = turf | 00/other = unknown
def track_code_to_surface(code: str) -> str:
    c = code.strip()
    if not c.isdigit():
        return "unknown"
    n = int(c)
    if 10 <= n <= 22 or 51 <= n <= 59:
        return "turf"
    if n in (23, 24, 25, 26, 29):
        return "dirt"
    if n in (27, 28):
        return "synthetic"
    return "unknown"


# JV-Data 2011.天候コード -> label. 0 = unset.
WEATHER_CODES: dict[str, str] = {
    "1": "fine", "2": "cloudy", "3": "rain", "4": "drizzle", "5": "snow", "6": "light_snow",
}

# JV-Data 2010.馬場状態コード -> ordinal "wetness" 1-4 (良/稍重/重/不良). 0 = unset.
# Neutral labels; JRA's exact 欧字名 differ turf vs dirt (Firm/Good/Yielding/Soft vs
# Standard/Good/Muddy/Sloppy) -- use the ordinal + surface for analysis.
GOING_LABELS: dict[int, str] = {1: "firm", 2: "good", 3: "soft", 4: "heavy"}


def weather_label(code: str | None) -> str | None:
    return WEATHER_CODES.get((code or "").strip())


def going_wetness(code: str | None) -> int | None:
    """馬場状態コード -> ordinal wetness 1 (firm) .. 4 (heavy); None if unset/invalid."""
    c = (code or "").strip()
    return int(c) if c in ("1", "2", "3", "4") else None


def going_label(code: str | None) -> str | None:
    w = going_wetness(code)
    return GOING_LABELS.get(w) if w else None


# JV-Data 2003.グレードコード -> normalized grade label. Derived from the spec
# code table (sheet5 of JV-Data仕様書_4.9.0.1.xlsx) and validated against the
# distinct grade_code values present in jravan_races (A/B/C/D/E/F/G/H/L).
#   A=G1(平地)   B=G2(平地)   C=G3(平地)
#   D=グレードのない重賞   E=重賞以外の特別   L=リステッド     -> not graded
#   F=J・G1(障害)  G=J・G2(障害)  H=J・G3(障害)
# D / E / L / NULL / unknown -> None (not a graded race).
GRADE_CODE_MAP: dict[str, str] = {
    "A": "G1", "B": "G2", "C": "G3",        # flat graded
    "F": "JG1", "G": "JG2", "H": "JG3",     # jump graded
}

# The default "live odds = graded only" set (ADR-0003/0004 polite-volume policy).
# JRA flat grades only. Jump grades (JG1/JG2/JG3) are out by default -- add them
# here (one-line change) to include jump-graded racing.
#
# NOTE on JpnI/II/III: per the JV-Data spec 特記事項, the international-G vs
# domestic-Jpn distinction is NOT encoded in grade_code -- code A covers BOTH G1
# and JpnI (likewise B->G2/JpnII, C->G3/JpnIII; e.g. かしわ記念=Jpn1 carries
# code A). The disambiguating "国際格付けを持つ重賞レース一覧" CSV has been
# deprecated since 2011, so JpnI/II/III races pass through as "G1"/"G2"/"G3" and
# cannot be filtered out at the grade_code layer.
GRADED_DEFAULT: tuple[str, ...] = ("G1", "G2", "G3")


def grade_label(code: str | None) -> str | None:
    """JV-Data 2003.グレードコード -> normalized grade label, or None.

    Non-graded / listed / unknown codes map to None. See :data:`GRADE_CODE_MAP`
    and :data:`GRADED_DEFAULT` for the policy notes (incl. the Jpn conflation).
    """
    return GRADE_CODE_MAP.get((code or "").strip())


# --------------------------------------------------------------------------- #
# Record layouts.  ALL offsets are BYTE positions from the JV-Data spec PDF.
#
# Status legend in comments:
#   [confirmed]  verified against real bronze records in this snapshot
#   [SPEC]       MUST be filled / verified from the JV-Data spec PDF
#                (D:\JRA-VAN\reference on the PC) before trusting the value
#
# The leading header (record_spec .. race_num) is identical across race-bound
# records and is [confirmed]. Everything past the race id needs the PDF.
# --------------------------------------------------------------------------- #
_RACE_ID_HEADER: list[Field] = [
    Field("record_spec", 0, 2, "str"),    # [confirmed] "RA","SE","HR","O1"...
    Field("data_kubun", 2, 1, "str"),     # [confirmed] create/update/delete flag
    Field("make_date", 3, 8, "date8"),    # [confirmed] file build date
    Field("year", 11, 4, "int"),          # [confirmed] race year
    Field("month_day", 15, 4, "str"),     # [confirmed] MMDD
    Field("jyo_code", 19, 2, "str"),      # [confirmed] racecourse code
    Field("kaiji", 21, 2, "int"),         # [confirmed] meeting number
    Field("nichiji", 23, 2, "int"),       # [confirmed] day-of-meeting
    Field("race_num", 25, 2, "int"),      # [confirmed] race number
]

# Offsets below are filled from JV-Data仕様書_4.9.0.1.pdf. The spec lists 位置
# as a 1-indexed byte position; Field.start is that minus 1 (0-indexed bytes).
RECORD_LAYOUTS: dict[str, list[Field]] = {
    # RA = race detail (1270 data bytes). Item numbers reference the spec table.
    "RA": _RACE_ID_HEADER + [
        Field("race_name", 32, 60, "str"),        # 12 競走名本題 (pos 33, 全角30)
        Field("race_name_short", 572, 20, "str"), # 18 競走名略称10文字 (pos 573)
        Field("grade_code", 614, 1, "str"),       # 23 グレードコード (pos 615)
        Field("race_type_code", 616, 2, "str"),   # 25 競走種別コード (pos 617)
        Field("distance_m", 697, 4, "int"),       # 34 距離 (pos 698, metres)
        Field("track_code", 705, 2, "str"),       # 36 トラックコード (pos 706) -> surface
        Field("post_time", 873, 4, "str"),        # 44 発走時刻 (pos 874, hhmm JST)
        Field("entry_count", 881, 2, "int"),      # 46 登録頭数 (pos 882)
        Field("starter_count", 883, 2, "int"),    # 47 出走頭数 (pos 884)
        Field("weather_code", 887, 1, "str"),     # 49 天候コード (pos 888)
        Field("turf_going_code", 888, 1, "str"),  # 50 芝馬場状態コード (pos 889)
        Field("dirt_going_code", 889, 1, "str"),  # 51 ダート馬場状態コード (pos 890)
        Field("last_3f", 975, 3, "furlong"),      # 56 後3ハロン (pos 976, populated)
        Field("last_4f", 978, 3, "furlong"),      # 57 後4ハロン (pos 979, PHANTOM)
    ],
    # SE = horse-in-race (entry + result), 553 data bytes.
    "SE": _RACE_ID_HEADER + [
        Field("wakuban", 27, 1, "int"),            # 10 枠番 (pos 28)
        Field("umaban", 28, 2, "int"),             # 11 馬番 (pos 29)
        Field("ketto_num", 30, 10, "str"),         # 12 血統登録番号 (pos 31) horse_id
        Field("bamei", 40, 36, "str"),             # 13 馬名 (pos 41, 全角18)
        Field("sex_code", 78, 1, "str"),           # 15 性別コード (pos 79)
        Field("horse_age", 82, 2, "int"),          # 18 馬齢 (pos 83)
        Field("trainer_code", 85, 5, "str"),       # 20 調教師コード (pos 86)
        Field("owner_code", 98, 6, "str"),         # 22 馬主コード (pos 99)
        Field("carried_weight_kg", 288, 3, "tenths_kg"),  # 26 負担重量 (pos 289, 0.1kg)
        Field("blinker_code", 294, 1, "str"),      # 28 ブリンカー使用区分 (pos 295)
        Field("jockey_code", 296, 5, "str"),       # 30 騎手コード (pos 297)
        Field("body_weight", 324, 3, "int"),       # 36 馬体重 (pos 325, kg; 999/000 sentinel)
        Field("body_weight_sign", 327, 1, "str"),  # 37 増減符号 (pos 328)
        Field("body_weight_delta", 328, 3, "int"), # 38 増減差 (pos 329)
        Field("abnormal_code", 331, 1, "str"),     # 39 異常区分コード (pos 332)
        Field("line_order", 332, 2, "int"),        # 40 入線順位 (pos 333, pre-DQ)
        Field("finish_position", 334, 2, "int"),   # 41 確定着順 (pos 335, official)
        Field("finish_time", 338, 4, "time_mmssf"),# 44 走破タイム (pos 339)
        Field("margin_code", 342, 3, "str"),       # 45 着差コード (pos 343)
        Field("win_odds", 359, 4, "odds_x10"),     # 52 単勝オッズ (pos 360, 0.1)
        Field("popularity", 363, 2, "int"),        # 53 単勝人気順 (pos 364)
        Field("last_4f", 387, 3, "furlong"),       # 58 後4ハロンタイム (pos 388, PHANTOM)
        Field("last_3f", 390, 3, "furlong"),       # 59 後3ハロンタイム (pos 391, populated)
    ],
    # "HR" payout, "O1".."O6" odds pools, "UM" horse master, "TM" TimeMining,
    # "DM" DataMining, "KS" jockey, "CH" trainer -- add from the PDF as needed.

    # HC = 坂路調教 (slope training), 58 data bytes. Horse-keyed (NOT race-keyed)
    # so does NOT use _RACE_ID_HEADER. Offsets [confirmed] vs real bronze + spec
    # JV-Data4901 §22. Times are tenths of a second; 0000/000 = not measured.
    "HC": [
        Field("record_spec", 0, 2, "str"),       # "HC"
        Field("data_kubun", 2, 1, "str"),        # 1=data, 0=delete
        Field("make_date", 3, 8, "date8"),       # delivery date (NOT the event)
        Field("center", 11, 1, "str"),           # トレセン 0=美浦, 1=栗東
        Field("train_date", 12, 8, "date8"),     # 調教年月日 -- the event date
        Field("train_time", 20, 4, "str"),       # 時刻 HHMM JST
        Field("horse_id", 24, 10, "str"),        # 血統登録番号
        Field("f4_total", 34, 4, "tenths_sec"),  # 800→0m total
        Field("lap_800_600", 38, 3, "tenths_sec"),
        Field("f3_total", 41, 4, "tenths_sec"),  # 600→0m total
        Field("lap_600_400", 45, 3, "tenths_sec"),
        Field("f2_total", 48, 4, "tenths_sec"),  # 400→0m total
        Field("lap_400_200", 52, 3, "tenths_sec"),
        Field("last_1f", 55, 3, "tenths_sec"),   # 200→0m -- the money field
    ],
    # WC = ウッドチップ調教 (woodchip training), 103 data bytes. Same header as HC
    # (rec/kubun/make_date/center/train_date/train_time/horse_id), then course
    # metadata + 9 cumulative total/lap pairs (10F→2F) + last-1F. Offsets
    # [confirmed] vs real bronze + spec JV-Data4901 §32.
    "WC": [
        Field("record_spec", 0, 2, "str"),
        Field("data_kubun", 2, 1, "str"),
        Field("make_date", 3, 8, "date8"),
        Field("center", 11, 1, "str"),           # 0=美浦, 1=栗東
        Field("train_date", 12, 8, "date8"),
        Field("train_time", 20, 4, "str"),
        Field("horse_id", 24, 10, "str"),
        Field("course_code", 34, 1, "int"),      # 0=A…4=E
        Field("around", 35, 1, "int"),           # 0=right, 1=left
        Field("reserve", 36, 1, "str"),          # 予備
        Field("f10_total", 37, 4, "tenths_sec"),  # ÷10s; 0000 = not run (partial)
        Field("f10_lap", 41, 3, "tenths_sec"),
        Field("f9_total", 44, 4, "tenths_sec"),
        Field("f9_lap", 48, 3, "tenths_sec"),
        Field("f8_total", 51, 4, "tenths_sec"),
        Field("f8_lap", 55, 3, "tenths_sec"),
        Field("f7_total", 58, 4, "tenths_sec"),
        Field("f7_lap", 62, 3, "tenths_sec"),
        Field("f6_total", 65, 4, "tenths_sec"),
        Field("f6_lap", 69, 3, "tenths_sec"),
        Field("f5_total", 72, 4, "tenths_sec"),
        Field("f5_lap", 76, 3, "tenths_sec"),
        Field("f4_total", 79, 4, "tenths_sec"),
        Field("f4_lap", 83, 3, "tenths_sec"),
        Field("f3_total", 86, 4, "tenths_sec"),
        Field("f3_lap", 90, 3, "tenths_sec"),
        Field("f2_total", 93, 4, "tenths_sec"),
        Field("f2_lap", 97, 3, "tenths_sec"),
        Field("last_1f", 100, 3, "tenths_sec"),  # 200→0m -- the money field
    ],
    # KS = 騎手マスタ (jockey master), 4171 data bytes (spec lists 4173 incl. CRLF).
    # Horse-keyed (NOT race-keyed) so does NOT use _RACE_ID_HEADER. Offsets
    # [SPEC] from JV-Data4901 §14; row counts verified against the 2026-06-26
    # master pull (1,914 rows). The records arrive at the bronze as cp1252-
    # decoded strings (the master-pull script ran on a non-Japanese ACP host);
    # see ``recover_raw_bytes`` + ``parse_master`` for the round-trip path.
    "KS": [
        Field("record_spec", 0, 2, "str"),        # 1 "KS"
        Field("data_kubun", 2, 1, "int"),         # 2 1=new, 2=update, 0=delete
        Field("make_date", 3, 8, "date8"),        # 3 データ作成年月日
        Field("jockey_id", 11, 5, "str"),         # 4 騎手コード (KEY)
        Field("retire_flag", 16, 1, "int"),       # 5 騎手抹消区分 0=active 1=retired
        Field("license_issue_date", 17, 8, "date8"),  # 6
        Field("license_cancel_date", 25, 8, "date8"), # 7
        Field("birthdate", 33, 8, "date8"),       # 8 生年月日
        Field("name", 41, 34, "str"),             # 9 騎手名 全角17文字 (姓+全角空白+名)
        # 10 予備 34 bytes (pos 76) -- skipped
        Field("name_kana", 109, 30, "str"),       # 11 騎手名半角ｶﾅ 半角30文字
        Field("name_abbrev", 139, 8, "str"),      # 12 騎手名略称 全角4文字
        Field("name_romanji", 147, 80, "str"),    # 13 騎手名欧字 半角80文字
        Field("sex_code", 227, 1, "int"),         # 14 性別区分 1=male 2=female
    ],
    # CH = 調教師マスタ (trainer master), 3860 data bytes (spec lists 3862 incl. CRLF).
    # Same shape / decoding path as KS. Note CH has NO 予備 field between name and
    # name_kana, so name_kana starts at pos 76 (vs KS at pos 110).
    "CH": [
        Field("record_spec", 0, 2, "str"),        # 1 "CH"
        Field("data_kubun", 2, 1, "int"),         # 2
        Field("make_date", 3, 8, "date8"),        # 3
        Field("trainer_id", 11, 5, "str"),        # 4 調教師コード (KEY)
        Field("retire_flag", 16, 1, "int"),       # 5
        Field("license_issue_date", 17, 8, "date8"),
        Field("license_cancel_date", 25, 8, "date8"),
        Field("birthdate", 33, 8, "date8"),
        Field("name", 41, 34, "str"),             # 9 調教師名
        Field("name_kana", 75, 30, "str"),        # 10 調教師名半角ｶﾅ
        Field("name_abbrev", 105, 8, "str"),      # 11 調教師名略称
        Field("name_romanji", 113, 80, "str"),    # 12 調教師名欧字
        Field("sex_code", 193, 1, "int"),         # 13 性別区分
    ],
    # JG = 競走馬除外情報 (pre-race declarations + exclusions), 78 data bytes
    # (spec lists 80 incl. CRLF). Race-keyed via _RACE_ID_HEADER. Arrives at the
    # bronze as clean cp932 (NOT cp1252 like KS/CH), so parsed via parse_fixed.
    # Offsets [confirmed] vs real bronze (149,636 rows in the 2026-06-26 pull):
    # name field "ヤプシ" decodes correctly under cp932, proving a clean round-trip.
    "JG": _RACE_ID_HEADER + [
        Field("ketto_num",         27, 10, "str"),  # 血統登録番号 (= horse_id; KEY)
        Field("bamei",             37, 36, "str"),  # 馬名 全角18字 (clean cp932)
        Field("vote_accept_order", 73, 3,  "int"),  # 001/002/003 — 再投票 ordering
        Field("shutan_kubun",      76, 1,  "str"),  # 1=投票馬 2=締切除外 4=再投票
        #                                      5=再投票除外 6=馬番なし取消 9=取消
        Field("jogai_jotai_kubun", 77, 1,  "str"),  # 0=none 1=非抽選 2=非当選
    ],
}

# Canonical record byte-lengths of the DATA portion (CRLF terminator excluded;
# parse_fixed strips it before measuring). NOTE: the JV-Data spec PDF lists these
# +2 -- it counts the trailing CRLF (RA 1272, SE 555). Field offsets are
# data-relative, so we validate against the CRLF-stripped length. Confirmed from
# this snapshot; cross-check any additions against the spec PDF.
RECORD_LENGTHS: dict[str, int] = {
    "RA": 1270,  # spec lists 1272 incl. CRLF
    "SE": 553,   # spec lists 555 incl. CRLF
    "HC": 58,    # spec lists 60 incl. CRLF (坂路調教)
    "WC": 103,   # spec lists 105 incl. CRLF (ウッドチップ調教)
    "KS": 4171,  # spec lists 4173 incl. CRLF (騎手マスタ)
    "CH": 3860,  # spec lists 3862 incl. CRLF (調教師マスタ)
    "JG": 78,    # spec lists 80 incl. CRLF (競走馬除外情報)
}

# Known JV-Data traps -> enforce as Pandera checks downstream (silver -> gold).
# CONFIRMED in JV-Data仕様書 item 58/59: "基本的には後3ハロンのみ設定(後4ハロンは初期値)"
# -- the last-4-furlong split is a phantom default "000"; only last-3F is set.
# (Some pre-2004 rows invert this; Pandera should allow either-or, not both-zero.)
DATA_TRAPS = {
    "SE.last_4f": "phantom default '000' (spec: only last-3F set); use SE.last_3f",
    "RA.last_4f": "phantom default '000'; use RA.last_3f",
    "SE.body_weight": "999=unweighable, 000=scratched; not a real weight",
    "SE.finish_time": "'9999'=DNF/excluded, '0000'=unset -> None",
    "DM_vs_TM": "record IDs are inverted vs intuition: DM=time-type (predicts 走破"
                "タイム), TM=match-type (predicts 0-100 score). Verified against data.",
    "available_at_bulk_download": "the bulk historical JV-Link pull stamped bronze "
        "available_at with the DOWNLOAD time (~2026), not the event time -- so every "
        "historical row looked unavailable for its own era and PIT feature builds "
        "yielded ZERO rows. Silver (jravan_silver._event_at) overrides available_at to "
        "post_time||race_date; ingested_at keeps the download time.",
    "SE.ketto_num=0000000000": "foreign horses w/o JRA pedigree no. get placeholder "
        "'0000000000' -> NOT unique within a race (69 races affected). Join silver on "
        "(race_id, horse_number/umaban), never on horse_id alone. "
        "jravan_race_results now carries horse_number (umaban) so the (race_id, "
        "horse_number) join is exact; downstream validators (going/training) "
        "use '(rr.horse_number IS NULL OR rr.horse_number = X)' so older "
        "partitions lacking the column still read back via union_by_name.",
    "settlement.per_bet_connection": "calling settlement.settle() per bet opens a "
        "fresh DuckDB connection + Parquet scan (~12 ms/bet). For backtests or "
        "full payout audits use settlement.settle_many(lake, bets) -- one "
        "connection, one payouts scan, resolves the whole list in memory "
        "(~0.08 ms/bet, a 150x speedup on this lake).",
    "curve_features.stable_context": "race/entry METADATA (surface, distance, field) "
        "is declared days before race day, so it is STABLE CONTEXT for any pre-post "
        "decision. jravan_silver._event_at conservatively stamps available_at=post_time "
        "for these rows; filtering them by a pre-post as_of_time wrongly excludes all "
        "races. Only the odds snapshot timestamp is the PIT-relevant signal for "
        "curve_features -- its max_source_available_at is the latest_odds_available_at, "
        "not GREATEST(race, entry, odds).",
    "going_handling.raw_time": "wet going slows the whole field; going features must use "
        "field-relative performance, not raw finish_time_seconds, for wet-vs-firm deltas.",
    "odds_curve.early_price": "pari-mutuel bets settle at the final official payout, not "
        "the odds visible at decision time; pre-post odds are features/diagnostics only.",
    "settlement.official_payout": "dead-heats, refunds, and special payout cases must be "
        "settled from HR/jravan_payouts; do not reconstruct payout yen from decimal odds.",
    "market_baseline.beta": "favorite-longshot beta calibration must be fit walk-forward "
        "from prior settled races only; global beta fitted with future winners leaks.",
    "training.available_at": "HC/WC make_date is the BULK-DELIVERY date (2026 even for a "
        "2003 work) -- same PIT trap as available_at_bulk_download. Silver must override "
        "available_at to train_date+train_time (JST→UTC), never make_date.",
    "training.horse_id=0000000000": "pre-IC-tag-era slope records carry placeholder "
        "'0000000000' -> drop in silver (no horse to join features to).",
    "training.times_null": "0000/000 = not measured, 9999/999 = over cap -> NULL (not 0.0). "
        "Woodchip horses run partial distances so most upper-distance fields are legitimately "
        "0000 -- that's expected, not a parse error.",
    "RACE_spec.cp1252_roundtrip": "the ACP!=932 mojibake that masters.cp1252_roundtrip "
        "documents for KS/CH/UM/BN/BR ALSO strikes RACE-spec records (JG declarations, SE "
        "entries, RA races) -- any record carrying Japanese text. parse_fixed() does NOT "
        "route through recover_raw_bytes() the way parse_master() does, so a JG/SE/RA "
        "record from an English-ACP capture raises UnicodeEncodeError on silver build. "
        "Incident log: 20260630T214859 + 20260626T115545_masters on a PC that drifted to "
        "ACP=1252; both quarantined under data/_quarantine/. Prevention = the assert_japanese_acp() "
        "guard in ingest_jvlink.py / realtime_jvlink.py open_jvlink(), plus the write_snapshot "
        "mojibake canary. Recovery when masters.cp1252_roundtrip's lossless invariant holds "
        "(C1 orphans survived -- 100% of the time in the observed incidents) is to extend "
        "recover_raw_bytes() to RACE-spec parsing, but the preferred path is re-capture from "
        "a Japanese-ACP PC since JG/SE/RA/HR/O1-O6 are all re-pullable historical data.",
    "scrape.natural_key_includes_source": "scrape_upsert's natural key for jravan_race_entries"
        "/results/payouts is (business_id..., source_name) so a JV-Link row and a scrape row "
        "for the SAME (race, horse)/(race, pool, combo) coexist rather than overwrite. The "
        "cross-validation gate (tools/validate_scrape_vs_jravan) reads both sources side-by-"
        "side over the overlap window; overwriting would erase exactly the overlap the gate "
        "exists to audit. settle_many's MAX(payout_yen) GROUP BY (race, pool, combo) "
        "ignores source, so duplicate rows on the read side still resolve to one payout.",
    "scrape.tansho_is_payout_not_odds": "netkeiba's result page shows the WIN PAYOUT (yen "
        "per 100-yen bet) for the winner, NOT decimal odds. JV-Data's SE.win_odds IS decimal "
        "odds. netkeiba_results._result_record converts tansho_yen/100 to keep the column "
        "semantically consistent across sources; the exact payout yen lives in jravan_payouts.",
    "scrape.netkeiba_placeholder_horse_id": "netkeiba serves the SAME '0000000000' "
        "placeholder for foreign IC-tagged horses as JV-Data (the trap above). The scrape "
        "adapter preserves horse_number on every row, so the (race_id, horse_number) join "
        "stays exact. The crosswalk from netkeiba's runner shape to silver NEVER drops "
        "umaban -- an umaban-less runner is skipped rather than emitted as an orphan.",
    "scrape.dead_heat_list_shape": "netkeiba payouts payloads encode dead-heat pools "
        "(fukusho/wide) as a LIST of leaves while single-combo pools (tansho/wakuren/etc.) "
        "are a single dict. netkeiba_payouts._iter_payout_leaves coerces both to a flat "
        "leaf list. The parser MUST NOT dedupe -- one row per (pool, combo, payout) on the "
        "page; settle_many's MAX-collapse resolves duplicates on read.",
    "scrape.partition_aware_upsert": "lake.write_dataset is partition-scoped overwrite "
        "(existing_data_behavior='delete_matching'). Calling it with rows for ONE race "
        "would DELETE the entire (year, venue) partition and write only those rows -- "
        "nuking every other race in that year+venue. ingestion.scrape_upsert does per-"
        "touched-partition read-merge-write to avoid this. Regression test: "
        "tests/test_scrape_adapters.py::test_scrape_upsert_partition_aware_no_clobber.",
    "scrape.parser_fixture_only": "the JSON shape the netkeiba_*_payload parsers accept is "
        "FIXTURE-DEFINED (tests/fixtures/netkeiba/*.json) and explicitly marked for "
        "recalibration. Real netkeiba likely serves HTML; the wire-payload extractor must "
        "be re-verified against live netkeiba BEFORE the capture PC is switched off "
        "(ADR-0004). The silver record-builder layer is pure and load-bearing; only the "
        "parser layer needs recalibration.",
    "result_block.dead_heat_via_placings": "ADR-0007 R1 producer emits per-race `result` "
        "blocks for the ticket-settlement resolver (workers/social/src/settle.ts). "
        "Dead heats (同着) MUST be expressed via the `placings:[{pos, umabans}]` form -- "
        "`finishers: number[]` (legacy) cannot carry a tie. live/result.build_result "
        "groups the results parser's flat finish_position ints into the placings shape "
        "and is the single conversion point; downstream consumers must NOT flatten it.",
    "result_block.scratch_vs_dnf": "netkeiba's 着順 cell text encodes three refund-relevant "
        "cases that parse_results_payload collapses to finish_position=None. "
        "取消/除外 (scratched at gate) → refunded by JRA (返還); the producer surfaces "
        "these in `result.scratched` so the resolver emits state:'refunded'. "
        "中止 (DNF mid-race) → NO refund; the horse just isn't in placings. "
        "失格/降着 (DQ/demotion post-race) → JRA settles tickets on the POST-ADJUDICATION "
        "order; netkeiba's 着順 cell carries the corrected int position (e.g. the demoted "
        "horse's new placing, or the DQ'd horse's last-place position), which the parser "
        "reads through unchanged. The R1 docstring's 'gate order' claim was wrong and is "
        "corrected in R2 Task 3. parse_results_payload carries finish_position_raw so the "
        "producer can tell the three apart; the silver jravan_race_results schema keeps "
        "finish_position (None for 取消/中止/除外, the int for 失格/降着) as the placing column.",
    "result_block.pool_vocabulary": "the resolver (workers/social/src/settle.ts) supports "
        "exactly five BetTypes: quinella, wide, exacta, trio, trifecta. Silver's payouts "
        "vocabulary has eight (adds win, place, bracket_quinella). live/result.build_result "
        "filters to the five and passes the names through verbatim -- the two vocabularies "
        "were designed to agree. If a future BetType is added, settle.ts and result.py "
        "must move together.",
    "result_block.official_via_payouts": "ADR-0007 R2 Task 1 gate. build_result returns {} "
        "when no resolver-relevant payouts are present, EVEN IF placings parsed cleanly -- "
        "the producer-side fix for the 審議 (inquiry) hole R1 v1 had. netkeiba's static "
        "result.html carries NO 確定 vs 審議 status marker (verified against the 4886-line "
        "result_202609030411.html fixture: grepping for 審議|確定|保留 yields only the "
        "post-time string '15:40発走'; the 確定時刻 is stamped by client-side JS at runtime "
        "and a server-rendered scrape cannot see it). JRA withholds exotic payouts until "
        "the order is official, so a non-empty payouts_out (after the five-pool filter) is "
        "the strongest available proxy for 確定. Idempotent: when 審議 → 確定 across "
        "cycles, the later confirmed block overwrites the earlier absence cleanly under "
        "key='current'. Limitations: (a) a confirmed race whose entire exotic card was "
        "cancelled (mass-scratch fiasco) emits no payouts_out and is treated as "
        "provisional -- safe, the resolver has nothing to settle; (b) a parse failure on "
        "the Payout_Detail_Table blocks looks identical to a 審議 page -- same outcome; "
        "(c) if a future page-format change MOVES the status marker into static HTML, "
        "reinstating the preferred explicit signal should be re-evaluated.",
    "result_block.no_pit_leakage_pre_race": "the result block is scraped FROM the official "
        "result page, never anything pre-race. _maybe_result in expose_live.py refuses to "
        "fetch result.html while post_time is in the future (guards against a stale page "
        "from a prior running of the same race_no). The block only attaches when placings "
        "AND resolver-relevant payouts are present (R2 Task 1 confirmation gate) -- "
        "anything less leaves the race at status='open' and the UI keeps showing the "
        "commit-time estimate.",
    "result_block.race_window_extended": "ADR-0007 R2 Task 2. expose_live.in_window's "
        "'race' window runs Sat/Sun 09:00-18:59 JST (was 09:00-16:59). The 2-hour extension "
        "catches late 確定: a race that finishes near 16:00 + a 30+min 審議 can confirm "
        "after the old 17:00 cutoff; without the extension those races never attached a "
        "result block, so the social Worker's cron sweep (workers/social/src/sweep.ts, "
        "5min UTC cron) had nothing to settle. The launchd agent "
        "(com.keibamon.expose-race, 120s fire) picks up the new boundary via the in_window "
        "gate -- no plist edit required. The 17:00-18:59 cycles are full (entries+odds+"
        "result), not result-only (R2 prompt's Option A vs B trade-off; the wasted entries/"
        "odds fetches are cheap and keep the snapshot coherent).",
    "result_block.dq_post_adjudication_verification_gap": "ADR-0007 R2 Task 3. R1 v1's "
        "docstring claimed 失格/降着 'keeps gate-order placing (JRA pays at gate)' -- "
        "WRONG. JRA settles tickets on the POST-ADJUDICATION order: 失格 places the "
        "horse last; 降着 moves it to a specific lower position. netkeiba's 着順 cell "
        "carries the corrected int position, which parse_results_payload reads through "
        "unchanged. The producer-side contract is tested by "
        "test_build_result_demotion_fixture_produces_corrected_placings against a "
        "SYNTHETIC fixture (tests/fixtures/r1/demotion_shingi_result.json) constructed "
        "from JRA rule semantics. The PARSER side (parse_results_payload reading a real "
        "result.html Rank cell for a demoted horse) is NOT verified against a real "
        "capture -- a real page may format the cell as a bare int, '2(降)' with a "
        "marker suffix, or use a separate annotation column. Re-verify against a real "
        "降着/失格 result.html before the capture-PC handoff (ADR-0004). The R2 docstring "
        "in live/result.py reflects the corrected semantics either way.",
    "KS.jockey_id=00000": "騎手コード '00000' is the non-unique placeholder (sibling of "
        "SE.ketto_num='0000000000') -- it appears on rows where the jockey code is "
        "unknown/unassigned (early records, foreign-rider gap). It is NOT a real jockey. "
        "Silver master MUST label it '(unknown/placeholder)' for name + name_kana; never "
        "an invented name. Verified: KS bronze carries 0 rows for jockey_id='00000' in "
        "the 2026-06-26 pull, but the rule is enforced defensively in "
        "jravan_silver.build_jockey_master so a future pull that surfaces the placeholder "
        "cannot accidentally mint a phantom jockey.",
    "CH.trainer_id=00000": "same shape as KS.jockey_id='00000' -- '00000' on a CH row "
        "is the placeholder, not a trainer. Silver labels it '(unknown/placeholder)'.",
    "masters.cp1252_roundtrip": "KS/CH/UM/BN/BR master records arrive at the bronze "
        "decoded as cp1252 (Windows English ACP), NOT cp932 (Japanese ACP) -- the master-"
        "pull script on the capture-PC did not enforce ACP=932 (ingest_jvlink/"
        "realtime_jvlink DO enforce it; the master pull did not). parse_master() undoes "
        "the wrong decode via recover_raw_bytes() before slicing on byte offsets. "
        "Symptom: raw contains U+0081/U+008F (raw bytes 0x81/0x8F passed through) AND "
        "U+0152 Œ / U+2014 — (cp1252-specific mappings of 0x8C/0x97) in the same record. "
        "Durable fix: re-run the master pull on a Japanese-ACP host so raw_text is the "
        "real Unicode jockey/trainer name (decode-then-store); then parse_master can "
        "collapse to a strict cp932 round-trip. The recovery path is the safety net for "
        "already-ingested bronze.",
    "H1.make_date_drift": "H1 make_date is the bulk-delivery date, NOT the event time. "
        "19,815 of 30,597 rows in the 2026-06-26 pull have make_date=2002 for 1986-2002 "
        "races (bulk re-pull). Silver builder MUST set available_at via _event_at "
        "(post_time || race_date). Same shape as available_at_bulk_download.",
    "H1.data_kubun_no_intraday": "H1's data_kubun enum is 2/4/5/9/0 -- NO 1 (中間). "
        "Unlike O1-O6 odds which are intraday snapshots, H1 is final-state-only. Each "
        "(race, pool, combo) has at most a handful of records, one per final snapshot "
        "type. Verified in bronze: this pull has only data_kubun=5 (月曜確定, 30594 rows) "
        "and =9 (race cancelled, 3 rows).",
    "JG.ketto_num=0000000000": "Sibling of SE.ketto_num='0000000000'. JG scratches on a "
        "foreign horse without JRA pedigree carry the placeholder -- join via (race_id, "
        "horse_id) but expect NULL horse_number for the placeholder case. None present in "
        "the 2026-06-26 pull; rule enforced defensively (silver preserves the row).",
    "JG.is_not_pure_exclusions": "JG is the cumulative pre-race declarations master, NOT "
        "just exclusions -- 91% of rows are shutan_kubun=1 (投票馬, ran). The exclusion "
        "subset is shutan_kubun IN (2,5,6,9) OR jogai_jotai_kubun IN (1,2). Silver emits "
        "all rows to jravan_declarations with derived is_excluded + exclusion_kind; "
        "downstream filters via WHERE is_excluded=true.",
}


# --------------------------------------------------------------------------- #
# Parse engine
# --------------------------------------------------------------------------- #
def parse_fixed(raw: str, layout: list[Field], *, expected_len: int | None = None) -> dict:
    """Slice ``raw`` by BYTE offsets per ``layout`` and return typed fields.

    Re-encodes to cp932 so spec byte offsets line up regardless of full-width
    characters. Raises ValueError if the record's byte length does not match
    ``expected_len`` (a tripped round-trip / truncated record), so misaligned
    data fails loudly instead of silently shifting every field.
    """
    data = raw.rstrip("\r\n").encode(ENCODING)
    if expected_len is not None and len(data) != expected_len:
        raise ValueError(
            f"record byte-length {len(data)} != expected {expected_len} "
            f"(spec='{raw[:2]}'); offsets would misalign"
        )
    out: dict = {}
    for f in layout:
        chunk = data[f.start : f.start + f.length]
        text = chunk.decode(ENCODING, errors="replace")
        out[f.name] = CONVERTERS.get(f.kind, CONVERTERS["str"])(text)
    return out


# --------------------------------------------------------------------------- #
# Master-record parsing (KS/CH/UM/BN/BR)
# --------------------------------------------------------------------------- #
# Master records arrive at the bronze decoded as cp1252 (English Windows ACP),
# NOT cp932 (Japanese ACP) -- see DATA_TRAPS["masters.cp1252_roundtrip"] for the
# full why. ``recover_raw_bytes`` undoes the wrong decode so the spec byte
# offsets line up. Map is the standard cp1252 reverse: the 27 code points that
# cp1252 maps to non-latin-1 Unicode chars (per Microsoft's published table).
_CP1252_HIGH_REVERSE: dict[int, int] = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F,
}


def recover_raw_bytes(raw_text: str) -> bytes:
    """Recover the original cp932 bytes from a master record that the bronze
    path decoded as cp1252 + latin-1-fallback (English Windows ACP) instead of
    cp932 (Japanese ACP).

    For each char in ``raw_text``:
      - U+0000..U+00FF (ASCII + latin-1) -- pass through as a single byte.
      - cp1252 high chars (U+0152 Œ, U+2014 —, U+201C ", etc.) -- map back to
        the original cp1252 byte (0x8C, 0x97, 0x93, ...).
      - Any other code point -- raises ValueError; a valid master record on a
        Japanese-ACP capture would decode cleanly to begin with, so an
        unmapped char here means the upstream decode path changed.

    Idempotent and symmetric with the bronze storage path for these specs
    (raw bytes -> cp1252 decode -> Python str -> recover_raw_bytes -> raw bytes).
    """
    out = bytearray()
    for c in raw_text:
        cp = ord(c)
        if cp < 0x100:
            out.append(cp)
        elif cp in _CP1252_HIGH_REVERSE:
            out.append(_CP1252_HIGH_REVERSE[cp])
        else:
            raise ValueError(
                f"unmapped codepoint U+{cp:04X} in master raw -- "
                "either the bronze decode path changed or this isn't a master record"
            )
    return bytes(out)


def parse_master(raw: str, layout: list[Field], *, expected_len: int | None = None) -> dict:
    """Slice a master record (KS/CH/UM/BN/BR) by BYTE offsets.

    Counterpart to :func:`parse_fixed` for records that arrived at the bronze
    decoded as cp1252 (see :func:`recover_raw_bytes`). Length-check semantics
    mirror :func:`parse_fixed`: a mismatch is a tripped round-trip / truncated
    record and fails loudly.
    """
    data = recover_raw_bytes(raw.rstrip("\r\n"))
    if expected_len is not None and len(data) != expected_len:
        raise ValueError(
            f"record byte-length {len(data)} != expected {expected_len} "
            f"(spec='{raw[:2]}'); offsets would misalign"
        )
    out: dict = {}
    for f in layout:
        chunk = data[f.start : f.start + f.length]
        text = chunk.decode(ENCODING, errors="replace")
        out[f.name] = CONVERTERS.get(f.kind, CONVERTERS["str"])(text)
    return out


class JravanSourceAdapter:
    source_name = "jravan"

    def __init__(self, raw_dir: Path):
        self.raw_dir = raw_dir  # <lake>/raw/jravan

    def iter_raw(self, spec: str | None = None) -> Iterator[dict]:
        """Yield raw bronze rows across all snapshots (replayable input).

        ``spec`` (e.g. "RACE") filters by the per-file spec prefix so callers
        can stream just the files they need instead of every snapshot.
        """
        for snap in sorted(p for p in self.raw_dir.glob("*") if p.is_dir()):
            patterns = (f"{spec}.ndjson.gz", f"{spec}.*.ndjson.gz") if spec else ("*.ndjson.gz",)
            seen: set[Path] = set()
            files = []
            for pattern in patterns:
                for gz in sorted(snap.glob(pattern)):
                    if gz not in seen:
                        seen.add(gz)
                        files.append(gz)
            for gz in files:
                with gzip.open(gz, "rt", encoding="utf-8") as fh:
                    for line in fh:
                        if line.strip():
                            yield json.loads(line)

    @staticmethod
    def parse_record(row: dict) -> dict | None:
        """Parse one raw bronze row into typed fields using RECORD_LAYOUTS.

        Returns None for record types we don't yet map. Carries the bronze
        provenance fields through so silver can build SourceMetadata.
        """
        rec = row.get("record_id", "")
        layout = RECORD_LAYOUTS.get(rec)
        if not layout:
            return None
        parsed = parse_fixed(row["raw"], layout, expected_len=RECORD_LENGTHS.get(rec))
        parsed["_meta"] = _meta_of(row)
        return parsed

    @staticmethod
    def parse_grouped_record(row: dict) -> dict | None:
        """Parse any 'header + repeating array' record (O1-O6 odds, HR payouts,
        DM/TM mining) into ``{header fields, 'entries': [...], '_meta': {...}}``.

        Each entry is one array slot: a combo (馬番/組番) plus that block's typed
        value fields and optional popularity. Slots with no combo or only
        sentinel values are skipped (unsold, cancelled, beyond field size).
        Returns None for record types without a registered group layout."""
        rec = row.get("record_id", "")
        layout = GROUP_LAYOUTS.get(rec)
        if layout is None:
            return None
        header_fields, blocks, exp_len = layout
        data = row["raw"].rstrip("\r\n").encode(ENCODING)
        if exp_len is not None and len(data) != exp_len:
            raise ValueError(f"grouped record {rec} byte-length {len(data)} != {exp_len}")

        out = _parse_header(data, header_fields)
        entries: list[dict] = []
        for blk in blocks:
            for i in range(blk.count):
                base = blk.start + i * blk.stride
                combo = data[base:base + blk.combo_len].decode(ENCODING, "replace").strip()
                if not combo or not combo.isdigit() or int(combo) == 0:
                    continue
                e: dict = {blk.label_key: blk.label, "combo": combo}
                for name, rel, length, kind in blk.values:
                    e[name] = VALUE_CONVERTERS[kind](
                        data[base + rel:base + rel + length].decode(ENCODING, "replace"))
                if blk.pop_rel is not None:
                    e["popularity"] = _to_int(
                        data[base + blk.pop_rel:base + blk.pop_rel + blk.pop_len]
                        .decode(ENCODING, "replace"))
                if any(e.get(n) is not None for n, _, _, _ in blk.values):
                    entries.append(e)
        out["entries"] = entries
        out["_meta"] = _meta_of(row)
        return out

    # Backwards-compatible alias: odds records are just grouped records.
    parse_odds_record = parse_grouped_record


def _meta_of(row: dict) -> dict:
    return {
        "source_name": row.get("source_name", "jravan"),
        "source_record_id": row.get("source_record_id"),
        "raw_uri": row.get("raw_uri"),
        "content_hash": row.get("content_hash"),
        "ingested_at": row.get("ingested_at"),
        "published_time": row.get("published_time"),
        "available_at": row.get("available_at"),
    }


# --------------------------------------------------------------------------- #
# Grouped records (O1-O6 odds, HR payouts, DM/TM mining) -- a fixed header
# followed by repeating arrays. All offsets are BYTE positions from
# JV-Data仕様書 (位置 minus 1).
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RepeatBlock:
    label: str                                       # win/place/trifecta/payout/mining...
    start: int                                       # 0-indexed byte of first entry
    count: int                                       # 繰返 (max array slots)
    stride: int                                      # bytes per entry
    combo_len: int                                   # 馬番/組番 width
    values: tuple[tuple[str, int, int, str], ...]    # (name, rel_start, len, value_kind)
    pop_rel: int | None = None                       # popularity rel start (None = no pop)
    pop_len: int = 0
    label_key: str = "bet_type"                      # entry key holding ``label``


def _odds_value(s: str) -> float | None:
    """Odds (x10) -> decimal. None for '0000' 無投票, '----'/'****' cancelled, spaces."""
    s = s.strip()
    return int(s) / 10 if s.isdigit() and int(s) != 0 else None


def _yen(s: str) -> int | None:
    """Payout 払戻金 in yen. None for 0/blank (no win / 特払 / 不成立)."""
    s = s.strip()
    return int(s) if s.isdigit() and int(s) > 0 else None


def _votes_x100(s: str) -> int | None:
    """H1 票数 field (11-digit, 単位百円) -> yen amount (×100).

    None for the '00000000000' sentinel (発売前取消し / cancelled before sale) and for
    whitespace (発売なし / pool not registered). Mirrors :func:`_yen` in spirit -- a
    zero count carries no liquidity signal, so it nulls out rather than reporting 0.
    """
    s = s.strip()
    if not s or not s.isdigit() or int(s) == 0:
        return None
    return int(s) * 100


def _pred_time(s: str) -> float | None:
    """Mining predicted time '9分99秒99' (M SS cc) -> seconds. '14606' -> 106.06."""
    s = s.strip()
    if not s.isdigit() or int(s) == 0:
        return None
    cc, sec = int(s[-2:]), int(s[-4:-2])
    mins = int(s[:-4]) if len(s) > 4 else 0
    return mins * 60 + sec + cc / 100


def _pred_err(s: str) -> float | None:
    """Mining time error '99秒99' (SS cc) -> seconds. '0017' -> 0.17."""
    s = s.strip()
    return int(s) / 100 if s.isdigit() else None


def _score10(s: str) -> float | None:
    """Mining score '000.0-100.0' (x10) -> float. '0716' -> 71.6; 0/blank -> None."""
    s = s.strip()
    return int(s) / 10 if s.isdigit() and int(s) != 0 else None


VALUE_CONVERTERS: dict[str, Callable[[str], object]] = {
    "odds": _odds_value,
    "yen": _yen,
    "votes_x100": _votes_x100,
    "pred_time": _pred_time,
    "pred_err": _pred_err,
    "score10": _score10,
}


def _parse_header(data: bytes, fields: list[Field]) -> dict:
    return {f.name: CONVERTERS.get(f.kind, CONVERTERS["str"])(
        data[f.start:f.start + f.length].decode(ENCODING, "replace")) for f in fields}


# --- headers --------------------------------------------------------------- #
# O-records: announce_mdhm (発表月日時分) only set for 中間 odds -- time-series key.
_ODDS_HEADER: list[Field] = _RACE_ID_HEADER + [
    Field("announce_mdhm", 27, 8, "str"),  # 発表月日時分 (pos 28)
    Field("entry_count", 35, 2, "int"),    # 登録頭数 (pos 36)
    Field("starter_count", 37, 2, "int"),  # 出走頭数 (pos 38)
]
_HR_HEADER: list[Field] = _RACE_ID_HEADER + [
    Field("entry_count", 27, 2, "int"),    # 登録頭数 (pos 28)
    Field("starter_count", 29, 2, "int"),  # 出走頭数 (pos 30)
]
_MINING_HEADER: list[Field] = _RACE_ID_HEADER + [
    Field("create_hhmm", 27, 4, "str"),    # データ作成時分 (pos 28)
]

# --- block layouts (label, start, count, stride, combo_len, values, pop_rel, pop_len) --
_ODDS_BLOCKS: dict[str, list[RepeatBlock]] = {
    "O1": [
        RepeatBlock("win", 43, 28, 8, 2, (("odds", 2, 4, "odds"),), 6, 2),
        RepeatBlock("place", 267, 28, 12, 2,
                    (("odds_low", 2, 4, "odds"), ("odds_high", 6, 4, "odds")), 10, 2),
        RepeatBlock("bracket_quinella", 603, 36, 9, 2, (("odds", 2, 5, "odds"),), 7, 2),
    ],
    "O2": [RepeatBlock("quinella", 40, 153, 13, 4, (("odds", 4, 6, "odds"),), 10, 3)],
    "O3": [RepeatBlock("wide", 40, 153, 17, 4,
                       (("odds_low", 4, 5, "odds"), ("odds_high", 9, 5, "odds")), 14, 3)],
    "O4": [RepeatBlock("exacta", 40, 306, 13, 4, (("odds", 4, 6, "odds"),), 10, 3)],
    "O5": [RepeatBlock("trio", 40, 816, 15, 6, (("odds", 6, 6, "odds"),), 12, 3)],
    "O6": [RepeatBlock("trifecta", 40, 4896, 17, 6, (("odds", 6, 7, "odds"),), 13, 4)],
}

# HR payouts: each pool = combo + 払戻金(yen) + 人気順. label_key="pool".
_HR_BLOCKS: list[RepeatBlock] = [
    RepeatBlock("win", 102, 3, 13, 2, (("payout", 2, 9, "yen"),), 11, 2, "pool"),
    RepeatBlock("place", 141, 5, 13, 2, (("payout", 2, 9, "yen"),), 11, 2, "pool"),
    RepeatBlock("bracket_quinella", 206, 3, 13, 2, (("payout", 2, 9, "yen"),), 11, 2, "pool"),
    RepeatBlock("quinella", 245, 3, 16, 4, (("payout", 4, 9, "yen"),), 13, 3, "pool"),
    RepeatBlock("wide", 293, 7, 16, 4, (("payout", 4, 9, "yen"),), 13, 3, "pool"),
    RepeatBlock("exacta", 453, 6, 16, 4, (("payout", 4, 9, "yen"),), 13, 3, "pool"),
    RepeatBlock("trio", 549, 3, 18, 6, (("payout", 6, 9, "yen"),), 15, 3, "pool"),
    RepeatBlock("trifecta", 603, 6, 19, 6, (("payout", 6, 9, "yen"),), 15, 4, "pool"),
]

# Mining. GOTCHA: record IDs are counterintuitive (see DATA_TRAPS):
#   "DM" = タイム型 (time-type): predicts 走破タイム + error band, 18x15, 301B.
#   "TM" = 対戦型 (match-type): predicts a 0-100 score, 18x6, 139B.
_MINING_BLOCKS: dict[str, list[RepeatBlock]] = {
    "DM": [RepeatBlock("mining_time", 31, 18, 15, 2,
                       (("pred_time", 2, 5, "pred_time"),
                        ("err_plus", 7, 4, "pred_err"),
                        ("err_minus", 11, 4, "pred_err")), None, 0, "kind")],
    "TM": [RepeatBlock("mining_score", 31, 18, 6, 2,
                       (("score", 2, 4, "score10"),), None, 0, "kind")],
}

# H1 = 票数 (per-pool yen vote counts), 28953 data bytes (spec lists 28955 incl.
# CRLF). One record carries all 7 pools back-to-back; each pool = a fixed-size
# repeating array of (combo + 11-digit 票数-in-units-of-100 + 人気順). Block
# start/stride derived from JV-Data4901 §13 and [confirmed] vs real bronze by
# parsing every pool on a 16-starter 2023 race: win=16, place=16, BQ<=15,
# quinella=wide=C(N,2), exacta=N*(N-1), trio=C(N,3) entries. Pre-2003 races only
# carry win/place/bracket_quinella (JRA did not offer the exotics then) -- those
# slots are whitespace, dropped by the combo-blank skip in parse_grouped_record.
# NOTE: exacta starts at byte 6971 (NOT 6969): wide ends at 4217+153*18=6971, and
# 6971+306*18=12479=trio start -- the 2-byte drift misaligns every exacta combo.
_H1_HEADER: list[Field] = _RACE_ID_HEADER + [
    Field("entry_count",   27, 2, "int"),   # 登録頭数 (pos 28)
    Field("starter_count", 29, 2, "int"),   # 出走頭数 (pos 30)
    # sell_flag_* (7 × 1 byte) + fukusho_pay_key + refund_umaban/wakuban/same_waku
    # = header bytes 31..82 -- opaque filler, not emitted to silver.
]
_H1_BLOCKS: list[RepeatBlock] = [
    RepeatBlock("win",              83,   28,  15, 2, (("vote_yen", 2, 11, "votes_x100"),), 13, 2, "pool"),
    RepeatBlock("place",            503,  28,  15, 2, (("vote_yen", 2, 11, "votes_x100"),), 13, 2, "pool"),
    RepeatBlock("bracket_quinella", 923,  36,  15, 2, (("vote_yen", 2, 11, "votes_x100"),), 13, 2, "pool"),
    RepeatBlock("quinella",         1463, 153, 18, 4, (("vote_yen", 4, 11, "votes_x100"),), 15, 3, "pool"),
    RepeatBlock("wide",             4217, 153, 18, 4, (("vote_yen", 4, 11, "votes_x100"),), 15, 3, "pool"),
    RepeatBlock("exacta",           6971, 306, 18, 4, (("vote_yen", 4, 11, "votes_x100"),), 15, 3, "pool"),
    RepeatBlock("trio",             12479, 816, 20, 6, (("vote_yen", 6, 11, "votes_x100"),), 17, 3, "pool"),
]

# Registry: record_id -> (header fields, blocks, expected data byte-length).
GROUP_LAYOUTS: dict[str, tuple[list[Field], list[RepeatBlock], int | None]] = {
    "O1": (_ODDS_HEADER, _ODDS_BLOCKS["O1"], 960),
    "O2": (_ODDS_HEADER, _ODDS_BLOCKS["O2"], 2040),
    "O3": (_ODDS_HEADER, _ODDS_BLOCKS["O3"], 2652),
    "O4": (_ODDS_HEADER, _ODDS_BLOCKS["O4"], 4029),
    "O5": (_ODDS_HEADER, _ODDS_BLOCKS["O5"], 12291),
    "O6": (_ODDS_HEADER, _ODDS_BLOCKS["O6"], 83283),
    "HR": (_HR_HEADER, _HR_BLOCKS, 717),
    "DM": (_MINING_HEADER, _MINING_BLOCKS["DM"], 301),
    "TM": (_MINING_HEADER, _MINING_BLOCKS["TM"], 139),
    "H1": (_H1_HEADER, _H1_BLOCKS, 28953),
}
