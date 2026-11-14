// 程序化平移生成新版 patches.json：以上一版补丁集为基准，按 SUBS 映射表（旧串→新串，整串精确替换）换名。
// 断言：每条映射至少命中 find 或 replace 之一，否则中止——防映射表写错。
// 局限（3.18.2 实证）：find 与 replace 中同一编辑的形态可能不同（replace 被注入内容打断/前缀改写/marker 不带长前缀），
//   必须为每种形态单独提供映射条目；生成后必须再跑 scripts/ident-audit.mjs 残留终审。
// 用法：复制本文件，改 SRC/DST 版本路径与 SUBS 表后 node 执行；本文件保留 3.18.0→3.18.2 的 SUBS 作范例。
import { readFileSync, writeFileSync } from 'node:fs';

const src = JSON.parse(readFileSync('D:/GitHub/Zcode-Expand/patches/3.18.0/patches.json', 'utf8'));

// 文件名映射
const FILE_MAP = {
  'out/main/chunk-GMTOLIE6.js': 'out/main/chunk-N4BDK3A6.js',
  'out/host/chunk-RB4EITEQ.js': 'out/host/chunk-IEBWXNOE.js',
  'out/host/chunk-OZH5HK54.js': 'out/host/chunk-O6MP7ZHZ.js',
  'out/renderer/assets/validation-hnAQ_U3V.js': 'out/renderer/assets/validation-CBeRQvEb.js',
  'out/renderer/assets/styles-BhvI6_DD.js': 'out/renderer/assets/styles-a4AckxCl.js',
};

