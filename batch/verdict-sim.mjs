// bigdeal verdict-sim v1.0 — 판정·이력 로직 전수 검사
// ★ 픽스처는 실행 시각 기준 상대 날짜로 생성한다 — "내일 아침에도 통과하는가"
import { verdictOf, buildHistory } from './batch.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, note = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name} ${note}`); }
};
const day = i => new Date(Date.now() + 9 * 3600 * 1000 - i * 86400000).toISOString().slice(0, 10);
const TODAY = day(0);
const hist = prices => prices.map((p, i) => ({ date: day(prices.length - 1 - i), price: p }));

console.log('[bigdeal verdict-sim v1.0]');

// ── 판정 ──
ok('6일치 → pending', verdictOf(hist([100, 100, 100, 100, 100, 100])).verdict === 'pending');
ok('1일치 → pending', verdictOf(hist([100])).verdict === 'pending');
ok('빈 이력 → pending', verdictOf([]).verdict === 'pending');
ok('★ 7일 전부 같은 가격 → flat (모체 [C8] 재발 방지)', verdictOf(hist([100, 100, 100, 100, 100, 100, 100])).verdict === 'flat');
ok('오늘 역대 최저 갱신 → alltime_low', verdictOf(hist([120, 120, 120, 120, 120, 120, 100])).verdict === 'alltime_low');
ok('과거 최저와 동가 복귀 → alltime_low', verdictOf(hist([100, 120, 120, 120, 120, 120, 100])).verdict === 'alltime_low');
ok('오늘 > 중앙값 → higher', verdictOf(hist([100, 100, 100, 100, 100, 100, 130])).verdict === 'higher');
ok('최저 아니지만 <= 중앙값 → normal', verdictOf(hist([100, 130, 130, 130, 130, 130, 120])).verdict === 'normal');
ok('결손 이력도 일수는 실날짜로', verdictOf([
  { date: day(9), price: 100 }, { date: day(8), price: 100 }, { date: day(1), price: 100 },
]).verdict === 'pending');
ok('verdictMin == 역대 최저', verdictOf(hist([120, 110, 130, 115, 118, 122, 116])).verdictMin === 110);

// ── 이력 구성 (n·s) ──
const base = hist([120, 118, 119]);
const h1 = buildHistory(base, [{ name: '토스쇼핑', price: 119, checkedAt: TODAY }], TODAY);
ok('토스 단독 → 오늘 n=1 s=토스쇼핑', h1.at(-1).n === 1 && h1.at(-1).s === '토스쇼핑');
ok('승계분 전 레코드에 n=1 s=토스쇼핑', h1.slice(0, -1).every(r => r.n === 1 && r.s === '토스쇼핑'));

const h2 = buildHistory(base, [
  { name: '토스쇼핑', price: 119, checkedAt: TODAY },
  { name: '하이마트', price: 112, checkedAt: TODAY },
  { name: '11번가', price: 121, checkedAt: TODAY },
], TODAY);
ok('★ 다곳 → 오늘 price=최저 n=3 s=최저 판매처', h2.at(-1).price === 112 && h2.at(-1).n === 3 && h2.at(-1).s === '하이마트');

const h3 = buildHistory(base, [
  { name: '토스쇼핑', price: 119, checkedAt: TODAY },
  { name: '하이마트', price: 105, checkedAt: day(2) },   // 이틀 전 확인가
], TODAY);
ok('★ 낡은 확인가는 오늘 이력에 안 들어감 (105 무시)', h3.at(-1).price === 119 && h3.at(-1).n === 1);

const baseYday = [{ date: day(3), price: 120 }, { date: day(2), price: 118 }, { date: day(1), price: 119 }];
const h4 = buildHistory(baseYday, [{ name: '하이마트', price: 105, checkedAt: day(3) }], TODAY);
ok('오늘 확인분 0곳 → 오늘 레코드 없음', h4.at(-1).date !== TODAY);

// ── 판매처 이탈 시나리오 — n 변화가 기록되는가 ──
const seq = [
  buildHistory([], [{ name: '토스쇼핑', price: 119, checkedAt: day(1) }, { name: '하이마트', price: 105, checkedAt: day(1) }], day(1)).at(-1),
  buildHistory([], [{ name: '토스쇼핑', price: 119, checkedAt: TODAY }], TODAY).at(-1),
];
ok('★ 판매처 이탈 → min 상승이 n 변화(2→1)와 함께 기록', seq[0].price === 105 && seq[0].n === 2 && seq[1].price === 119 && seq[1].n === 1);

// ── 통합: 판정이 n 주석과 무관하게 동작 ──
const merged = [...seq.map((r, i) => ({ date: day(9 - i), price: r.price })), ...hist([119, 119, 119, 119, 119])];
ok('통합 이력도 판정 계산 가능', ['pending', 'flat', 'alltime_low', 'normal', 'higher'].includes(verdictOf(merged).verdict));

console.log(`\n${pass}/${pass + fail}`);
if (fail) process.exit(1);
