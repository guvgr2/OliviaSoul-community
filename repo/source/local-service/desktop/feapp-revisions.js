// 本支 FE（feapp.dat）补丁版本序列 —— 唯一权威来源。
//
// ⚠️ 为什么要有这个文件：
//   同一个"版本列表"曾被复制到 6 个地方（controller.js ×3、uninstall-restore.js、
//   client-backups.js ×2），每次新增补丁版本都要记得全改一遍 —— 结果补丁升到 v46 时
//   漏了三处，直接导致用户点「启用本地服务」报 backup feapp archive identity mismatch，
//   以及卸载恢复路径上同样的判定失效。
//
// 现在规则是：**新增补丁版本时，只改下面这一个数组。**
// （仍需同步的外部文件：tools/patch-feapp-local.ps1 的 marker、tools/get-feapp-status.ps1 的 knownMarkers）
//
// 注意区分两种语义：
//   · feappRevisionRank()  只认「本支发布过的版本」，不认识的一律返回 null
//     → 这样 v999 这类未知/他人的补丁版本永远不会被误当成"可升级"或"本支补丁"
//   · feappRevisionAtLeast(revision, min) 用连续区间判断，避免再写一长串枚举
export const FEAPP_REVISIONS = [
  'v22', 'v23', 'v24', 'v25', 'v26', 'v27', 'v28', 'v29', 'v30', 'v31',
  'v32', 'v33', 'v34', 'v35', 'v36', 'v37', 'v38', 'v39', 'v40', 'v41',
  'v42', 'v43', 'v44', 'v45', 'v46', 'v47', 'v48', 'v49', 'v50', 'v52', 'v53', 'v54', 'v55', 'v56', 'v57', 'v58', 'v59', 'v60', 'v61', 'v62', 'v63'
];

/** 返回本支已知版本的序号（v46 → 46）；未知版本返回 null。 */
export function feappRevisionRank(revision) {
  const matched = /^v(\d{1,12})$/u.exec(String(revision ?? ''));
  if (!matched) return null;
  const value = Number(matched[1]);
  return FEAPP_REVISIONS.includes(`v${value}`) ? value : null;
}

/** revision 是否为「本支已知的补丁版本」。 */
export function isKnownFeappRevision(revision) {
  return feappRevisionRank(revision) !== null;
}

/**
 * revision 是否 >= min（例如 min='v31'）。
 * 未知版本一律返回 false —— 与既有行为一致（例如 v999 不得被当作可升级版本）。
 */
export function feappRevisionAtLeast(revision, min) {
  const rank = feappRevisionRank(revision);
  if (rank === null) return false;
  const floor = Number(String(min).replace(/^v/u, ''));
  return Number.isInteger(floor) && rank >= floor;
}

/** 生成 PowerShell 侧判定「main 是否带本支已知补丁 marker」的表达式片段（避免在 ps1 里再抄一遍列表）。 */
export function feappMarkerStartsWithExpression(textVariable = '$text') {
  return FEAPP_REVISIONS.map(revision => `${textVariable}.StartsWith('/*OliviaSoulPatch:mail-music-${revision}*/')`).join(' -or ');
}
