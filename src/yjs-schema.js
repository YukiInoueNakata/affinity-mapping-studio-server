// Phase 4b-2: KJ Trace Studio ProjectData ↔ Y.Doc mapping.
//
// Design overview (full design in ../../docs/yjs-sync-design.md):
//   - One Y.Doc per project / room.
//   - Top-level Y.Map "tables" holds Y.Array of Y.Map records, one per
//     ProjectData table (23 tables).
//   - String fields that benefit from character-level CRDT merge are stored as
//     Y.Text inside the record's Y.Map (cards.body, labels.text/sharedMemo,
//     etc.).  Everything else is a plain JS value.
//   - Top-level Y.Map "metadata" holds project metadata fields.
//
// This module is intentionally schema-version-agnostic: it dumps whatever
// table-named arrays the data has, so adding a new table on the renderer
// side does not require coordinated server-side changes.

import * as Y from 'yjs';

/** Tables we mirror.  Keep in sync with src/shared/types/domain.ts ProjectData. */
export const TABLE_NAMES = [
  'participants',
  'source_segments',
  'cards',
  'card_source_links',
  'card_positions',
  'groups',
  'group_memberships',
  'labels',
  'group_positions',
  'text_revisions',
  'analysis_methods',
  'analysis_sessions',
  'analytic_object_links',
  'm_gta_settings',
  'm_gta_concepts',
  'm_gta_variations',
  'm_gta_categories',
  'theoretical_memos',
  'diagram_relations',
  'gta_codes',
  'gta_code_applications',
  'gta_categories',
  // 2026-11-04: 段ごとのタブ（第 2 段以降の配置）．root をサーバーが先に作り，
  // 2 人が同時に tables.set() して片方が消える事故（2026-06-16 と同型）を防ぐ．
  'level_positions',
];

/** Per-table, which string fields are stored as Y.Text for character-level
 *  collaborative editing.  Other strings remain as plain values inside the
 *  record's Y.Map. */
export const Y_TEXT_FIELDS = {
  source_segments: ['text'],
  cards: ['body'],
  labels: ['text', 'sharedMemo', 'basisMemo', 'holdMemo'],
  theoretical_memos: ['body'],
  m_gta_concepts: ['definition'],
  m_gta_variations: ['interpretation'],
  m_gta_categories: ['definition'],
  gta_codes: ['definition'],
  gta_categories: ['definition'],
};

const SEED_ORIGIN = Symbol('seed');

/** Bulk-seed a Y.Doc from a plain ProjectData object.  This is a destructive
 *  operation: it replaces the current contents of every mapped table.
 *
 *  Returns SEED_ORIGIN so the caller can identify (and ignore) the resulting
 *  update event if needed. */
export function projectDataToYDoc(projectData, doc, metadata = null) {
  Y.transact(
    doc,
    () => {
      const tables = doc.getMap('tables');
      for (const name of TABLE_NAMES) {
        let arr = tables.get(name);
        if (!arr) {
          arr = new Y.Array();
          tables.set(name, arr);
        } else if (arr.length > 0) {
          arr.delete(0, arr.length);
        }
        const records = projectData?.[name] ?? [];
        if (records.length === 0) continue;
        arr.push(records.map((r) => recordToYMap(name, r)));
      }
      if (metadata) {
        const m = doc.getMap('metadata');
        for (const [k, v] of Object.entries(metadata)) {
          m.set(k, isPlainObject(v) ? cloneShallow(v) : v);
        }
      }
    },
    SEED_ORIGIN
  );
  return SEED_ORIGIN;
}

/** Ensure every mapped table has a root Y.Array in the doc.  Creates an empty
 *  Y.Array for any MISSING table key and leaves existing arrays untouched.
 *
 *  2026-06-16 (uploadProject clobber fix): サーバーがルーム doc を 1 度だけ
 *  正規化するために使う．これにより各 client は root array を新規
 *  `tables.set()` する必要がなくなり，空ルームへの同時 upload で起きる
 *  「Y.Map.set の last-writer-wins による相手の全行 clobber」を構造的に防ぐ
 *  (client は既存 array に push するだけ → 同時 upload は union になる)．
 *
 *  冪等: 既に全 array が在る room では変更が無く，Y.transact は update を
 *  発火しない (= 再起動のたびの再 seed や永続化の churn は起きない)．
 *  返り値: 新規作成した table 数． */
