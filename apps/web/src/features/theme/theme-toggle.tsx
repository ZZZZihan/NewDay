"use client";

import { Moon, Sun } from "lucide-react";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { Button } from "@heroui/react/button";

import {
  parseStoredTheme,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  type Theme,
} from "@/features/theme/theme-preference";

function getResolvedTheme(): Theme {
  return resolveTheme(
    window.localStorage.getItem(THEME_STORAGE_KEY),
    window.matchMedia(SYSTEM_DARK_QUERY).matches,
  );
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function subscribeToTheme(onStoreChange: () => void) {
  const media = window.matchMedia(SYSTEM_DARK_QUERY);
  const handleSystemChange = () => {
    if (!parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY))) {
      applyTheme(resolveTheme(null, media.matches));
    }
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) {
      applyTheme(getResolvedTheme());
    }
  };

  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorage);
  media.addEventListener("change", handleSystemChange);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", handleStorage);
    media.removeEventListener("change", handleSystemChange);
  };
}

function getThemeSnapshot(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function getServerThemeSnapshot(): Theme {
  return "light";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );

  useLayoutEffect(() => {
    applyTheme(getResolvedTheme());
  }, []);

  const dark = theme === "dark";

  return (
    <Button
      type="button"
      className="header-icon-button"
      variant="ghost"
      size="sm"
      isIconOnly
      aria-label={dark ? "切换到浅色模式" : "切换到深色模式"}
      onPress={() => {
        const nextTheme: Theme = dark ? "light" : "dark";
        window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
        applyTheme(nextTheme);
      }}
    >
      {dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </Button>
  );
}
