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
        <h1>页面暂时无法显示</h1>
        <p>
          已保存的任务存储在后端服务中。请先重试；如果问题持续，请检查前端与后端服务是否正常运行。
        </p>
        <Button type="button" variant="primary" onPress={reset}>
          <RotateCcw size={15} />
          重试
        </Button>
      </div>
    </main>
  );
}