// 每个编辑的 find/replace/marker 替换表：[oldStr, newStr]，作用于该编辑的三个字段
// 键："<目标文件(旧名)>#<编辑序号>"
const SUBS = {
  // index.html：入口哈希
  'out/renderer/index.html#0': [
    ['index-C5We7BLS.js', 'index-pAyOaFrs.js'],
  ],
  // styles：账号组件
  'out/renderer/assets/styles-BhvI6_DD.js#0': [
    ['{modelSelectionService:l,oauthService:u}=uf()', '{modelSelectionService:l,oauthService:u}=lf()'],
    // replace/marker 的后半段（zcXpSvc=uf()）单独覆盖，防半串替换
    ['zcXpSvc=uf()', 'zcXpSvc=lf()'],
    // marker 不带 {modelSelectionService:l, 前缀，需独立覆盖前半段
    ['oauthService:u}=uf()', 'oauthService:u}=lf()'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#1': [
    ['Je=(0,Q.useCallback)(async(e,t,n)=>{if(!(t!==`bigmodel`&&t!==`zai`)){', 'Ye=(0,Q.useCallback)(async(e,t,n)=>{if(!(t!==`bigmodel`&&t!==`zai`)){'],
    ['refreshAll:Le,refreshProviders:v,refreshPlanSnapshots:Pe,refreshPurchaseToken:Fe,familyDomainOf:Ei', 'refreshAll:Re,refreshProviders:v,refreshPlanSnapshots:Fe,refreshPurchaseToken:Ie,familyDomainOf:Ei'],
    ['c.executeDesktopCommand(br.ClearCodingPlanWebviewStorage)', 'c.executeDesktopCommand(Ua.ClearCodingPlanWebviewStorage)'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#3': [
    ['function D8n({providerName:e', 'function j8n({providerName:e'],
  ],
  // styles：项目树
  'out/renderer/assets/styles-BhvI6_DD.js#5': [
    ['tasks:_I(p,{kind:`project`', 'tasks:hI(p,{kind:`project`'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#6': [
    ['availability:m=jMt,', 'availability:m=IMt,'],
    ['additionalActions:v=MMt,', 'additionalActions:v=LMt,'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#7': [
    ['(0,$.jsx)(xl,{className:`size-3.5 animate-spin zc-xp-spin`', '(0,$.jsx)(yl,{className:`size-3.5 animate-spin zc-xp-spin`'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#8': [
    ['return(0,$.jsx)(eNt,{', 'return(0,$.jsx)(aNt,{'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#9': [
    ['function eNt({projects:e', 'function aNt({projects:e'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#11': [
    ['function KMt({title:e', 'function ZMt({title:e'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#12': [
    ['t?(0,$.jsx)(wc,{"aria-hidden":`true`,"data-purpose-section-chevron":`expanded`,', 't?(0,$.jsx)(Sc,{"aria-hidden":`true`,"data-purpose-section-chevron":`expanded`,'],
    ['(0,$.jsx)(xl,{className:`size-3.5 animate-spin zc-xp-spin`', '(0,$.jsx)(yl,{className:`size-3.5 animate-spin zc-xp-spin`'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#13': [
    ['||fnn(e)||(e.preventDefault(),xo(`escape`))', '||ynn(e)||(e.preventDefault(),So(`escape`))'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#14': [
    ['()=>Nft(n,L),[n,L]),fe=Wi(n),', '()=>Rft(n,L),[n,L]),fe=Ji(n),'],
    // replace 内 zcXpStatus 注入打断了连续串，词级兜底覆盖 replace 两侧
    ['Nft(n,L)', 'Rft(n,L)'],
    ['fe=Wi(n)', 'fe=Ji(n)'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#16': [
    ['(0,$.jsx)(xl,{className:`size-4 text-foreground-subtle`}', '(0,$.jsx)(yl,{className:`size-4 text-foreground-subtle`}'],
    ['(0,$.jsx)(xl,{className:`size-3.5 zc-xp-spin`', '(0,$.jsx)(yl,{className:`size-3.5 zc-xp-spin`'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#18': [
    ['(0,$.jsx)(xl,{className:`size-3.5 animate-spin text-foreground-subtle`}', '(0,$.jsx)(yl,{className:`size-3.5 animate-spin text-foreground-subtle`}'],
    ['(0,$.jsx)(xl,{className:`size-3.5 animate-spin zc-xp-spin`', '(0,$.jsx)(yl,{className:`size-3.5 animate-spin zc-xp-spin`'],
  ],
  'out/renderer/assets/styles-BhvI6_DD.js#19': [
    ['function XPt({workspacePath:e', 'function tFt({workspacePath:e'],
    // 覆盖 find（}){return uR()?）与 replace（;return uR()?）两种前缀
    ['return uR()?', 'return cR()?'],
  ],
  // host/chunk-O6MP7ZHZ：settings 服务
  'out/host/chunk-OZH5HK54.js#1': [
    ['d=s(async()=>(await a()).settings,"readSettings")', 'c=s(async()=>(await d()).settings,"readSettings")'],
    ['d=s(async()=>{let zcXpSettings=(await a()).settings;', 'c=s(async()=>{let zcXpSettings=(await d()).settings;'],
  ],
  'out/host/chunk-OZH5HK54.js#2': [
    ['async get(){await u;let _=await a(),E=await f(_.settings);return!_.needsMigrationPersist&&JSON.stringify(E)===JSON.stringify(_.settings)?E:(await k(async(b,R)=>{let v=await a(),T=await f(v.settings);!v.needsMigrationPersist&&JSON.stringify(T)===JSON.stringify(v.settings)||await c(T,b,R)}),d())}',
     'async get(){await p;let g=await d(),R=await T(g.settings);return!g.needsMigrationPersist&&JSON.stringify(R)===JSON.stringify(g.settings)?R:(await w(async(A,N)=>{let k=await d(),b=await T(k.settings);!k.needsMigrationPersist&&JSON.stringify(b)===JSON.stringify(k.settings)||await u(b,A,N)}),c())}'],
    ['async get(){await u;let _=await a(),E=await f(_.settings);let zcXpGet=', 'async get(){await p;let g=await d(),R=await T(g.settings);let zcXpGet='],
    ['let zcXpGet=!_.needsMigrationPersist&&JSON.stringify(E)===JSON.stringify(_.settings)?E:(await k(async(b,R)=>{let v=await a(),T=await f(v.settings);!v.needsMigrationPersist&&JSON.stringify(T)===JSON.stringify(v.settings)||await c(T,b,R)}),d());',
     'let zcXpGet=!g.needsMigrationPersist&&JSON.stringify(R)===JSON.stringify(g.settings)?R:(await w(async(A,N)=>{let k=await d(),b=await T(k.settings);!k.needsMigrationPersist&&JSON.stringify(b)===JSON.stringify(k.settings)||await u(b,A,N)}),c());'],
  ],
  // host/index.js：OAuth 实例与项目服务
  'out/host/index.js#0': [
    ['import{$ as jG,A as Oe,B as vf,C as AG,D as gh,F as nx,G as TG,H as OG,I as DG,J as NG,K as Pf,L as wh,M as BG,N as FG,O as LG,P as WG,Q as UG,R as sx,S as vh,T as $d,U as Cf,V as Os,W as If,X as vr,Z as Sh,a as IG,b as bG,c as JE,d as xc,e as wr,f as eo,g as ph,h as YE,i as Be,j as Ms,k as RG,l as XE,m as Mc,n as _G,o as Bo,p as fh,q as mh,r as Ht,s as QE,t as ex,u as tx,v as pP,w as jd,x as wf,y as fP,z as zd}from"./chunk-OZH5HK54.js";',
     'import{$ as nV,A as Oe,B as Sf,C as $G,D as hh,F as lx,G as ZG,H as GG,I as VG,J as JG,K as Cf,L as vh,M as YG,N as XG,O as QG,P as eV,Q as tV,R as mx,S as Sh,T as Hd,U as If,V as Os,W as bf,X as vr,Z as kh,a as WG,b as UG,c as ox,d as xc,e as fr,f as eo,g as fh,h as ix,i as Be,j as Ms,k as jG,l as sx,m as Mc,n as zG,o as Fo,p as mh,q as gh,r as Zt,s as ax,t as cx,u as dx,v as mP,w as $d,x as vf,y as gP,z as Zd}from"./chunk-O6MP7ZHZ.js";'],
  ],
  'out/host/index.js#1': [
    // 整串覆盖 find 与 replace 两种形态（replace 前缀 nr= 与官方赋值目标 wr 不可混淆）
    ['nr=xB(p,{captureCredentialGuard:i(()=>p.captureRecoveryGuard(),"captureCredentialGuard"),apiClient:C,onProviderLogout:W})', 'wr=UF(p,{captureCredentialGuard:i(()=>p.captureRecoveryGuard(),"captureCredentialGuard"),apiClient:C,onProviderLogout:W})'],
    ['nr=globalThis.__ZC_XP_OAUTH__=xB(p,{captureCredentialGuard:i(()=>p.captureRecoveryGuard(),"captureCredentialGuard"),apiClient:C,onProviderLogout:W})', 'wr=globalThis.__ZC_XP_OAUTH__=UF(p,{captureCredentialGuard:i(()=>p.captureRecoveryGuard(),"captureCredentialGuard"),apiClient:C,onProviderLogout:W})'],
    // marker 独立形态
    ['globalThis.__ZC_XP_OAUTH__=xB(p', 'globalThis.__ZC_XP_OAUTH__=UF(p'],
  ],
  'out/host/index.js#2': [
    ['.register(aa,nr)', '.register(aa,wr)'],
    ['globalThis.__ZC_XP_OAUTH_RPC__=nr', 'globalThis.__ZC_XP_OAUTH_RPC__=wr'],
  ],
  'out/host/index.js#4': [
    // 整串覆盖：find 短形态 + replace 完整形态（前缀 .register(_r,( 与尾部 ,sn)) 必须一起换）
    ['.register(_r,sn)', '.register(Er,On)'],
    ['.register(_r,(globalThis.__ZC_XP_PROJECTS__=sn,globalThis.__ZC_XP_STORE__&&globalThis.__ZC_XP_STORE__.migrateProjectRemarks(sn),sn))', '.register(Er,(globalThis.__ZC_XP_PROJECTS__=On,globalThis.__ZC_XP_STORE__&&globalThis.__ZC_XP_STORE__.migrateProjectRemarks(On),On))'],
    // marker 独立形态
    ['migrateProjectRemarks(sn)', 'migrateProjectRemarks(On)'],
  ],
  // main/index.js：import 与 openPath
  'out/main/index.js#0': [
    ['import{b as hy,c as wy}from"./chunk-VZGSK6OM.js";', 'import{b as Cy,c as Py}from"./chunk-AL54RMRC.js";'],
  ],
  'out/main/index.js#1': [
    ['import{b as hy,c as wy}from"./chunk-VZGSK6OM.js";', 'import{b as Cy,c as Py}from"./chunk-AL54RMRC.js";'],
  ],
  'out/main/index.js#2': [
    // 词级：该编辑内 mA×1（函数声明）、If×1（shell），replace 内形态因插入 DOPUS 调用与 find 不同
    ['mA(', 'CA('],
    ['If.openPath', 'Tf.openPath'],
  ],
  'out/main/index.js#3': [
    // 词级：ej×2（replace 内出现两次）、Af×1
    ['ej(', 'gj('],
    ['Af.openPath', '_f.openPath'],
  ],
  'out/main/index.js#4': [
    // 词级：mA×1、If×1（replace 改写为块形态，find 串不连续命中）
    ['mA(t)', 'CA(t)'],
    ['If.showItemInFolder', 'Tf.showItemInFolder'],
  ],
};

function applySubs(key, edit) {
  const subs = SUBS[key];
  if (!subs) return edit;
  const out = { ...edit };
  const hit = new Array(subs.length).fill(false);
  for (const field of ['find', 'replace', 'marker', 'note']) {
    if (typeof out[field] !== 'string') continue;
    let val = out[field];
    subs.forEach(([o, n], si) => {
      if (val.includes(o)) { hit[si] = true; val = val.split(o).join(n); }
    });
    out[field] = val;
  }
  subs.forEach(([o], si) => {
    if (!hit[si] && !/note-only/.test(o)) {
      // find/replace 均未命中 = 映射表写错，立即中止
      throw new Error(`find/replace 均未命中: ${key} :: ${String(o).slice(0, 70)}`);
    }
  });
  return out;
}

const out = { ...src };
out.appVersion = '3.18.2';
out.summary = 'ZCode 3.18.2（build 2681f4af），自 3.18.0 平移适配，功能集不变。保留项目行与任务分区头红等待>蓝运行>绿未读状态点、BigModel 账号管理/切换及只读探活、Token 用量状态栏（含子代理 v62.1）、Directory Opus、禁用 Esc 终止、旧备注一次性迁移、移动端远程控制启动自动激活。3.18.2 官方变化适配要点：渲染层服务集合 hook uf()→lf()；账号组件 Je→Ye、refreshAll Le→Re、refreshPlanSnapshots Pe→Fe、refreshPurchaseToken Fe→Ie、ClearCodingPlanWebviewStorage 枚举 br→Ua；按钮组 D8n→j8n；任务聚合 _I→hI；项目行默认值 jMt/MMt→IMt/LMt；分区容器 eNt→aNt、分区头 KMt→ZMt、expanded chevron wc→Sc、spinner xl→yl；任务状态 Nft→Rft、Wi→Ji、fnn→ynn、xo→So、远程控制入口 XPt→tFt、uR→cR；host settings 读点 d/c 对调（readSettings c=(await d()).settings）、get 段变量全套换名（u→p、_→g、a→d、E→R、f→T、k→w、c→u）、OAuth 实例 nr=xB→wr=UF（token aa 不变）、项目服务注册 _r,sn→Er,On；main 侧 import chunk-VZGSK6OM→chunk-AL54RMRC（hy/wy→Cy/Py）、openPath mA/If→CA/Tf、darwin ej/Af→gj/_f。锚点取自本机 build 2681f4af 原始 app.asar。';

out.targets = src.targets.map((t) => {
  const key0 = t.file;
  const newFile = FILE_MAP[t.file] ?? t.file;
  const idx = src.targets.indexOf(t);
  // 用旧文件名做 SUBS 键（编辑序号 = 该目标内 edits 下标）
  const edits = t.edits.map((ed, i) => applySubs(`${key0}#${i}`, ed));
  return { ...t, file: newFile, edits };
});

writeFileSync('D:/GitHub/Zcode-Expand/patches/3.18.2/patches.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('written. targets=' + out.targets.length + ', edits=' + out.targets.reduce((s, t) => s + t.edits.length, 0));
