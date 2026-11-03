// 対策7 + 対策2 (2026-07-03): 構造フィンガープリントと差分・impact 算出．
//
// 2026-07-03 のインシデントは「単一トランザクションで新グループ作成 + 全
// メンバーシップを付替 + 全カードを移動」だった．doc の tables から軽量な
// 構造フィンガープリントを作り，更新前後で差分すれば
//   - 構造変化の監査ログ (対策7)
//   - 大規模変更の検知 = サーキットブレーカー (対策2)
// が同じ材料でまかなえる．純関数なので単体テスト可能．

// Codex#10 (perf): structuralFingerprint は update ごとに cards/groups/memberships/
// positions を全走査するため O(n)．実運用規模 (~120 cards) では無視できるが，将来
// 大規模部屋では per-update の Y イベント delta から差分更新する最適化余地がある (据え置き)．
/** doc.getMap('tables') から構造フィンガープリントを作る (軽量). */
export function structuralFingerprint(doc) {
  const tables = doc.getMap('tables');
  const cardIds = new Set();
  const cardsArr = tables.get('cards');
  if (cardsArr && typeof cardsArr.forEach === 'function') {
    cardsArr.forEach((m) => {
      const id = m && typeof m.get === 'function' ? m.get('id') : undefined;
      if (id != null) cardIds.add(id);
    });
  }
  const groupIds = new Set();
  const groupNames = new Map();
  const groupsArr = tables.get('groups');
  if (groupsArr && typeof groupsArr.forEach === 'function') {
    groupsArr.forEach((m) => {
      if (!m || typeof m.get !== 'function') return;
      const id = m.get('id');
      if (id == null) return;
      groupIds.add(id);
      groupNames.set(id, m.get('name'));
    });
  }
  const memByCard = new Map();
  const memArr = tables.get('group_memberships');
  if (memArr && typeof memArr.forEach === 'function') {
    memArr.forEach((m) => {
      if (!m || typeof m.get !== 'function') return;
      const cid = m.get('cardId');
      if (cid != null) memByCard.set(cid, m.get('groupId'));
    });
  }
  const posByCard = new Map();
  const posArr = tables.get('card_positions');
  if (posArr && typeof posArr.forEach === 'function') {
    posArr.forEach((m) => {
      if (!m || typeof m.get !== 'function') return;
      const cid = m.get('cardId');
      if (cid == null) return;
      const x = Math.round(Number(m.get('x')) || 0);
      const y = Math.round(Number(m.get('y')) || 0);
      posByCard.set(cid, `${x},${y}`);
    });
  }
  return { cardIds, groupIds, groupNames, memByCard, posByCard };
}

/** old→cur の構造差分を計算する． */
export function diffFingerprints(oldFp, curFp) {
  const groupsAdded = [];
  for (const g of curFp.groupIds) {
    if (!oldFp.groupIds.has(g)) groupsAdded.push(curFp.groupNames.get(g) ?? g);
  }
  let groupsRemoved = 0;
  for (const g of oldFp.groupIds) if (!curFp.groupIds.has(g)) groupsRemoved++;

  const newGroupIds = new Set();
  for (const g of curFp.groupIds) if (!oldFp.groupIds.has(g)) newGroupIds.add(g);

  let membershipsRepointed = 0;
  let repointedToNewGroup = 0;
  let membershipsAdded = 0;
  for (const [cid, gid] of curFp.memByCard) {
    if (!oldFp.memByCard.has(cid)) {
      membershipsAdded++;
      if (newGroupIds.has(gid)) repointedToNewGroup++;
    } else if (oldFp.memByCard.get(cid) !== gid) {
      membershipsRepointed++;
      if (newGroupIds.has(gid)) repointedToNewGroup++;
    }
  }
  let membershipsRemoved = 0;
  for (const cid of oldFp.memByCard.keys()) if (!curFp.memByCard.has(cid)) membershipsRemoved++;

  let cardsMoved = 0;
  for (const [cid, p] of curFp.posByCard) {
    if (oldFp.posByCard.has(cid) && oldFp.posByCard.get(cid) !== p) cardsMoved++;
  }
  let cardsAdded = 0;
  for (const c of curFp.cardIds) if (!oldFp.cardIds.has(c)) cardsAdded++;
  let cardsRemoved = 0;
  for (const c of oldFp.cardIds) if (!curFp.cardIds.has(c)) cardsRemoved++;

  return {
    groupsAdded,
    groupsRemoved,
    membershipsRepointed,
    repointedToNewGroup,
    membershipsAdded,
    membershipsRemoved,
    cardsMoved,
    cardsAdded,
    cardsRemoved,
  };
}

/** 差分に group/membership/card の増減があるか (=構造変化があったか). */
export function hasStructuralChange(diff) {
  return (
    diff.groupsAdded.length > 0 ||
    diff.groupsRemoved > 0 ||
    diff.membershipsRepointed > 0 ||
    diff.membershipsAdded > 0 ||
    diff.membershipsRemoved > 0 ||
    diff.cardsAdded > 0 ||
    diff.cardsRemoved > 0
  );
}

/** サーキットブレーカー用 impact (0..1)．メンバーシップ付替率・カード移動率の
 *  最大値．1 トランザクションでこの割合を超える変更は「大規模変更」と見なす． */
export function assessImpact(oldFp, curFp, diff) {
  const totalMem = Math.max(oldFp.memByCard.size, curFp.memByCard.size, 1);
  const totalCards = Math.max(oldFp.cardIds.size, curFp.cardIds.size, 1);
  const memImpact = diff.membershipsRepointed / totalMem;
  const moveImpact = diff.cardsMoved / totalCards;
  const newGroupAbsorb = diff.repointedToNewGroup / totalMem;
  // Codex#2: 削除系 (全メンバーシップ削除 / 全グループ削除 / 大量カード削除) も
  // 「大規模破壊」として検知する．割合の分母は削除前 (old) の総数．
  const memBefore = Math.max(oldFp.memByCard.size, 1);
  const cardsBefore = Math.max(oldFp.cardIds.size, 1);
  const groupsBefore = Math.max(oldFp.groupIds.size, 1);
  const memRemoveImpact = (diff.membershipsRemoved ?? 0) / memBefore;
  const cardRemoveImpact = (diff.cardsRemoved ?? 0) / cardsBefore;
  const groupRemoveImpact = (diff.groupsRemoved ?? 0) / groupsBefore;
  const impact = Math.max(
    memImpact,
    moveImpact,
    newGroupAbsorb,
    memRemoveImpact,
    cardRemoveImpact,
    groupRemoveImpact
  );
  return {
    impact,
    memImpact,
    moveImpact,
    newGroupAbsorb,
    memRemoveImpact,
    cardRemoveImpact,
    groupRemoveImpact,
    totalMem,
    totalCards,
  };
}
