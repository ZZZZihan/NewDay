import { Button } from "@heroui/react/button";
import type { useLegacyMigration } from "../migration/use-legacy-migration";

export function PlannerStatus({
  migration,
  dataError,
  seriesError,
  refreshing,
  onRetry,
  onRetrySeries,
}: {
  migration: ReturnType<typeof useLegacyMigration>;
  dataError: string | null;
  seriesError: string | null;
  refreshing: boolean;
  onRetry: () => void;
  onRetrySeries: () => void;
}) {
  return (
    <>
      {migration.message ? (
        <div className="planner-status" role={migration.status === "failed" ? "alert" : "status"} data-testid="migration-status">
          <p>{migration.message}</p>
          <div className="planner-status__actions">
            {migration.legacy ? (
              <Button type="button" variant="ghost" size="sm" onPress={migration.download}>
                下载旧浏览器备份
              </Button>
            ) : null}
            {migration.status === "failed" || migration.status === "conflict" ? (
              <Button type="button" variant="ghost" size="sm" isDisabled={migration.clearing} onPress={migration.retry}>
                重试迁移
              </Button>
            ) : null}
            {migration.legacy && migration.status !== "cleared" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                isDisabled={!migration.downloaded || migration.clearing}
                onPress={() => void migration.clear()}
              >
                {migration.clearing ? "正在清除旧浏览器数据…" : "清除旧浏览器数据"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {dataError ? (
        <div className="planner-status planner-status--error" role="alert" data-testid="api-error">
          <p>{dataError}</p>
          <Button type="button" variant="ghost" size="sm" isDisabled={refreshing} onPress={onRetry}>
            重新连接
          </Button>
        </div>
      ) : null}
      {seriesError ? (
        <div className="planner-status planner-status--error" role="alert">
          <p>{seriesError}</p>
          <Button type="button" variant="ghost" size="sm" onPress={onRetrySeries}>
            重试读取重复规则
          </Button>
        </div>
      ) : null}
    </>
  );
}
