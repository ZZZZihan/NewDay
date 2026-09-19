"use client";

import { useState, useSyncExternalStore } from "react";
import { Maximize, Minimize, X } from "lucide-react";
import { Button } from "@heroui/react/button";

function subscribe(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

function getSnapshot() {
  if (document.fullscreenElement) return "fullscreen";
  return document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function"
    ? "windowed"
    : "unsupported";
}

function getServerSnapshot() {
  return "unsupported" as const;
}

export function FullscreenToggle() {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fullscreen = mode === "fullscreen";
  const label = mode === "unsupported"
    ? "当前浏览器不支持页面全屏"
    : fullscreen ? "退出全屏" : "进入全屏";

  async function toggleFullscreen() {
    setError(null);
    setPending(true);
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        // Include the entire app and overlays portaled into document.body.
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      }
    } catch {
      setError(document.fullscreenElement
        ? "未能退出全屏，请按 Esc 退出或重试。"
        : "未能进入全屏，请重试或检查浏览器是否允许全屏。");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <span title={fullscreen ? "退出全屏（Esc）" : label}>
        <Button
          type="button"
          className="header-icon-button"
          variant="ghost"
          size="sm"
          isIconOnly
          isDisabled={mode === "unsupported" || pending}
          aria-label={label}
          aria-pressed={fullscreen}
          onPress={() => void toggleFullscreen()}
        >
          {fullscreen ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}
        </Button>
      </span>
      {error ? (
        <div className="app-notice" role="alert">
          <span>{error}</span>
          <Button type="button" variant="ghost" size="sm" isIconOnly aria-label="关闭全屏提示" onPress={() => setError(null)}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </>
  );
}
