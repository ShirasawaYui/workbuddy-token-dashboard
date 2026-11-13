import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_DIR } from './config.js';

/**
 * 极简文件索引（阶段 1 · 1.3）。
 *
 * 定位见计划 4.2：**不是判断主体**。冷热与候选集合靠 fs.stat 免费的
 * birthtimeMs / mtimeMs，索引只做三件事：
 *   1. 记已读文件的真实 firstTs / lastTs，兜底 birthtime 被复制/还原改写；
 *   2. 给 /api/meta 补模型集合、给 minTs 提供全文件 birthtime 下界；
 *   3. 记录 stat 指纹。
 *
 * 明确不承诺：offset 重启续读（Scanner 构造时不恢复 scan-state.json）、
 * 冷文件的真值（没读过就没有，兜底不完备）、跨平台 birthtime（按 4.5 不进范围）。
 *
 * 只记汇总量，**不写会话标题 / cwd / 提示词 / 绝对路径**；key 用相对
 * PROJECTS_DIR 的路径，数据源标识用绝对路径的哈希，换 WORKBUDDY_HOME 整体失效。
 */
const VERSION = 1;
const FILE_NAME = 'file-index.json';
/** 临时文件带 pid：多实例（回归夹具用不同 WORKBUDDY_HOME）同时写时不会互相踩成半文件 */
const TMP_NAME = `file-index.json.${process.pid}.tmp`;

function sourceKey(projectsDir) {
  return crypto.createHash('sha256').update(path.resolve(projectsDir)).digest('hex').slice(0, 16);
}

export class FileIndex {
  constructor({ cacheDir = null, projectsDir = PROJECTS_DIR } = {}) {
    this.cacheDir = cacheDir;
    this.projectsDir = projectsDir;
    this.key = sourceKey(projectsDir);
    /** @type {Map<string, object>} 相对路径 -> 汇总量 */
    this.entries = new Map();
    this.corrupt = false;
    this.writeTimer = null;
    this.writing = null;
  }

  relPath(filePath) {
    return path.relative(this.projectsDir, filePath).split(path.sep).join('/');
  }

  absPath(rel) {
    return path.resolve(this.projectsDir, rel);
  }

  /**
   * 读取索引。
   * @returns {{ok:boolean, created?:boolean, files?:number, reason?:string}}
   *  文件不存在 = 首次运行，属正常；存在但解析失败 / 版本或数据源不符 = 损坏，
   *  调用方应回退全量路径（不作为正确性依赖）。
   */
  load() {
    if (!this.cacheDir) return { ok: false, reason: 'no-cache-dir' };
    const p = path.join(this.cacheDir, FILE_NAME);
    if (!fs.existsSync(p)) return { ok: true, created: true, files: 0 };
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!raw || raw.version !== VERSION || raw.sourceKey !== this.key || !raw.files || typeof raw.files !== 'object') {
        throw new Error('版本或数据源不匹配');
      }
      this.entries = new Map(Object.entries(raw.files));
      this.corrupt = false;
      return { ok: true, created: false, files: this.entries.size };
    } catch (err) {
      this.entries = new Map();
      this.corrupt = true;
      return { ok: false, reason: err.message };
    }
  }

  /** filePath -> 真实首尾时间戳，供 Scanner.coldCandidates 优先用真值 */
  truthMap() {
    const m = new Map();
    for (const [rel, v] of this.entries) m.set(this.absPath(rel), v);
    return m;
  }

  /** 索引里已读文件见过的模型，补 /api/meta 的模型候选（口径 A：越用越准） */
  models() {
    const out = new Set();
    for (const v of this.entries.values()) {
      for (const m of v.models || []) if (m) out.add(m);
    }
    return [...out];
  }

  /** 把当前已加载文件的汇总量并入索引（未加载文件不动） */
  update(scanner) {
    let n = 0;
    for (const f of scanner.files.values()) {
      const sum = scanner.summarizeForIndex(f);
      if (!sum) continue;
      this.entries.set(this.relPath(f.filePath), sum);
      n += 1;
    }
    return n;
  }

  /** 节流写入，避免频繁切档时每个请求都落盘 */
  schedulePersist(scanner, delay = 400) {
    this.update(scanner);
    if (!this.cacheDir) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist();
    }, delay);
    this.writeTimer.unref?.();
  }

  /** 临时文件 + rename，避免半文件；写入失败只告警，不影响主流程 */
  async persist() {
    if (!this.cacheDir) return;
    if (this.writing) return this.writing;
    const job = (async () => {
      await fsp.mkdir(this.cacheDir, { recursive: true });
      const payload = JSON.stringify(
        { version: VERSION, sourceKey: this.key, updatedAt: Date.now(), files: Object.fromEntries(this.entries) },
        null,
        2,
      );
      const tmp = path.join(this.cacheDir, TMP_NAME);
      const dst = path.join(this.cacheDir, FILE_NAME);
      await fsp.writeFile(tmp, payload);
      await fsp.rename(tmp, dst);
    })()
      .catch(async (err) => {
        console.warn('[index] 写入失败（不影响主流程）', err.message);
        await fsp.rm(path.join(this.cacheDir, TMP_NAME), { force: true }).catch(() => {});
      });
    this.writing = job;
    try {
      return await job;
    } finally {
      this.writing = null;
    }
  }
}

export { VERSION as FILE_INDEX_VERSION, FILE_NAME as FILE_INDEX_NAME };
