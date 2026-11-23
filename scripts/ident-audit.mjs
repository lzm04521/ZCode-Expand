// 标识符粒度终审：上一版补丁集平移生成新版 patches.json 后，检查 replace/marker 中的旧版标识符残留。
// 规则：改名对旧侧标识符（OLD_IDS，按上一版→新版映射手工提炼）出现在 replace/marker 中、
//       且同编辑 find 中没有该名（find 已对照新版验证=合法）→ 残留嫌疑。
// 用法：node scripts/ident-audit.mjs（读 patches/<新版>/patches.json，需先改本文件中的版本路径与 OLD_IDS）。
// 由来：3.18.2 适配实证——半串残留的 `_r` 在注册链处 TDZ，host 启动即崩，语法门禁/探针/verify 三道全放行，
//       仅此审计能拦。压缩名轮回会误报（如 Fe），按「文件 #序号 字段::名」加白名单。
import { readFileSync } from 'node:fs';

const p = JSON.parse(readFileSync('D:/GitHub/Zcode-Expand/patches/4.0.0/patches.json', 'utf8'));

// 从 4.0.0 平移改名对提炼的旧标识符（3.19.1 侧），按风险列出
const OLD_IDS = ['Eh','u7n','cI','WPt','GPt','pFt','aFt','kc','xl','Lsn','ao','Zpt','Yi','uLt','tR','Va','hr','TB','Ft','Hb','$b','YT','Ff','b6','Gf','m','u','I','A','w','b','lt','mr','Ho','t','VH3XR3TF','ASCI4U4P','PD4GOPHK','y0cT70_L','BKbqL3QI','gnrpuno','MGNVGTOG'];

// 白名单：旧侧名字在 4.0.0 仍是合法引用（定义级实证），按编辑+字段豁免
// styles #3/#4 的 m = 我方新增的 zcXpSwitch 形参别名（#3 声明、#4 使用），与 host 设置 chunk 改名的 e as m 无关
// styles #8 的 m = 会话任务列表（let p=new Set(...),m=$F(e,{kind:`project`,...），4.0.0 未改名
const WHITELIST = new Set([
  'out/renderer/assets/styles-D2WmIVpU.js #3 replace :: m',
  'out/renderer/assets/styles-D2WmIVpU.js #3 marker :: m',
  'out/renderer/assets/styles-D2WmIVpU.js #4 replace :: m',
  'out/renderer/assets/styles-D2WmIVpU.js #4 marker :: m',
  'out/renderer/assets/styles-D2WmIVpU.js #8 replace :: m',
]);
// （find 中出现 = 该编辑的官方上下文里此名仍是新版合法符号）
const report = [];
for (const t of p.targets) {
  t.edits.forEach((ed, i) => {
    const findIds = new Set((ed.find.match(/[A-Za-z_$][\w$]*/g) || []));
    for (const id of OLD_IDS) {
      for (const f of ['replace', 'marker']) {
        const val = ed[f];
        if (typeof val !== 'string') continue;
        const re = new RegExp('(?<![\\w$])' + id.replace(/[$]/g, '\\$') + '(?![\\w$])');
        if (re.test(val) && !findIds.has(id)) {
          const key = `${t.file} #${i} ${f} :: ${id}`;
          if (!WHITELIST.has(key)) report.push(`${t.file} #${i} ${f} :: 残留嫌疑 '${id}'（find 中无此名）`);
        }
      }
    }
  });
}
console.log(report.length === 0 ? 'IDENT-AUDIT-CLEAN' : report.join('\n'));
