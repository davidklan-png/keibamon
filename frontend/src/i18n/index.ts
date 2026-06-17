import { useCallback, useSyncExternalStore } from "react";
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
      (navigator.language || (navigator as unknown as { userLanguage?: string }).userLanguage)) ||
    "";
  if (nav.toLowerCase().startsWith("en")) return "en";
  return "ja";
}

// ---------------------------------------------------------------------------
// Single shared store. Module-level state + listener Set, surfaced to React
// via useSyncExternalStore. This is the fix for the bug where useI18n() was
// called separately in ~7 components and held language in a per-component
// useState — toggling updated only the instance that owned the button.
//
// No Context provider, no library. The store is the single source of truth.
// ---------------------------------------------------------------------------

let currentLang: Lang = detectInitial();
const listeners = new Set<() => void>();

function persistAndApplyDom(next: Lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = next === "ja" ? "ja-JP" : "en";
  }
}

// Apply the DOM side-effect for whatever we detected at module load, so the
// very first paint has the right <html lang> without waiting for a render.
if (typeof window !== "undefined") {
  persistAndApplyDom(currentLang);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Lang {
  return currentLang;
}

/** Mutate the shared language. Notifies every subscribed component. */
export function setLang(next: Lang): void {
  if (next === currentLang) return;
  currentLang = next;
  persistAndApplyDom(next);
  for (const l of listeners) l();
}

/** Read the current language without subscribing. */
export function getLang(): Lang {
  return currentLang;
}

const DICTS = { ja, en } as const;

function lookup(lang: Lang, key: string): string | undefined {
  const parts = key.split(".");
  let cur: unknown = DICTS[lang];
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Tiny hand-rolled i18n hook. No library, no provider boilerplate.
 *
 *   const { t, lang, setLang } = useI18n();
 *   <h1>{t("app.title")}</h1>
 *   <button onClick={() => setLang(lang === "ja" ? "en" : "ja")}>
 *     {lang === "ja" ? "EN" : "JA"}
 *   </button>
 *
 * Reads the shared store via useSyncExternalStore, so EVERY component calling
 * useI18n() re-renders on a single setLang() call. Persists to localStorage.
 *
 * Lookup contract (no raw key ever renders):
 *   1. Try current language.
 *   2. Fall back to English.
 *   3. If both miss, return "" and console.warn — never the raw key.
 */
export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const t = useCallback(
    (key: string): string => {
      const inLang = lookup(lang, key);
      if (inLang !== undefined) return inLang;
      const inEn = lookup("en", key);
      if (inEn !== undefined) return inEn;
      // Hard guard: never render a raw key. Warn so missing-key bugs are
      // still visible in dev, but the user never sees "personality.9".
      if (typeof console !== "undefined") {
        console.warn(`[i18n] unresolved key: ${key}`);
      }
      return "";
    },
    [lang],
  );

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
