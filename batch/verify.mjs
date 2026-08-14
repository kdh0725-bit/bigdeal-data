// bigdeal verify v1.0 — 배포 직전 산출물 검사. 하나라도 실패하면 exit(1) → push 중단
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'deals-latest.json');
const ALLOW_STALE = process.argv.includes('--allow-stale');

const raw = fs.readFileSync(OUT, 'utf8');
const d = JSON.parse(raw);
let pass = 0, fail = 0;
const ok = (name, cond, note = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name} ${note}`); }
};
const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

console.log('[bigdeal verify v1.0]');

// ── 스키마·기본 ──
ok('schema == 1', d.schema === 1);
ok('app == bigdeal', d.app === 'bigdeal');
ok('건수 >= 500 (모체 수준)', d.items.length >= 500, `(${d.items.length})`);
ok('수집 날짜가 오늘(KST)', ALLOW_STALE || d.date === kstToday, `(${d.date} vs ${kstToday})`);

// ── 필수 필드 전건 ──
const missing = d.items.filter(it =>
  !it.id || !it.name || !Number.isFinite(it.sellers?.[0]?.price) ||
  !it.merchantType || !Array.isArray(it.priceHistory) || !it.priceHistory.length);
ok('필수 필드(id·name·seller가·merchantType·이력) 전건', missing.length === 0, `누락 ${missing.length}건`);

// ── 판매처 ──
const noUrl = d.items.filter(it => it.sellers.some(s => !s.productUrl));
ok('전 seller에 productUrl(원본) 보관', noUrl.length === 0, `${noUrl.length}건`);
const noChecked = d.items.filter(it => it.sellers.some(s => !s.checkedAt));
ok('전 seller에 checkedAt', noChecked.length === 0, `${noChecked.length}건`);

// ── 사이트코드 위생 ──
ok('모체 사이트코드(A100706842) 혼입 없음', !raw.includes('A100706842'));
const lpLinks = d.items.flatMap(it => it.sellers).filter(s => (s.link || '').includes('linkprice'));
ok('링크프라이스 링크 전건에 A100706845', lpLinks.every(s => s.link.includes('A100706845')), `(lp링크 ${lpLinks.length}건)`);

// ── 이력 위생 ──
const badHist = d.items.filter(it => it.priceHistory.some(r => !r.date || !Number.isFinite(r.price) || !Number.isFinite(r.n) || !r.s));
ok('이력 레코드에 date·price·n·s 전건', badHist.length === 0, `${badHist.length}건`);
const unsorted = d.items.filter(it => {
  const ds = it.priceHistory.map(r => r.date);
  return ds.some((v, i) => i && v <= ds[i - 1]);
});
ok('이력이 날짜 오름차순·중복 없음', unsorted.length === 0, `${unsorted.length}건`);

// ── 도메인 위생 — 계산 버그를 비율로 잡는다 ──
const v = d.summary.verdicts || {};
const special = (v.alltime_low || 0) + (v.low30 || 0);
ok('특별한 판정이 과반 미만', special < d.items.length / 2, `(특별 ${special}/${d.items.length})`);
ok('판정 합계 == 전체 건수', Object.values(v).reduce((a, b) => a + b, 0) === d.items.length);

// ── 시크릿 ──
const secrets = ['BEGIN PRIVATE KEY', 'BEGIN CERTIFICATE', 'accessKey', 'secretKey', 'auth_key'];
ok('시크릿 문자열 혼입 없음', secrets.every(s => !raw.includes(s)));

console.log(`\n${pass}/${pass + fail}`);
if (fail) process.exit(1);
