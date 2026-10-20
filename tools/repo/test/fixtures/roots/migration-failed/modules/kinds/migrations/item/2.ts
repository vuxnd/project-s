export default function migrate(record: Record<string, unknown>): Record<string, unknown> {
  throw new Error(`no rule to rename ${JSON.stringify(record.name)} to label`);
}
