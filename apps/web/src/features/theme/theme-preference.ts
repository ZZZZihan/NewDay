export const THEME_STORAGE_KEY = "newday-theme";
export const THEME_CHANGE_EVENT = "newday-theme-change";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export type Theme = "light" | "dark";

export function parseStoredTheme(value: string | null): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function resolveTheme(
  storedTheme: string | null,
  systemPrefersDark: boolean,
): Theme {
  return parseStoredTheme(storedTheme) ?? (systemPrefersDark ? "dark" : "light");
}

export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var q=${JSON.stringify(SYSTEM_DARK_QUERY)};var s=localStorage.getItem(k);var t=s==="light"||s==="dark"?s:(matchMedia(q).matches?"dark":"light");var r=document.documentElement;r.setAttribute("data-theme",t);r.style.colorScheme=t}catch(e){}})()`;
