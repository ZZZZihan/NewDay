import {
  notionTaskFieldsSchema,
  type NotionFieldConflict,
  type NotionSharedField,
  type NotionTaskFields,
} from "../contracts/notion-sync";

const sharedFields = ["title", "date", "completed"] as const;

/** Compare each side to the last successfully confirmed value, not to each other.
 * The complete date range is compared as a single field. This function only
 * decides intent; callers still have to commit business commands and outbox
 * changes together and confirm a remote write by reading it back. */
export function reconcileNotionTask(input: {
  baseline: NotionTaskFields;
  local: NotionTaskFields;
  remote: NotionTaskFields;
}): {
  merged: NotionTaskFields;
  remotePatch: Partial<NotionTaskFields>;
  conflicts: NotionFieldConflict[];
} {
  const baseline = notionTaskFieldsSchema.parse(input.baseline);
  const local = notionTaskFieldsSchema.parse(input.local);
  const remote = notionTaskFieldsSchema.parse(input.remote);
  const merged: NotionTaskFields = { ...remote };
  const remotePatch: Partial<NotionTaskFields> = {};
  const conflicts: NotionFieldConflict[] = [];

  for (const field of sharedFields) {
    const localChanged = !equalField(field, local, baseline);
    const remoteChanged = !equalField(field, remote, baseline);
    if (!localChanged) continue;

    if (!remoteChanged) {
      // The remote still has the common baseline: the local intent may be sent.
      assignField(merged, field, local);
      assignField(remotePatch, field, local);
      continue;
    }

    if (!equalField(field, local, remote)) {
      conflicts.push({
        field,
        baseline: baseline[field],
        local: local[field],
        remote: remote[field],
        winner: "notion",
      });
    }
  }

  return { merged: notionTaskFieldsSchema.parse(merged), remotePatch, conflicts };
}

function equalField(field: NotionSharedField, left: NotionTaskFields, right: NotionTaskFields) {
  if (field !== "date") return left[field] === right[field];
  const a = left.date;
  const b = right.date;
  return a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1];
}

function assignField(target: Partial<NotionTaskFields>, field: NotionSharedField, source: NotionTaskFields) {
  if (field === "title") target.title = source.title;
  else if (field === "date") target.date = source.date;
  else target.completed = source.completed;
}
