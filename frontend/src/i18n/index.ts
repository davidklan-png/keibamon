import { useEffect, useState, useCallback } from "react";
import { ja } from "./ja";
import { en } from "./en";

export type Lang = "ja" | "en";

const STORAGE_KEY = "keibamon.lang";

/**
 * Auto-detect initial language:
 *   1. localStorage('keibamon.lang')  if previously set
 *   2. navigator.language              if it starts with 'ja' or 'en'
 *   3. default 'ja'                    (Japanese-first product)
 */
function detectInitial(): Lang {
  if (typeof window === "undefined") return "ja";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "ja" || saved === "en") return saved;
  } catch {
    /* localStorage unavailable — fall through */
  }
  const nav =
    (typeof navigator !== "undefined" &&
      (navigator.language || (navigator as any).userLanguage)) ||
    "";
  if (nav.toLowerCase().startsWith("en")) return "en";
  return "ja";
}

const DICTS: Record<Lang, typeof ja> = { ja, en };

/**
 * Tiny hand-rolled i18n hook. No library, no provider boilerplate.
 *
 *   const { t, lang, setLang } = useI18n();
 *   <h1>{t("app.title")}</h1>
 *   <button onClick={() => setLang(lang === "ja" ? "en" : "ja")}>
 *     {lang === "ja" ? "EN" : "JA"}
 *   </button>
 *
 * Persists choice to localStorage('keibamon.lang') so the toggle sticks.
 */
export function useI18n() {
  const [lang, setLangState] = useState<Lang>(detectInitial);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "ja" ? "ja-JP" : "en";
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);

  const dict = DICTS[lang];

  /** Lookup a dotted key, e.g. t("race.title"). Falls back to EN then to key. */
  const t = useCallback(
    (key: string): string => {
      const parts = key.split(".");
      let cur: any = dict;
      for (const p of parts) {
        if (cur && typeof cur === "object" && p in cur) {
          cur = cur[p];
        } else {
          // Fall back to English, then to the raw key.
          let fb: any = DICTS.en;
          for (const q of parts) {
            if (fb && typeof fb === "object" && q in fb) fb = fb[q];
            else return key;
          }
          return typeof fb === "string" ? fb : key;
        }
      }
      return typeof cur === "string" ? cur : key;
    },
    [dict],
  );

  /**
   * Lookup a key with {placeholder} substitution.
   *   tFmt("race.overroundMsg", { taken: "23", sum: "1.30" })
   */
  const tFmt = useCallback(
    (key: string, vars: Record<string, string | number>): string => {
      const raw = t(key);
      return raw.replace(/\{(\w+)\}/g, (_, k: string) =>
        k in vars ? String(vars[k]) : `{${k}}`,
      );
    },
    [t],
  );

  return { t, tFmt, lang, setLang };
}

export type Translator = ReturnType<typeof useI18n>["t"];
export type Formatter = ReturnType<typeof useI18n>["tFmt"];
