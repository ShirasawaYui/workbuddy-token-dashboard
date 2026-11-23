/**
 * 子代理识别 —— 真实数据核对工具（只读）。
 *
 * 用修复后的 Scanner 全量扫真实 projects/，输出：
 *   1. 发现量：主会话文件 / 子代理文件、记录数、credit / token 拆分；
 *   2. 镜像对账：每个带子代理的会话，subagent 文件 Σcredit vs 父文件
 *      credit-usage 镜像行 Σcredit（两路必须互为印证）；
 *   3. 可选 DB 对账：workbuddy.db 的 session_usage.credit_json（官方账本）。
 *
 * 运行：node tools/verify-subagents.mjs
 * 环境：WORKBUDDY_HOME / TOKEN_DASHBOARD_* 与服务端同一套；默认只读，不写缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Scanner } from '../server/src/scanner.js';
import { summarize } from '../server/src/store.js';
import { HOME, PROJECTS_DIR } from '../server/src/config.js';

const fmt = (n, p = 2) => Number(n).toFixed(p);

async function main() {
  console.log('== 子代理识别核对（只读） ==');
  console.log('projectsDir:', PROJECTS_DIR);

  const scanner = new Scanner({ forceFullLoad: true }); // 不设 fileCacheDir：纯内存，不落缓存
  await scanner.scan();
  const { records, sessions } = scanner.all();

  let mainFiles = 0;
  let subFiles = 0;
  for (const f of scanner.files.values()) (f.isSubagent ? subFiles++ : mainFiles++);
  console.log(`发现文件：主会话 ${mainFiles} + 子代理 ${subFiles} = ${scanner.files.size}`);

  const sub = records.filter((r) => r.isSubAgent && !r.creditOnly);
  const main = records.filter((r) => !r.isSubAgent && !r.creditOnly);
  const cu = records.filter((r) => r.creditOnly);
  const sAll = summarize(records);
  const sSub = summarize(sub);
  console.log(`记录：总 ${records.length}（主线 ${main.length} / 子代理 ${sub.length} / 镜像兜底 ${cu.length}）`);
  console.log(`credit：总 ${fmt(sAll.credit, 4)}（主线 ${fmt(summarize(main).credit, 4)} + 子代理 ${fmt(sSub.credit, 4)} + 镜像兜底 ${fmt(summarize(cu).credit, 4)}）`);
  console.log(`子代理 token：Σ${sSub.total}（输入 ${sSub.prompt} / 输出 ${sSub.completion}）`);

  // ── 镜像对账：raw 读父文件的 credit-usage 行，与 subagent 文件 Σcredit 比 ──
  console.log('\n-- 镜像对账（subagent 文件 vs credit-usage 行）--');
  let mirrorMatch = 0;
  let mirrorMismatch = 0;
  for (const s of sessions) {
    const subRecs = records.filter((r) => r.sessionId === s.sessionId && r.isSubAgent && !r.creditOnly);
    if (!subRecs.length) continue;
    const subCredit = summarize(subRecs).credit;
    let cuCredit = 0;
    let cuN = 0;
    try {
      const text = fs.readFileSync(s.filePath, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes('"credit-usage"')) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === 'credit-usage') {
          cuCredit += Number(o.providerData?.credit) || 0;
          cuN += 1;
        }
      }
    } catch {
      /* 父文件缺失 */
    }
    const ok = Math.abs(subCredit - cuCredit) < 0.01 || cuN === 0;
    if (cuN === 0) {
      console.log(`  ${s.sessionId.slice(0, 8)}  子代理 ${fmt(subCredit)}（无镜像行——镜像是子集时正常）`);
    } else if (ok) {
      mirrorMatch += 1;
    } else {
      mirrorMismatch += 1;
      console.log(`  !! ${s.sessionId.slice(0, 8)}  子代理 ${fmt(subCredit)} vs 镜像 ${fmt(cuCredit)}（${cuN} 行）——不一致`);
    }
  }
  console.log(`镜像一致 ${mirrorMatch} 个会话，不一致 ${mirrorMismatch} 个`);

  // ── DB 对账（可选）：官方账本 session_usage.credit_json ──
  const dbPath = path.join(HOME, 'workbuddy.db');
  if (!fs.existsSync(dbPath)) {
    console.log('\n[跳过] 未找到 workbuddy.db，不做 DB 对账');
    return;
  }
  console.log('\n-- DB 对账（session_usage.credit_json）--');
  const { default: mod } = await import('node:sqlite').catch(() => ({ default: null }));
  if (!mod) {
    console.log('[跳过] node:sqlite 不可用');
    return;
  }
  const db = new mod.DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT session_id, credit_json FROM session_usage').all();
  db.close();

  let dbTotal = 0;
  let jsonlTotal = 0;
  let matched = 0;
  let mismatched = 0;
  for (const row of rows) {
    let credit = 0;
    try {
      const obj = JSON.parse(row.credit_json || '{}');
      for (const v of Object.values(obj)) credit += Number(v) || 0;
    } catch {
      continue;
    }
    dbTotal += credit;
    // JSONL 全通道（主线 + 子代理；镜像兜底只在无 subagent 文件时在场）
    const mine = summarize(records.filter((r) => r.sessionId === row.session_id)).credit;
    jsonlTotal += mine;
    const diff = Math.abs(mine - credit);
    if (diff < 0.02) {
      matched += 1;
    } else {
      mismatched += 1;
      console.log(`  !! ${String(row.session_id).slice(0, 8)}  JSONL ${fmt(mine)} vs DB ${fmt(credit)}  差 ${fmt(mine - credit)}`);
    }
  }
  console.log(`DB 会话 ${rows.length}：一致 ${matched} / 不一致 ${mismatched}`);
  console.log(`总量：JSONL ${fmt(jsonlTotal, 4)} vs DB ${fmt(dbTotal, 4)}  差 ${fmt(jsonlTotal - dbTotal, 4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
