// 标识符粒度终审：上一版补丁集平移生成新版 patches.json 后，检查 replace/marker 中的旧版标识符残留。
// 规则：改名对旧侧标识符（OLD_IDS，按上一版→新版映射手工提炼）出现在 replace/marker 中、
//       且同编辑 find 中没有该名（find 已对照新版验证=合法）→ 残留嫌疑。
// 用法：node scripts/ident-audit.mjs（读 patches/<新版>/patches.json，需先改本文件中的版本路径与 OLD_IDS）。
// 由来：3.18.2 适配实证——半串残留的 `_r` 在注册链处 TDZ，host 启动即崩，语法门禁/探针/verify 三道全放行，
//       仅此审计能拦。压缩名轮回会误报（如 Fe），按「文件 #序号 字段::名」加白名单。
import { readFileSync } from 'node:fs';

const p = JSON.parse(readFileSync('D:/GitHub/Zcode-Expand/patches/3.19.1/patches.json', 'utf8'));

// 从 SUBS 改名对提炼的旧标识符（3.18.2 侧），按风险列出
const OLD_IDS = ['lf','G','ve','be','Ei','Ua','ue','j8n','hI','IMt','LMt','aNt','ZMt','Sc','yl','Rft','Ji','fe','de','ynn','So','tFt','cR','Ke','xt','qn','wr','UF','aa','Er','On','CA','Tf','gj','_f','Cy','Py','AL54RMRC','N4BDK3A6','IEBWXNOE','O6MP7ZHZ','CBeRQvEb','a4AckxCl','pAyOaFrs'];

// 白名单：旧标识符同时是 3.19.1 find/replace 中出现的合法新名（find 已对照新版验证），按编辑+字段豁免
// styles#1 replace 的 be = 3.19.1 合法新名（settings:be，setOAuthError be→ye 的目标位恰好轮回），与 3.18.2 的 setOAuthError 同名属压缩名轮回
const WHITELIST = new Set(['out/renderer/assets/styles-BKbqL3QI.js #1 replace :: be']);
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
