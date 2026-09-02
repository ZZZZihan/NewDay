"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@heroui/react/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="fatal-error">
      <div className="fatal-error__card">
        <span className="fatal-error__icon" aria-hidden="true">
          <AlertTriangle size={24} />
        </span>
        <p className="eyebrow">NewDay 暂时没有加载成功</p>
        <h1>你的数据仍保存在当前浏览器</h1>
        <p>
          可能是浏览器存储暂时不可用。请先重试；如果问题持续，避免清除本站数据。
        </p>
        <Button type="button" variant="primary" onPress={reset}>
          <RotateCcw size={15} />
          重试
        </Button>
      </div>
    </main>
  );
}
