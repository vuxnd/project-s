export default function migrate(record: Record<string, unknown>): Record<string, unknown> {
  const { size, ...rest } = record as { size: number[] };
  return { ...rest, halfExtents: size.map((v) => v / 2) };
}
