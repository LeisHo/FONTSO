// Exercises the exact scenario asked about: teach an order, change
// settings so the topology gains a serif, teach again, then go back.
import {
    writeLearned, readLearned, bestLearnedOrder, orderFromLearned,
} from '../../lab/src/routeOrder.mjs';

const box = { minX: 0, minY: 0, maxX: 100, maxY: 100, w: 100, h: 100 };
const info = { postScriptName: 'TestFace' };
const A = (x, y) => ({ x, y });

// PLAIN 'H': 3 strokes. Taught order = left stem, right stem, crossbar.
const plainAnchors = [A(0.1, 0.1), A(0.9, 0.1), A(0.5, 0.5)];
// SERIF 'H': the same 3 plus two serif branches at the feet.
const serifAnchors = [A(0.1, 0.1), A(0.9, 0.1), A(0.5, 0.5), A(0.1, 0.95), A(0.9, 0.95)];

const stopsFor = (anchors) => anchors.map((a, i) => ({
    id: 'stop' + i, order: i + 1, point: { x: a.x * 100, y: a.y * 100 }, letter: null,
}));

// Shuffle so the "computed" order differs from the taught one - otherwise
// a pass proves nothing.
const shuffle = (arr) => { const c = arr.slice(); c.reverse(); return c.map((s, i) => ({ ...s, order: i + 1 })); };

let store = {};
let pass = true;
const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) pass = false;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

// --- 1. teach the plain order --------------------------------------
store = writeLearned(store, info, 'H', plainAnchors);
check('one variant stored', readLearned(store, info, 'H').length, 1);

// --- 2. topology changes; teach the serif order --------------------
store = writeLearned(store, info, 'H', serifAnchors);
check('BOTH variants kept (the original question)', readLearned(store, info, 'H').length, 2);

// --- 3. back to the plain topology ---------------------------------
const plainStops = shuffle(stopsFor(plainAnchors));
const rPlain = bestLearnedOrder(plainStops, readLearned(store, info, 'H'), box);
check('plain route: all 3 stops explained', rPlain.matched, 3);
check('plain route: taught order restored', rPlain.ids, ['stop0', 'stop1', 'stop2']);

// --- 4. the serif topology -----------------------------------------
const serifStops = shuffle(stopsFor(serifAnchors));
const rSerif = bestLearnedOrder(serifStops, readLearned(store, info, 'H'), box);
check('serif route: all 5 stops explained', rSerif.matched, 5);
check('serif route: taught order restored', rSerif.ids, ['stop0', 'stop1', 'stop2', 'stop3', 'stop4']);

// --- 5. the point of keeping both: DELETE the plain variant and check
//        the serif one alone still orders a plain route correctly ----
let serifOnly = {};
serifOnly = writeLearned(serifOnly, info, 'H', serifAnchors);
const rCross = bestLearnedOrder(plainStops, readLearned(serifOnly, info, 'H'), box);
check('richer variant alone still orders the sparser route', rCross.ids, ['stop0', 'stop1', 'stop2']);

// --- 6. re-teaching the same topology must not accumulate ----------
store = writeLearned(store, info, 'H', plainAnchors.map((a) => ({ x: a.x + 0.001, y: a.y })));
check('near-identical re-teach replaces, does not stack', readLearned(store, info, 'H').length, 2);

// --- 7. old bare-array format still loads --------------------------
const legacy = { ['TestFace\u0000H']: plainAnchors };
check('legacy format reads as one variant', readLearned(legacy, info, 'H').length, 1);

console.log(pass ? '\nALL PASS' : '\nFAILURES ABOVE');
process.exit(pass ? 0 : 1);
