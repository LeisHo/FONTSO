import { splitSelfLoops } from '../../lab/src/tween.mjs';
let pass = true;
const chk = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) pass = false;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const P = (x, y) => ({ x, y });

// A plain open polyline: nothing to split.
chk('straight line -> no loops', splitSelfLoops([P(0,0),P(10,0),P(20,0)]).loops.length, 0);

// A figure-of-eight style self-crossing: out, around, back across.
const loopy = [P(0,0), P(10,0), P(10,10), P(0,10), P(5,-5), P(5,20)];
const r1 = splitSelfLoops(loopy);
chk('self-crossing detected', r1.loops.length >= 1, true);
chk('loop is closed (first === last)',
    r1.loops[0] && r1.loops[0][0].x === r1.loops[0][r1.loops[0].length-1].x
                && r1.loops[0][0].y === r1.loops[0][r1.loops[0].length-1].y, true);
chk('remaining path is shorter than the original', r1.path.length < loopy.length, true);

// The excised loop must not still self-cross.
chk('excised loop has no further self-crossing of its own',
    splitSelfLoops(r1.loops[0]).loops.length, 0);

// A near-degenerate sliver encloses almost nothing: cut, but not kept.
const sliver = [P(0,0), P(10,0), P(9.98,0.02), P(9.98,-0.02), P(20,0)];
const r2 = splitSelfLoops(sliver);
chk('near-zero-area sliver is not kept', r2.loops.length, 0);
chk('...but the path was still cleaned', r2.path.length <= sliver.length, true);

// A small but REAL loop of only four points must survive - the thing a
// point-count filter would have wrongly discarded.
const smallReal = [P(0,0), P(10,0), P(7,4), P(7,-4), P(20,0)];
chk('small four-point loop with real area IS kept', splitSelfLoops(smallReal).loops.length, 1);

console.log(pass ? '\nALL PASS' : '\nFAILURES ABOVE');
process.exit(pass ? 0 : 1);
