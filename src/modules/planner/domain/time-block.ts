export type TimeRange = {
  id: string;
  start: Date;
  end: Date;
};

export function findOverlappingBlockIds(
  blocks: readonly TimeRange[],
): Set<string> {
  const conflicts = new Set<string>();

  for (let index = 0; index < blocks.length; index += 1) {
    const current = blocks[index];

    for (
      let candidateIndex = index + 1;
      candidateIndex < blocks.length;
      candidateIndex += 1
    ) {
      const candidate = blocks[candidateIndex];
      const overlaps =
        current.start.getTime() < candidate.end.getTime() &&
        candidate.start.getTime() < current.end.getTime();

      if (overlaps) {
        conflicts.add(current.id);
        conflicts.add(candidate.id);
      }
    }
  }

  return conflicts;
}
