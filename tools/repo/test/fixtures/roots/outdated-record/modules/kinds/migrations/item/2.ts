export default function migrate(record: Record<string, unknown>): Record<string, unknown> {
  const { name, ...rest } = record;
  return { ...rest, label: name };
}
