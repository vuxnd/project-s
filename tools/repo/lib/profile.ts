// The portable schema profile (plan 4.6) and the record envelope (4.7.3), checked on parsed schema files.
import { isObject, joinPointer } from './json.ts';
import type { Json } from './json.ts';
import { error } from './problems.ts';
import type { Problem } from './problems.ts';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const ALLOWED = new Set([
  '$schema', '$ref', '$defs', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties', 'propertyNames', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
  'x-ref', 'x-asset', 'x-unit',
]);
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
// Keywords that need a matching type, with the types that allow them.
const NEEDS: [keywords: string[], types: string[]][] = [
  [['properties', 'required', 'additionalProperties', 'propertyNames'], ['object']],
  [['items', 'minItems', 'maxItems', 'uniqueItems'], ['array']],
  [['minLength', 'maxLength', 'pattern'], ['string']],
  [['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'], ['number', 'integer']],
  [['x-ref', 'x-asset'], ['string']],
];
const DEF_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
export const REF_FORM = /^(#\/\$defs\/[A-Za-z][A-Za-z0-9_]*|([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+\.schema\.json(#\/\$defs\/[A-Za-z][A-Za-z0-9_]*)?)$/;
const TYPE_ID = /^[a-z][a-z0-9_]{0,63}\.[a-z][a-z0-9_]{0,63}$/;
const EXTENSION = /^[a-z0-9]+$/;
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const DATA_KEYWORDS = new Set(['const', 'default', 'examples', 'enum']);

// The non-null type a `type` value names ("x" or ["x", "null"]); null when the value is invalid, undefined when absent.
function kindOf(type: Json | undefined): string | null | undefined {
  if (type === undefined) return undefined;
  if (typeof type === 'string' && TYPES.includes(type)) return type;
  if (Array.isArray(type) && type.length === 2 && type[1] === 'null' && typeof type[0] === 'string' && type[0] !== 'null' && TYPES.includes(type[0])) return type[0];
  return null;
}

// Problems are reported at the pointer of the schema node that breaks the rule.
export function checkProfile(schema: Json, file: string): Problem[] {
  const problems: Problem[] = [];
  const bad = (pointer: string, message: string): void => {
    problems.push(error(file, pointer, 'profile', message));
  };

  const visit = (node: Json, pointer: string, root: boolean): void => {
    if (!isObject(node)) {
      bad(pointer, typeof node === 'boolean' ? 'a boolean is not a schema; use {} for any value' : 'a schema must be an object');
      return;
    }
    for (const key of Object.keys(node)) {
      if (!ALLOWED.has(key)) bad(pointer, `${key} is not in the schema profile`);
    }
    if (root) {
      if (node.$schema !== DRAFT) bad(pointer, `$schema must be ${DRAFT}`);
    } else {
      for (const key of ['$schema', '$defs']) {
        if (Object.hasOwn(node, key)) bad(pointer, `${key} is only allowed at the schema root`);
      }
    }

    const kind = kindOf(node.type);
    if (kind === null) {
      bad(pointer, `type must be one of ${TYPES.join(' ')}, or [T, "null"] with T not null`);
    } else {
      for (const [keywords, kinds] of NEEDS) {
        for (const keyword of keywords) {
          if (Object.hasOwn(node, keyword) && (kind === undefined || !kinds.includes(kind))) bad(pointer, `${keyword} needs type ${kinds.join(' or ')}`);
        }
      }
    }

    const props = node.properties;
    const additional = node.additionalProperties;
    if (kind === 'object') {
      if (additional === undefined) bad(pointer, 'an object must state additionalProperties');
      else if (isObject(additional) && props !== undefined) bad(pointer, 'an object with properties needs additionalProperties: false');
      else if (isObject(additional) && !Object.hasOwn(node, 'propertyNames')) bad(pointer, 'a map needs propertyNames');
    }
    if (Array.isArray(node.required)) {
      for (const name of node.required) {
        if (typeof name === 'string' && !(isObject(props) && Object.hasOwn(props, name))) bad(pointer, `required name ${name} is not a key of properties`);
      }
    }
    const values = node.enum;
    if (values !== undefined && !(Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string') && new Set(values).size === values.length)) {
      bad(pointer, 'enum must be a non-empty list of distinct strings');
    }
    if (typeof node.$ref === 'string' && !REF_FORM.test(node.$ref)) {
      bad(pointer, `$ref ${node.$ref} must be #/$defs/<name> or a relative path to a *.schema.json file`);
    }
    const xRef = node['x-ref'];
    if (xRef !== undefined && !(typeof xRef === 'string' && TYPE_ID.test(xRef))) bad(pointer, 'x-ref must be a qualified type id, <module>.<type>');
    const xAsset = node['x-asset'];
    if (xAsset !== undefined) {
      if (!(Array.isArray(xAsset) && xAsset.length > 0 && xAsset.every((e) => typeof e === 'string' && EXTENSION.test(e)) && new Set(xAsset).size === xAsset.length)) {
        bad(pointer, 'x-asset must be a non-empty list of distinct lowercase extensions');
      } else if (xAsset.includes('gltf')) {
        bad(pointer, 'x-asset must not list gltf; 3D assets are GLB');
      }
    }
    const xUnit = node['x-unit'];
    if (xUnit !== undefined && (typeof xUnit !== 'string' || xUnit === '')) bad(pointer, 'x-unit must be a non-empty string');

    if (isObject(props)) {
      for (const [name, child] of Object.entries(props)) visit(child, joinPointer(pointer, 'properties', name), false);
    }
    if (Array.isArray(node.items)) bad(pointer, 'items must be a single schema');
    else if (node.items !== undefined) visit(node.items, joinPointer(pointer, 'items'), false);
    if (additional !== undefined && additional !== false) {
      if (isObject(additional)) visit(additional, joinPointer(pointer, 'additionalProperties'), false);
      else bad(joinPointer(pointer, 'additionalProperties'), 'additionalProperties must be false or a schema');
    }
    if (node.propertyNames !== undefined) visit(node.propertyNames, joinPointer(pointer, 'propertyNames'), false);
    if (root && isObject(node.$defs)) {
      for (const [name, def] of Object.entries(node.$defs)) {
        const at = joinPointer(pointer, '$defs', name);
        if (!DEF_NAME.test(name)) bad(at, `$defs name ${name} must match ${DEF_NAME.source}`);
        visit(def, at, false);
      }
    }
  };

  visit(schema, '', true);
  return problems;
}

function isVersion(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

// A missing part is reported at the node that should hold it, a wrong one at the part itself.
export function checkRecordType(schema: Json, file: string): Problem[] {
  if (!isObject(schema)) return [];
  const problems: Problem[] = [];
  const bad = (pointer: string, message: string): void => {
    problems.push(error(file, pointer, 'record-type', message));
  };
  const props = isObject(schema.properties) ? schema.properties : undefined;
  const where = (name: string): string => (props === undefined ? '' : Object.hasOwn(props, name) ? joinPointer('/properties', name) : '/properties');

  if (schema.type !== 'object') bad('', 'a record type needs type object');
  if (schema.additionalProperties !== false) bad('', 'a record type needs additionalProperties false');
  for (const name of ['$schema', '$comment']) {
    const prop = props?.[name];
    if (!isObject(prop) || prop.type !== 'string') bad(where(name), `properties must declare ${name} with type string`);
  }
  const version = props?.$version;
  if (!isObject(version) || !isVersion(version.const)) bad(where('$version'), 'properties must declare $version as { "const": N } with N an integer of at least 1');
  if (!Array.isArray(schema.required) || !schema.required.includes('$version')) bad('', '$version must be in required');
  return problems;
}

// Every value of `keyword` below `schema` with its pointer, in document order; maps hold schemas under arbitrary names, data keywords hold none.
function occurrences(schema: Json, keyword: string, pointer = '', inMap = false): { pointer: string; value: Json }[] {
  const found: { pointer: string; value: Json }[] = [];
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => found.push(...occurrences(item, keyword, joinPointer(pointer, i))));
  } else if (isObject(schema)) {
    for (const [key, value] of Object.entries(schema)) {
      const at = joinPointer(pointer, key);
      if (inMap) found.push(...occurrences(value, keyword, at));
      else if (key === keyword) found.push({ pointer: at, value });
      else if (!DATA_KEYWORDS.has(key)) found.push(...occurrences(value, keyword, at, SCHEMA_MAPS.has(key)));
    }
  }
  return found;
}

// The pointer is that of the keyword's value, for example /properties/size/$ref.
export function schemaRefs(schema: Json): { pointer: string; ref: string }[] {
  return occurrences(schema, '$ref').flatMap(({ pointer, value }) => (typeof value === 'string' ? [{ pointer, ref: value }] : []));
}

export function typeRefs(schema: Json): { pointer: string; type: string }[] {
  return occurrences(schema, 'x-ref').flatMap(({ pointer, value }) => (typeof value === 'string' ? [{ pointer, type: value }] : []));
}
