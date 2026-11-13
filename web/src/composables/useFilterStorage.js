/**
 * 把筛选条件存到 localStorage，下次打开接着用。
 *
 * 三条规则都是从"实际会长成什么样"倒推的，不是顺手加的：
 *
 * 1. **只在当天生效**。
 *    看板是"当天复盘"的工具。隔天打开还原出一堆昨天的关键词、昨天选的模型，
 *    用户的第一反应不是"接上了"，而是"我明明没筛，数据怎么这么少"——
 *    这是记忆功能最经典的翻车方式。所以只要 savedAt 不是今天，一律回默认。
 *
 * 2. **相对区间只存档位名，绝不存算出来的绝对日期**。
 *    点"近 7 天"时算出来的是当天的日期（如 2026-09-23）。把这个绝对日期存下来，
 *    第二天还原就变成"近 8 天"、档位高亮还对不上号。所以存 preset，
 *    还原时按**今天**重新算一次——这样连页面跨零点一直开着也不会错位。
 *
 * 3. **绝对条件要能被 meta 兜一道**（sanitizeFilter）。
 *    存下来的项目/模型可能已经从数据里消失了，直接还原会让选择器空着、
 *    结果恒为 0 条，比不还原更让人困惑。
 */
import { RELATIVE_PRESETS, rangeOfPreset, toDayStr } from '../utils/ranges.js';

const KEY = 'wb-token-dashboard:filter:v1';
const VERSION = 1;

export function defaultFilter() {
  // 默认「今天」：from 必须是今天的本地日期字符串，用 rangeOfPreset 算，别写死。
  // 默认档位下 from 非空 —— 所以 isDefault() 绝不能再拿 !f.from 当判据。
  const today = rangeOfPreset('今天');
  return {
    preset: '今天',
    from: today.from,
    to: today.to,
    projectId: 'all',
    model: 'all',
    kind: 'all',
    granularity: 'day',
    keyword: '',
  };
}

/** 判断是不是"没筛任何东西"，用于决定要不要给"已沿用"提示。
 *  granularity 是跟随区间自动兜正的派生值，不纳入判据：默认「今天」启动即被兜正为 hour，
 *  若把它算进来，下次打开默认档位会误报「已沿用今天用过的筛选」。 */
function isDefault(f) {
  // 跟 defaultFilter() 逐字段比对，而不是判 !f.from —— 默认「今天」的 from 本就非空，
  // 沿用「!f.from」会把"什么都没改"误判成非默认，从而误报「已沿用今天用过的筛选」。
  const d = defaultFilter();
  return (
    f.preset === d.preset &&
    f.from === d.from &&
    f.to === d.to &&
    (f.projectId || 'all') === 'all' &&
    (f.model || 'all') === 'all' &&
    (f.kind || 'all') === 'all' &&
    !f.keyword
  );
}

/**
 * 读取上次筛选。
 * @returns {{filter: object, restored: boolean}} restored 表示确实沿用了一份非默认的筛选
 */
export function loadFilter() {
  const base = defaultFilter();
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { filter: base, restored: false }; // 隐私模式 / 禁用存储时会抛
  }
  if (!raw) return { filter: base, restored: false };

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return { filter: base, restored: false }; // 存坏了就当没有，别让看板打不开
  }

  if (!data || data.v !== VERSION || !data.filter) return { filter: base, restored: false };
  if (data.savedAt !== toDayStr(new Date())) return { filter: base, restored: false }; // 规则 1

  const saved = data.filter;
  const filter = {
    ...base,
    projectId: saved.projectId || 'all',
    model: saved.model || 'all',
    kind: saved.kind || 'all',
    keyword: saved.keyword || '',
    granularity: saved.granularity || 'day',
    preset: saved.preset || base.preset, // 兜底回默认档位（现在是「今天」）
  };

  // 规则 2：相对档位按今天重算；自定义区间才用存下来的绝对日期
  if (RELATIVE_PRESETS.includes(filter.preset)) {
    Object.assign(filter, rangeOfPreset(filter.preset));
  } else {
    filter.from = saved.from || '';
    filter.to = saved.to || '';
  }

  return { filter, restored: !isDefault(filter) };
}

export function saveFilter(filter) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, savedAt: toDayStr(new Date()), filter }));
  } catch {
    /* 存不进去不该影响使用 */
  }
}

/** 保留一份"清空"入口，方便以后加"忘记筛选"按钮或排查问题时手动清 */
export function clearFilter() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 用最新 meta 校验存下来的选项是否还有效。
 * meta 是异步到的，所以只能在它到手之后调用，不能塞进 loadFilter。
 */
export function sanitizeFilter(filter, meta = {}) {
  const out = { ...filter };
  // 渐进补全期间（还有 JSONL 没加载）：候选的项目 / 模型 / 类型只是"已加载部分"，
  // 此时把用户已选但暂未出现在候选里的选项清成 all 会误伤 —— 先原样保留，
  // 等 loadedFiles 追上 totalFiles（或 fullLoad）后再恢复下面原有的清理行为。
  // 注意：App.poll() 刻意不调 sanitizeFilter（避免每拍改 filter 形成请求链），
  // 只有启动 loadMeta() / 手动 refresh() 会走到这里 —— 这处行为差异是有意为之。
  if (Number(meta.loadedFiles) < Number(meta.totalFiles)) return out;
  // 列表为空时不做判断（数据还没扫出来），否则会把用户的筛选误清掉
  const valid = (v, list) => !v || v === 'all' || !Array.isArray(list) || !list.length || list.includes(v);
  if (!valid(out.projectId, meta.projects)) out.projectId = 'all';
  if (!valid(out.model, meta.models)) out.model = 'all';
  if (!valid(out.kind, meta.kinds)) out.kind = 'all';
  return out;
}
