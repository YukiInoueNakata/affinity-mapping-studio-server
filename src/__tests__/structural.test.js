// 対策7/2: 構造フィンガープリント・差分・impact のテスト．
// 2026-07-03 インシデントの署名 (全メンバーシップを新グループへ付替) を再現し，
// impact が閾値を超えることを確認する．
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  structuralFingerprint,
  diffFingerprints,
  hasStructuralChange,
  assessImpact,
} from '../structural.js';

/** cards / groups / group_memberships / card_positions を持つ doc を作る． */
function makeDoc(nCards, nGroups) {
  const doc = new Y.Doc();
  const tables = doc.getMap('tables');
  for (const name of ['cards', 'groups', 'group_memberships', 'card_positions']) {
    tables.set(name, new Y.Array());
  }
  const cards = tables.get('cards');
  const pos = tables.get('card_positions');
  const mem = tables.get('group_memberships');
  const groups = tables.get('groups');
  for (let i = 0; i < nGroups; i++) {
    const g = new Y.Map();
    g.set('id', `g${i}`);
    g.set('name', `グループレベル1 ${i + 1}`);
    groups.push([g]);
  }
  for (let i = 0; i < nCards; i++) {
    const c = new Y.Map();
    c.set('id', `c${i}`);
    cards.push([c]);
    const p = new Y.Map();
    p.set('cardId', `c${i}`);
    p.set('x', i * 10);
    p.set('y', i * 5);
    pos.push([p]);
    // 各カードを g(i % nGroups) に所属させる．
    const m = new Y.Map();
    m.set('cardId', `c${i}`);
    m.set('groupId', `g${i % nGroups}`);
    mem.push([m]);
  }
  return doc;
}

describe('structuralFingerprint', () => {
  it('cards/groups/memberships/positions を拾う', () => {
    const fp = structuralFingerprint(makeDoc(10, 3));
    expect(fp.cardIds.size).toBe(10);
    expect(fp.groupIds.size).toBe(3);
    expect(fp.memByCard.size).toBe(10);
    expect(fp.posByCard.size).toBe(10);
  });
});

describe('diffFingerprints + assessImpact', () => {
  it('通常のグループ化 (数枚) は低 impact', () => {
    const doc = makeDoc(20, 5);
    const before = structuralFingerprint(doc);
    // 3 枚を新グループ g99 に付け替え．
    const groups = doc.getMap('tables').get('groups');
    const gNew = new Y.Map();
    gNew.set('id', 'g99');
    gNew.set('name', 'グループレベル1 99');
    groups.push([gNew]);
    const mem = doc.getMap('tables').get('group_memberships').toArray();
    for (let i = 0; i < 3; i++) mem[i].set('groupId', 'g99');
    const after = structuralFingerprint(doc);
    const diff = diffFingerprints(before, after);
    expect(hasStructuralChange(diff)).toBe(true);
    expect(diff.groupsAdded).toContain('グループレベル1 99');
    expect(diff.membershipsRepointed).toBe(3);
    const imp = assessImpact(before, after, diff);
    expect(imp.impact).toBeLessThan(0.4); // 3/20 = 0.15
  });

  it('インシデント署名 (全メンバーシップを新グループへ付替) は高 impact', () => {
    const doc = makeDoc(104, 52);
    const before = structuralFingerprint(doc);
    const groups = doc.getMap('tables').get('groups');
    const g53 = new Y.Map();
    g53.set('id', 'g_rogue');
    g53.set('name', 'グループレベル1 53');
    groups.push([g53]);
    // 全 104 メンバーシップを g_rogue に付替 + 全カード移動．
    const mem = doc.getMap('tables').get('group_memberships').toArray();
    for (const m of mem) m.set('groupId', 'g_rogue');
    const pos = doc.getMap('tables').get('card_positions').toArray();
    for (const p of pos) { p.set('x', -5000); p.set('y', -1000); }
    const after = structuralFingerprint(doc);
    const diff = diffFingerprints(before, after);
    const imp = assessImpact(before, after, diff);
    expect(diff.membershipsRepointed).toBe(104);
    expect(diff.cardsMoved).toBe(104);
    expect(imp.impact).toBeGreaterThanOrEqual(0.4); // = 1.0 → 検知される
  });

  // Codex#2: 削除系の大規模破壊も検知できること
  it('全メンバーシップ削除は高 impact (削除系)', () => {
    const doc = makeDoc(104, 52);
    const before = structuralFingerprint(doc);
    const memArr = doc.getMap('tables').get('group_memberships');
    memArr.delete(0, memArr.length); // 全メンバーシップ削除
    const after = structuralFingerprint(doc);
    const diff = diffFingerprints(before, after);
    expect(diff.membershipsRemoved).toBe(104);
    const imp = assessImpact(before, after, diff);
    expect(imp.impact).toBeGreaterThanOrEqual(0.4); // 104/104 = 1.0
  });

  it('全グループ削除は高 impact (削除系)', () => {
    const doc = makeDoc(104, 52);
    const before = structuralFingerprint(doc);
    const groups = doc.getMap('tables').get('groups');
    groups.delete(0, groups.length);
    const after = structuralFingerprint(doc);
    const diff = diffFingerprints(before, after);
    expect(diff.groupsRemoved).toBe(52);
    const imp = assessImpact(before, after, diff);
    expect(imp.impact).toBeGreaterThanOrEqual(0.4);
  });

  it('大量カード削除は高 impact (削除系)', () => {
    const doc = makeDoc(104, 52);
    const before = structuralFingerprint(doc);
    const cards = doc.getMap('tables').get('cards');
    cards.delete(0, 60); // 60/104 削除
    const after = structuralFingerprint(doc);
    const diff = diffFingerprints(before, after);
    expect(diff.cardsRemoved).toBe(60);
    const imp = assessImpact(before, after, diff);
    expect(imp.impact).toBeGreaterThanOrEqual(0.4); // 60/104 ≈ 0.58
  });
});
