// Headless tests for src/yjs-schema.js
//
// Covers:
//  1. round-trip of a representative ProjectData object through Y.Doc
//  2. Y.Text fields are actual Y.Text instances inside the Y.Doc
//  3. concurrent edits on a Y.Text body merge character-by-character
//  4. concurrent appendRecord on two clients produces a union
//  5. findRecordById / deleteRecordById helpers
//  6. all 23 tables survive seed → dump

import * as Y from 'yjs';
import {
  TABLE_NAMES,
  Y_TEXT_FIELDS,
  projectDataToYDoc,
  yDocToProjectData,
  yDocToMetadata,
  appendRecord,
  findRecordById,
  deleteRecordById,
} from './src/yjs-schema.js';

let pass = true;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    pass = false;
  }
}

const NOW = '2026-05-25T00:00:00.000Z';

function sampleProjectData() {
  return {
    participants: [
      { id: 'p1', code: 'P01', displayName: 'P01', createdAt: NOW },
      { id: 'p2', code: 'P02', displayName: 'P02', createdAt: NOW },
    ],
    source_segments: [
      {
        id: 's1',
        participantId: 'p1',
        sourceFile: 'i.txt',
        importedAt: NOW,
        order: 0,
        text: 'インタビューの最初の発話．',
        speaker: 'インタビュアー',
        customFields: { time: '00:00:10' },
        previousVersionId: null,
        deletedAt: null,
      },
    ],
    cards: [
      {
        id: 'c1',
        participantId: 'p1',
        code: 'P01-001',
        serialNumber: 1,
        body: 'カード本文（Y.Text 対象）',
        status: 'active',
        placement: 'canvas',
        tags: ['重要', '保留'],
        displayStyle: { fontSize: 14, color: '#222' },
        memoLog: [{ id: 'm1', text: 'メモ 1', timestamp: NOW }],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    card_source_links: [
      {
        id: 'l1',
        cardId: 'c1',
        segmentId: 's1',
        startOffset: 0,
        endOffset: 12,
        selectedTextSnapshot: 'インタビュー',
        createdAt: NOW,
      },
    ],
    card_positions: [{ cardId: 'c1', x: 120, y: 200 }],
    groups: [
      {
        id: 'g1',
        name: '初期グループ',
        level: 1,
        parentGroupId: null,
        collapsed: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    group_memberships: [{ id: 'gm1', cardId: 'c1', groupId: 'g1', createdAt: NOW }],
    labels: [
      {
        id: 'lb1',
        groupId: 'g1',
        text: '表札テキスト',
        sharedMemo: '共有メモ',
        basisMemo: '根拠メモ',
        holdMemo: '保留メモ',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    group_positions: [{ groupId: 'g1', x: 100, y: 100, width: 400, height: 300 }],
    text_revisions: [],
    analysis_methods: [
      { id: 'am1', kind: 'kj', name: 'KJ 法', createdAt: NOW, updatedAt: NOW },
    ],
    analysis_sessions: [],
    analytic_object_links: [],
    m_gta_settings: [],
    m_gta_concepts: [
      {
        id: 'mc1',
        settingsId: 'ms1',
        name: '概念 A',
        definition: '概念 A の定義',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    m_gta_variations: [],
    m_gta_categories: [],
    theoretical_memos: [],
    diagram_relations: [],
    gta_codes: [],
    gta_code_applications: [],
    gta_categories: [],
  };
}

console.log('--- Test 1: round-trip ---');
{
  const original = sampleProjectData();
  const doc = new Y.Doc();
  projectDataToYDoc(original, doc, { name: 'P-Lab', schema_version: 8 });
  const dumped = yDocToProjectData(doc);
  for (const t of TABLE_NAMES) {
    check(
      `table ${t} length matches`,
      (dumped[t]?.length ?? 0) === (original[t]?.length ?? 0),
      `expected ${original[t]?.length ?? 0}, got ${dumped[t]?.length ?? 0}`
    );
  }
  check('card body preserved', dumped.cards[0].body === original.cards[0].body);
  check('segment text preserved', dumped.source_segments[0].text === original.source_segments[0].text);
  check('label text preserved', dumped.labels[0].text === original.labels[0].text);
  check('label sharedMemo preserved', dumped.labels[0].sharedMemo === '共有メモ');
  check('card tags preserved', JSON.stringify(dumped.cards[0].tags) === JSON.stringify(['重要', '保留']));
  check('card displayStyle.fontSize preserved', dumped.cards[0].displayStyle?.fontSize === 14);
  check('card memoLog preserved', dumped.cards[0].memoLog?.[0]?.text === 'メモ 1');
  check('segment customFields preserved', dumped.source_segments[0].customFields?.time === '00:00:10');
  check('null fields preserved', dumped.source_segments[0].previousVersionId === null);
  check('participant code preserved', dumped.participants[0].code === 'P01');
  check('metadata round-trip', yDocToMetadata(doc)?.name === 'P-Lab');
}

console.log('\n--- Test 2: Y.Text fields are actual Y.Text instances ---');
{
  const doc = new Y.Doc();
  projectDataToYDoc(sampleProjectData(), doc);
  const tables = doc.getMap('tables');
  for (const [tableName, fields] of Object.entries(Y_TEXT_FIELDS)) {
    const arr = tables.get(tableName);
    if (!arr || arr.length === 0) continue;
    const m = arr.get(0);
    for (const f of fields) {
      const v = m.get(f);
      if (v === undefined) continue; // optional fields may be missing in sample
      check(
        `${tableName}.${f} is Y.Text`,
        v instanceof Y.Text,
        `got ${v && v.constructor && v.constructor.name}`
      );
    }
  }
}

console.log('\n--- Test 3: Concurrent Y.Text edits merge character-by-character ---');
{
  const docA = new Y.Doc();
  projectDataToYDoc(sampleProjectData(), docA);
  // Replicate state to docB via Y.js encoded state
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

  // Both clients edit the card body
  const cardA = docA.getMap('tables').get('cards').get(0);
  const cardB = docB.getMap('tables').get('cards').get(0);
  const textA = cardA.get('body');
  const textB = cardB.get('body');
  check('starts with same body', textA.toString() === textB.toString());

  // A inserts "[A] " at position 0, B inserts " [B]" at end
  textA.insert(0, '[A] ');
  const origLen = textB.toString().length;
  textB.insert(origLen, ' [B]');

  // Sync A→B and B→A
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

  const merged = cardA.get('body').toString();
  const mergedB = cardB.get('body').toString();
  check('A and B converge after sync', merged === mergedB, `A="${merged}" B="${mergedB}"`);
  check('A insertion preserved', merged.startsWith('[A] '));
  check('B insertion preserved', merged.endsWith(' [B]'));
}

console.log('\n--- Test 4: Concurrent appendRecord merges as union ---');
{
  const docA = new Y.Doc();
  projectDataToYDoc(sampleProjectData(), docA);
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

  appendRecord(docA, 'cards', {
    id: 'ca',
    participantId: 'p1',
    code: 'P01-002',
    serialNumber: 2,
    body: 'A が追加したカード',
    status: 'active',
    placement: 'canvas',
    createdAt: NOW,
    updatedAt: NOW,
  });
  appendRecord(docB, 'cards', {
    id: 'cb',
    participantId: 'p2',
    code: 'P02-001',
    serialNumber: 1,
    body: 'B が追加したカード',
    status: 'active',
    placement: 'canvas',
    createdAt: NOW,
    updatedAt: NOW,
  });

  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

  const cardsA = yDocToProjectData(docA).cards.map((c) => c.id).sort();
  const cardsB = yDocToProjectData(docB).cards.map((c) => c.id).sort();
  check('A sees all cards', JSON.stringify(cardsA) === JSON.stringify(['c1', 'ca', 'cb']));
  check('B sees all cards', JSON.stringify(cardsB) === JSON.stringify(['c1', 'ca', 'cb']));
}

console.log('\n--- Test 5: findRecordById / deleteRecordById ---');
{
  const doc = new Y.Doc();
  projectDataToYDoc(sampleProjectData(), doc);
  const m = findRecordById(doc, 'cards', 'c1');
  check('findRecordById finds existing', m !== null && m.get('code') === 'P01-001');
  check('findRecordById returns null for missing', findRecordById(doc, 'cards', 'nope') === null);
  const removed = deleteRecordById(doc, 'cards', 'c1');
  check('deleteRecordById removes', removed === true);
  check('after delete: 0 cards', yDocToProjectData(doc).cards.length === 0);
  const removedAgain = deleteRecordById(doc, 'cards', 'c1');
  check('deleteRecordById of missing returns false', removedAgain === false);
}

console.log('\n--- Test 6: All 23 tables are mapped ---');
{
  const allTables = [
    'participants', 'source_segments', 'cards', 'card_source_links',
    'card_positions', 'groups', 'group_memberships', 'labels',
    'group_positions', 'text_revisions', 'analysis_methods',
    'analysis_sessions', 'analytic_object_links', 'm_gta_settings',
    'm_gta_concepts', 'm_gta_variations', 'm_gta_categories',
    'theoretical_memos', 'diagram_relations', 'gta_codes',
    'gta_code_applications', 'gta_categories',
  ];
  check('23 tables in TABLE_NAMES', TABLE_NAMES.length === 23, `got ${TABLE_NAMES.length}`);
  for (const t of allTables) {
    check(`${t} listed`, TABLE_NAMES.includes(t));
  }
}

console.log(`\n[schema-test] ${pass ? 'OK' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
