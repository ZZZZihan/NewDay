/** Deletes only the retired planner database, never server data or preferences. */
export function clearLegacyDatabase(onBlocked?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("newday");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("无法清除旧浏览器数据"));
    // A blocked delete cannot be cancelled. Keep waiting so the UI can record
    // success when the other tab closes, while explaining the blockage now.
    request.onblocked = () => onBlocked?.();
  });
}