export function ensureEmptyTables(doc) {
  let created = 0;
  Y.transact(
    doc,
    () => {
      const tables = doc.getMap('tables');
      for (const name of TABLE_NAMES) {
        if (!tables.get(name)) {
          tables.set(name, new Y.Array());
          created += 1;
        }
      }
    },
    SEED_ORIGIN
  );
  return created;
}

/** Convert a record into a Y.Map, with Y.Text for selected fields. */
function recordToYMap(tableName, record) {
  const m = new Y.Map();
  const ytextFields = Y_TEXT_FIELDS[tableName] ?? [];
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    if (ytextFields.includes(k) && typeof v === 'string') {
      const t = new Y.Text();
      if (v.length > 0) t.insert(0, v);
      m.set(k, t);
    } else if (v === null) {
      m.set(k, null);
    } else if (Array.isArray(v)) {
      // Plain arrays (e.g. tags, memoIds) stored as JS arrays inside the
      // Y.Map.  This means concurrent edits to a tags array become
      // last-write-wins; that's acceptable for tag-like fields.
      m.set(k, v.slice());
    } else if (isPlainObject(v)) {
      // Nested plain objects (displayStyle, customFields, memoLog entries)
      // stored as JS objects.  Same last-write-wins caveat.
      m.set(k, cloneShallow(v));
    } else {
      m.set(k, v);
    }
  }
  return m;
}

/** Dump the entire Y.Doc state back to a plain ProjectData object. */
export function yDocToProjectData(doc) {
  const tables = doc.getMap('tables');
  const out = {};
  for (const name of TABLE_NAMES) {
    const arr = tables.get(name);
    out[name] = arr ? arr.toArray().map((m) => yMapToRecord(m)) : [];
  }
  return out;
}

/** Dump the metadata Y.Map back to a plain object (or null if empty). */
export function yDocToMetadata(doc) {
  const m = doc.getMap('metadata');
  if (m.size === 0) return null;
  const out = {};
  m.forEach((v, k) => {
    out[k] = isPlainObject(v) ? cloneShallow(v) : v;
  });
  return out;
}

function yMapToRecord(m) {
  if (!(m instanceof Y.Map)) {
    return m;
  }
  const r = {};
  m.forEach((v, k) => {
    if (v instanceof Y.Text) {
      r[k] = v.toString();
    } else if (v instanceof Y.Map) {
      r[k] = yMapToRecord(v);
    } else if (v instanceof Y.Array) {
      r[k] = v.toArray().map((x) => (x instanceof Y.Map ? yMapToRecord(x) : x));
    } else if (Array.isArray(v)) {
      r[k] = v.slice();
    } else if (isPlainObject(v)) {
      r[k] = cloneShallow(v);
    } else {
      r[k] = v;
    }
  });
  return r;
}

function isPlainObject(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !(v instanceof Y.AbstractType) &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function cloneShallow(o) {
  const out = {};
  for (const k of Object.keys(o)) out[k] = o[k];
  return out;
}

/** Helper used by clients to push a new record into a table.
 *  Returns the created Y.Map (so the caller can read field values back). */
export function appendRecord(doc, tableName, record, origin = 'append') {
  let result;
  Y.transact(
    doc,
    () => {
      const tables = doc.getMap('tables');
      let arr = tables.get(tableName);
      if (!arr) {
        arr = new Y.Array();
        tables.set(tableName, arr);
      }
      result = recordToYMap(tableName, record);
      arr.push([result]);
    },
    origin
  );
  return result;
}

/** Locate a record's Y.Map by its `id` field (table-scoped). */
export function findRecordById(doc, tableName, id) {
  const tables = doc.getMap('tables');
  const arr = tables.get(tableName);
  if (!arr) return null;
  for (const m of arr) {
    if (m instanceof Y.Map && m.get('id') === id) return m;
  }
  return null;
}

/** Delete a record by id; no-op if not found.  Returns true if a record was removed. */
export function deleteRecordById(doc, tableName, id, origin = 'delete') {
  let removed = false;
  Y.transact(
    doc,
    () => {
      const tables = doc.getMap('tables');
      const arr = tables.get(tableName);
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) {
        const m = arr.get(i);
        if (m instanceof Y.Map && m.get('id') === id) {
          arr.delete(i, 1);
          removed = true;
          return;
        }
      }
    },
    origin
  );
  return removed;
}
