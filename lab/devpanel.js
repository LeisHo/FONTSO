    // ================================================================
    // DEV PANEL ENGINE — everything below is generic, no project-
    // specific names. See the big comment at the top of this file for
    // how to integrate your own settings.
    // ================================================================

    // devPanelBuilt MUST be declared here, as one of the very first
    // statements in this script - NOT further down near
    // ensureDevPanelBuilt() itself, however natural that might look.
    // The DEV toggle button's onclick (parsed early, in the HTML above,
    // long before this ~2000-line script finishes downloading/
    // executing) reads this variable the moment it's clicked - if a
    // visitor clicks it before script execution reaches a `let`
    // declared later in the file, that read throws "Cannot access
    // 'devPanelBuilt' before initialization" (a real bug, reproduced
    // and fixed this exact way in a real project - MAINTENANCE note at
    // the top of this file). Declaring it here, before anything else
    // that could plausibly be clicked, closes that gap by construction.
    let devPanelBuilt = false;

    // isDevAllowed gates both the panel's CSS visibility (the early
    // <head> script above sets html.dev-mode from this SAME condition,
    // kept in sync manually - see its own comment for why it can't
    // share this declaration) and, below, the LAZY-BUILD trigger itself
    // (search "LAZY-BUILD"). PROJECT: if you change this condition,
    // update the early <head> script's own copy to match.
    const isDevAllowed = location.protocol === 'file:' ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1' ||
        new URLSearchParams(location.search).get('dev') === '1';

    const devPanel = document.getElementById('devPanel');

    // Which tabs exist, and their DOM-id prefix (tabId + 'TabContent',
    // tabId + 'TabBtn' pattern via devTab<Cap>Btn). Add/remove/rename a
    // tab here — but note the HTML above, the #<id>TabContent.hidden CSS
    // rule, and the 3 tab <button> elements all currently hardcode these
    // 3 literal names too (see the top-of-file comment on why that one
    // CSS rule couldn't be made fully attribute-generic cleanly) — treat
    // this constant as the single source of truth to keep them in sync
    // if you do change it.
    // ================================================================
    // [JS-1] SETUP & TAB CONFIG
    // ================================================================
    const DEV_PANEL_TABS = ['desktop', 'mobile', 'landscape'];

    function isNarrowViewport() { return window.innerWidth < 768; }

    // ================================================================
    // [JS-2] GROUP COLLAPSE/TOGGLE & CUSTOM GROUP CREATION
    // ================================================================
    // A group title created by createDevGroupElement() carries a
    // trailing cascade checkbox as a real DOM child - every plain
    // `titleEl.textContent = ...` rewrite below would otherwise wipe it
    // (destroying its listeners) every single collapse/expand or rename-
    // sync. Detaches it first, runs `fn`, reattaches the SAME node
    // (listeners/checked state intact) after - a static built-in title
    // (no checkbox) just runs `fn` directly, unaffected either way. See
    // buildGroupCascadeCheckbox()'s own comment ([JS-4b0] above).
    function withPreservedTitleCheckbox(titleEl, fn) {
        const cb = titleEl.querySelector(':scope > .dev-group-cascade-checkbox');
        if (cb) cb.remove();
        fn();
        if (cb) titleEl.appendChild(cb);
    }
    // Group collapse/toggle, custom group creation
    function toggleSection(titleEl) {
        if (sectionJustDragged) { sectionJustDragged = false; return; }
        if (textEditModeEnabled) { openDevTextEditFor(titleEl, getSectionKey(titleEl), true); return; }
        const content = titleEl.nextElementSibling;
        content.classList.toggle('collapsed');
        withPreservedTitleCheckbox(titleEl, () => {
            titleEl.textContent = content.classList.contains('collapsed') ? '▶ ' + titleEl.textContent.slice(2) : '▼ ' + titleEl.textContent.slice(2);
        });
    }

    // `tab` ('desktop' | 'mobile' | 'landscape') decides which kind of
    // group-level cascade checkbox this group gets - see
    // buildGroupCascadeCheckbox()'s own comment ([JS-4b0] above).
    // Defaults to 'desktop' only for backward compat with any call site
    // that predates this parameter; every real call site in this file
    // passes it explicitly.
    function createDevGroupElement(name, tab) {
        const section = document.createElement('div');
        section.className = 'dev-section';
        const title = document.createElement('div');
        title.className = 'dev-section-title';
        title.setAttribute('onclick', 'toggleSection(this)');
        title.dataset.sid = name;
        title.textContent = '▼ ' + name;
        title.appendChild(buildGroupCascadeCheckbox(section, (tab || 'desktop') === 'desktop' ? 'visibility' : 'independence'));
        const content = document.createElement('div');
        content.className = 'dev-section-content';
        section.appendChild(title);
        section.appendChild(content);
        addGroupDragHandle(section);
        addGroupLockIcon(section);
        section.appendChild(buildGroupUndockButton(section));
        return section;
    }

    // Builds and appends one group's own drag-handle icon — per CLAUDE.md
    // §12n's far-left-icon-only convention (ported from Clicko's own
    // identical fix; see that project's CHANGELOG for the direct request
    // this came from — ultimately modeled on the Handy Dandies project's
    // own handle-only drag gating). A plain SIBLING of .dev-section-title
    // (see .dev-section's own CSS comment for why — unlike the cascade
    // checkbox, this icon never needs to survive a textContent rewrite
    // via preserve/reattach, since it was never inside the title to begin
    // with). setupDragReorder()'s own pointerdown listener gates on
    // handleSelector ('.dev-group-drag-handle', not '.dev-section-title' —
    // see its own call site below), so a plain click on the title still
    // only ever toggles collapse, never arms a drag. Idempotent (removes
    // any existing handle first) so calling it twice on the same section
    // (e.g. a custom group recreated by applySectionOrder() from saved
    // data) just replaces the icon rather than duplicating it.
    function addGroupDragHandle(section) {
        const existing = section.querySelector(':scope > .dev-group-drag-handle');
        if (existing) existing.remove();
        const titleEl = section.querySelector(':scope > .dev-section-title');
        if (!titleEl) return;
        const handle = document.createElement('span');
        handle.className = 'dev-group-drag-handle';
        handle.textContent = '⠿';
        handle.title = 'Drag to reorder or nest this group';
        section.appendChild(handle);
    }
    // One-time pass over every group already in the DOM when the panel is
    // first built (createDevGroupElement() covers any group added or
    // recreated after this point via its own addGroupDragHandle() call).
    // Tab-wide, any nesting depth — nested groups need the icon too.
    function injectGroupDragHandles() {
        DEV_PANEL_TABS.forEach(tab => {
            const tabEl = document.getElementById(tab + 'TabContent');
            if (!tabEl) return;
            tabEl.querySelectorAll('.dev-section').forEach(addGroupDragHandle);
        });
    }
    // Row-level counterpart. Idempotent (skips a row that already has
    // one) so it's safe to call repeatedly - needed here unlike a fully
    // static panel, since this template's own dynamicDevice feature
    // (ensureDynamicTargetRow(), [JS-4b0] above) DOES create new row DOM
    // after the panel is first built, whenever a Mobile/Landscape mirror
    // row doesn't exist yet. Called once here at panel-build time for
    // every row that exists already, and again at the end of
    // syncTabOrderToDesktop() (see its own call) for any row freshly
    // created by that same sync pass.
    function injectRowDragHandles() {
        document.querySelectorAll('.dev-row').forEach(row => {
            if (row.querySelector(':scope > .dev-row-drag-handle')) return;
            const handle = document.createElement('span');
            handle.className = 'dev-row-drag-handle';
            handle.textContent = '⠿';
            handle.title = 'Drag to reorder or move to another group';
            row.insertBefore(handle, row.firstChild);
        });
    }

    // "+ Add Group" handler — considers EVERY group in the tab (top-
    // level and nested), not just top-level siblings, so a new group's
    // name is unique against an existing nested group's name too.
    // Shift+click multi-select - per direct request ("when i hold the
    // Shift key, I will be able to select a single or multiple settings
    // or groups or a mix of the two. Once selected, when i click Add
    // Group, the selected things will automatically be placed within
    // the new group. Unselect when i click outside of the dev panel").
    // Holds real DOM elements directly (a .dev-row for a selected
    // setting, a .dev-section for a selected group) rather than keys/ids
    // - simpler since a selection is a short-lived, purely-runtime UI
    // gesture with no persistence of its own (never saved/copied), and
    // addDevGroup() below just needs to move these exact nodes.
    const devPanelSelectedItems = new Set();
    // Set by #devAddGroupBtn's own contextmenu handler
    // (setupDevHeaderIconButtons()) - while true, a PLAIN left click also
    // selects (no Shift needed), per direct request ("If i right click
    // the Add Group button, I want to be able to left click mutiple
    // settings or groups to select them"). Shift+click keeps working
    // regardless of this flag - the two triggers are additive, not
    // mutually exclusive.
    let devGroupSelectionArmed = false;
    function toggleDevSelection(el) {
        if (devPanelSelectedItems.has(el)) {
            devPanelSelectedItems.delete(el);
            el.classList.remove('dev-selected');
        } else {
            devPanelSelectedItems.add(el);
            el.classList.add('dev-selected');
        }
    }
    function clearDevSelection() {
        devPanelSelectedItems.forEach(el => el.classList.remove('dev-selected'));
        devPanelSelectedItems.clear();
    }
    function disarmDevGroupSelection() {
        devGroupSelectionArmed = false;
        const btn = document.getElementById('devAddGroupBtn');
        if (btn) btn.classList.remove('armed');
    }
    // A capturing listener on the panel itself (not each row/title
    // individually) so it works uniformly for every control type,
    // including ones added later by a project's own render*Controls().
    // Capturing + preventDefault/stopPropagation together ensure a
    // Shift+click (or an armed plain click) SELECTS instead of also
    // operating the control under the cursor (toggling a checkbox,
    // collapsing a group via the title's own onclick, etc.) -
    // stopPropagation during capture keeps the event from ever reaching
    // the target's own bubble-phase listeners (including inline
    // onclick="..." attributes) at all. A group's own TITLE takes
    // priority over a row match - Shift/armed-clicking a group's title
    // bar selects the WHOLE group (the entire .dev-section, to be moved
    // as one nested unit), not some nearby row.
    function setupDevGroupSelection() {
        devPanel.addEventListener('click', (e) => {
            if (!e.shiftKey && !devGroupSelectionArmed) return;
            const titleEl = e.target.closest('.dev-section-title');
            const target = titleEl ? titleEl.closest('.dev-section') : e.target.closest('.dev-row');
            if (!target) return;
            e.preventDefault();
            e.stopPropagation();
            toggleDevSelection(target);
        }, true);
        // Per the request's own explicit clear condition - only a click
        // OUTSIDE the panel clears the selection; normal clicks/drags
        // inside the panel (adjusting a slider, collapsing a group,
        // switching tabs) leave it alone. Also disarms right-click
        // select-mode, same reasoning.
        document.addEventListener('click', (e) => {
            if (devPanel.contains(e.target)) return;
            if (devPanelSelectedItems.size) clearDevSelection();
            if (devGroupSelectionArmed) disarmDevGroupSelection();
        }, true);
    }
    // Walks UP from one selected element (a .dev-row or a whole selected
    // .dev-section) to every GROUP that contains it, deepest first - never
    // includes the element itself, only real ancestor groups. Relies on
    // the fixed DOM shape every group already has: .dev-section >
    // .dev-section-content > (rows and/or subsections) - so "el's parent
    // is a .dev-section-content" is exactly "el sits directly inside some
    // group", and that content's own parent is the .dev-section that owns
    // it. A top-level item (direct child of tabEl, no containing custom
    // group) naturally produces an empty chain, since tabEl itself is
    // never a .dev-section-content.
    function devSelectionAncestorGroupChain(el) {
        const chain = [];
        let node = el;
        while (node.parentElement && node.parentElement.classList.contains('dev-section-content')) {
            const sec = node.parentElement.parentElement;
            if (!sec || !sec.classList.contains('dev-section')) break;
            chain.push(sec);
            node = sec;
        }
        return chain;
    }
    // The DEEPEST group that contains every one of the given selected
    // elements, or null if they share no common containing group (all
    // top-level, or spanning two subtrees with nothing in common below the
    // tab root). Per direct request (2026-09-20): "the added group should
    // be within the same settings group that the selected settings were
    // in. If selected settings...are within different setting groups,
    // place the new group in the first layer of nest groups that both
    // settings are within" - e.g. selecting something in "# Flashing" and
    // something in "High Score", both nested inside "UI Text", should nest
    // the new group in "UI Text"; selecting two things both already inside
    // "# Flashing" should nest it directly in "# Flashing" instead.
    function findDevSelectionCommonAncestorGroup(elements) {
        if (!elements.length) return null;
        const chains = elements.map(devSelectionAncestorGroupChain);
        const [first, ...rest] = chains;
        for (const candidate of first) {
            if (rest.every(chain => chain.includes(candidate))) return candidate;
        }
        return null;
    }
    function addDevGroup(tab) {
        const tabEl = document.getElementById(tab + 'TabContent');
        const existingNames = new Set(
            Array.from(tabEl.querySelectorAll('.dev-section > .dev-section-title')).map(t => t.dataset.sid)
        );
        let name = 'New Group';
        let n = 2;
        while (existingNames.has(name)) { name = 'New Group (' + n + ')'; n++; }
        const section = createDevGroupElement(name, tab);
        const selectedInTab = Array.from(devPanelSelectedItems).filter(el => tabEl.contains(el));
        // Placement (2026-09-20 rework): when there's a selection, the new
        // group now nests inside the selection's own deepest common
        // containing group (see findDevSelectionCommonAncestorGroup()'s
        // own comment) instead of always landing at the top of the tab's
        // project-specific list. Only the no-selection (or no-common-
        // ancestor, e.g. an all-top-level selection) case falls back to
        // that original top-of-list placement.
        const commonAncestor = selectedInTab.length ? findDevSelectionCommonAncestorGroup(selectedInTab) : null;
        if (commonAncestor) {
            const targetContent = commonAncestor.querySelector(':scope > .dev-section-content');
            targetContent.insertBefore(section, targetContent.firstChild);
        } else {
            // Per direct request ("When I add a new group, place it at the
            // top of the list instead of the bottom") - inserted right after
            // the built-in Dev Panel/Debug groups, which stay first per
            // CLAUDE.md §12i/§12i-1's own mandatory ordering (buttons, then
            // Dev Panel, then Debug, THEN any project-specific groups) - so
            // this is the top of the project-specific group list, not a
            // literal position-0 insert that would push a new custom group
            // above those 2 mandatory ones.
            // Falls back through Debug -> Dev Panel -> position 0, not
            // straight to position 0 the moment Debug isn't found at the top
            // level - a user (or an earlier fold-into-new-group action) can
            // legally nest Debug somewhere else, and jumping straight to
            // position 0 in that case would incorrectly place a new custom
            // group above Dev Panel too (caught live: folding Debug into a
            // new group left a SUBSEQUENT new group landing before Dev
            // Panel, since the old version only ever checked for Debug).
            const debugSection = tabEl.querySelector(':scope > .dev-section > .dev-section-title[data-sid="Debug"]')?.closest('.dev-section');
            const devPanelSection = tabEl.querySelector(':scope > .dev-section > .dev-section-title[data-sid="Dev Panel"]')?.closest('.dev-section');
            const anchorSection = debugSection || devPanelSection;
            if (anchorSection) {
                tabEl.insertBefore(section, anchorSection.nextSibling);
            } else {
                tabEl.insertBefore(section, tabEl.firstChild);
            }
        }
        // Per direct request ("New Feature - when i hold the Shift key...
        // Once selected, when i click Add Group, the selected things
        // will automatically be placed within the new group") - fold any
        // current selection into the group just created, scoped to THIS
        // tab only (a selection lingering from a different tab, if any,
        // is left alone rather than silently vanishing/relocating
        // cross-tab - see setupDevGroupSelection()'s own comment).
        const content = section.querySelector(':scope > .dev-section-content');
        if (selectedInTab.length) {
            selectedInTab.forEach(el => content.appendChild(el));
            clearDevSelection();
            injectRowDragHandles();
        }
        section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Whichever Desktop/Mobile/Landscape tab is currently showing - same
    // expression already used elsewhere in this file (see the scroll-
    // wheel handler below) for "which tab am I actually looking at right
    // now", reused here so the header's own Add Group/Collapse All
    // buttons (single shared controls, not one per tab any more - see
    // their own HTML comment) know which tab to act on.
    function getActiveDevPanelTab() {
        return DEV_PANEL_TABS.find(t => !document.getElementById(t + 'TabContent').classList.contains('hidden')) || 'desktop';
    }
    // "Collapse All" - per direct request. Collapses every group (any
    // nesting depth) in the currently active tab that isn't already
    // collapsed - reuses toggleSection()'s own collapse/expand mechanics
    // directly (not a call to toggleSection() itself, since that also
    // handles Text Edit Mode's click-to-rename branch, irrelevant here).
    function collapseAllDevGroups() {
        const tabEl = document.getElementById(getActiveDevPanelTab() + 'TabContent');
        tabEl.querySelectorAll('.dev-section-title').forEach(titleEl => {
            const content = titleEl.nextElementSibling;
            if (!content || content.classList.contains('collapsed')) return;
            content.classList.add('collapsed');
            withPreservedTitleCheckbox(titleEl, () => {
                titleEl.textContent = '▶ ' + titleEl.textContent.slice(2);
            });
        });
    }
    // Wires the 3 header icon buttons - per direct request ("Text Edit
    // Mode and Add Group are now icon buttons on the Dev Panel Title
    // Label bit. Also provide a 'Collapse All' button there... If i
    // right click the Add Group button, I want to be able to left click
    // mutiple settings or groups to select them, then when i left click
    // or right click Add Group again, all the selected items will be
    // placed within the new group."). Called once from
    // initDevPanelEngine() - always on, same as the D-key listener and
    // setupDevGroupSelection(), regardless of whether the panel's own
    // controls have been lazily built yet.
    function setupDevHeaderIconButtons() {
        const textEditBtn = document.getElementById('devTextEditModeBtn');
        if (textEditBtn) {
            textEditBtn.classList.toggle('active', textEditModeEnabled);
            textEditBtn.addEventListener('click', () => {
                textEditModeEnabled = !textEditModeEnabled;
                textEditBtn.classList.toggle('active', textEditModeEnabled);
            });
        }
        const addGroupBtn = document.getElementById('devAddGroupBtn');
        if (addGroupBtn) {
            // A plain left click: if armed (a right-click already started a
            // selection), this is the "finalize" click - create the group
            // and fold the selection in, same as a right-click would (see
            // below). If NOT armed, it's just the ORIGINAL, unchanged
            // behavior - create an empty group immediately.
            addGroupBtn.addEventListener('click', () => {
                addDevGroup(getActiveDevPanelTab());
                disarmDevGroupSelection();
            });
            // Right click: arms select mode on the FIRST right-click (no
            // group created yet - just starts letting plain left-clicks
            // select). A SECOND right-click, while already armed, finalizes
            // instead - matches the request's own "when i left click or
            // right click Add Group again" wording (either button, once
            // armed, does the same finalize action).
            addGroupBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (devGroupSelectionArmed) {
                    addDevGroup(getActiveDevPanelTab());
                    disarmDevGroupSelection();
                } else {
                    if (typeof devDeleteGroupArmed !== 'undefined' && devDeleteGroupArmed) disarmDevDeleteGroup();
                    devGroupSelectionArmed = true;
                    addGroupBtn.classList.add('armed');
                }
            });
        }
        const collapseAllBtn = document.getElementById('devCollapseAllBtn');
        if (collapseAllBtn) collapseAllBtn.addEventListener('click', collapseAllDevGroups);
        const deleteGroupBtn = document.getElementById('devDeleteGroupBtn');
        if (deleteGroupBtn) {
            // A plain click arms/disarms (toggle) - unlike Add Group,
            // Delete has no OTHER click behavior to stay compatible with,
            // so it doesn't need Add Group's left-vs-right-click
            // distinction. Arming this also disarms Add Group's own
            // selection-arm mode (and vice versa, in that button's own
            // contextmenu handler above) - both being armed at once would
            // make a single group-title click ambiguous between "select
            // it" and "delete it".
            deleteGroupBtn.addEventListener('click', () => {
                if (devDeleteGroupArmed) {
                    disarmDevDeleteGroup();
                } else {
                    disarmDevGroupSelection();
                    devDeleteGroupArmed = true;
                    deleteGroupBtn.classList.add('armed');
                }
            });
        }
    }
    let devDeleteGroupArmed = false;
    function disarmDevDeleteGroup() {
        devDeleteGroupArmed = false;
        const btn = document.getElementById('devDeleteGroupBtn');
        if (btn) btn.classList.remove('armed');
    }
    // Walks target's own .dev-section AND every ancestor .dev-section,
    // refusing deletion if any of them is mandatory standing scaffolding
    // (Dev Panel/Debug - CLAUDE.md Section 12i/12i-1) - ported from
    // Clicko (2026-09-17), which additionally checks a locked-groups Set
    // this template doesn't have (lock-groups is Clicko-only), so this
    // version only has the mandatory-scaffolding half of that check.
    // Checking the WHOLE ancestor chain (not just the immediate parent)
    // means a setting living inside Dev Panel/Debug is refused the same
    // way the group itself already was.
    function findDevDeleteProtectionReason(el) {
        let sec = el.closest('.dev-section');
        while (sec) {
            const titleEl = sec.querySelector(':scope > .dev-section-title');
            if (titleEl) {
                const sid = titleEl.dataset.sid;
                if (sid === 'Dev Panel' || sid === 'Debug') {
                    return 'mandatory standing scaffolding (CLAUDE.md Section 12i/12i-1)';
                }
                if (lockedGroups.has(getSectionKey(titleEl))) {
                    return 'locked ("' + titleEl.textContent.slice(2) + '")';
                }
            }
            sec = sec.parentElement ? sec.parentElement.closest('.dev-section') : null;
        }
        return null;
    }
    // Per direct request ("Add a delete group button next to the add
    // group function. Functionally, I will click it, it highlights like
    // the add group right click, then i will click a group to delete"),
    // extended per direct follow-up ("Delete button should also allow me
    // to delete single settings") - ported from Clicko (2026-09-17). A
    // capturing listener on the panel (same "title takes priority over
    // row" pattern as setupDevGroupSelection()) so it works uniformly for
    // a group (any nesting depth) or an individual setting row;
    // preventDefault/stopPropagation stop the click from also collapsing
    // the group via its own onclick.
    function setupDevDeleteGroup() {
        devPanel.addEventListener('click', (e) => {
            if (!devDeleteGroupArmed) return;
            if (e.target.closest('#devDeleteGroupBtn')) return;
            const titleEl = e.target.closest('.dev-section-title');
            const target = titleEl ? titleEl.closest('.dev-section') : e.target.closest('.dev-row');
            if (!target) return;
            e.preventDefault();
            e.stopPropagation();
            const reason = findDevDeleteProtectionReason(target);
            if (reason) {
                console.warn('Delete: refused - ' + reason);
                disarmDevDeleteGroup();
                return;
            }
            // pushDevDeleteUndoEntry(), not the generic pointerdown-based
            // snapshot push - see that function's own comment for why a
            // plain value snapshot can't actually undo a deletion.
            // parent/nextSibling captured BEFORE remove() so undo can put
            // the node back in its exact original spot.
            const parent = target.parentElement;
            const nextSibling = target.nextElementSibling;
            target.remove();
            pushDevDeleteUndoEntry(target, parent, nextSibling);
            disarmDevDeleteGroup();
        }, true);
        document.addEventListener('click', (e) => {
            if (devPanel.contains(e.target)) return;
            if (devDeleteGroupArmed) disarmDevDeleteGroup();
        }, true);
    }

    // Infinite undo (2026-09-17, ported from Clicko) - per direct request
    // ("Add... an undo button. It will undo any dev panel changes be it
    // reordering, setting input change, renaming, group nesting,
    // anything. And allow me to undo infinitely until the last save
    // click"), later clarified as session-only ("the undo only remembers
    // changes within that browser session. so if i refresh, the undo
    // wont do anything... it rememebrs all changes from that moment,
    // until i click save, then it starts new again").
    //
    // Implementation: a plain in-memory stack of FULL PANEL SNAPSHOTS
    // (captureFullDevPanelState() - the exact same object Copy/Sync/Named
    // Setting States already build) for ordinary value/order/rename
    // changes, PLUS a separate entry kind for deletions specifically -
    // see pushDevDeleteUndoEntry()'s own comment for why a value snapshot
    // alone can't undo a deletion (it can recreate a deleted GROUP only
    // as an empty shell, and has no way to recreate a deleted SETTING's
    // actual control markup at all - confirmed live on Clicko before this
    // port: deleting a group then a setting inside it, Undo brought names
    // back but the actual content stayed gone).
    //
    // WHEN a snapshot gets pushed: not wired into each of the dev panel's
    // dozen+ mutation code paths individually. Instead, ONE capturing
    // 'pointerdown' listener on the whole panel pushes a snapshot the
    // FIRST time the pointer goes down inside it, gated to once per
    // "gesture" (reset on pointerup/pointercancel/window-focus - see
    // resetDevUndoGesture()'s own comment for why 3 separate reset paths
    // are needed) - pointerdown fires before essentially every kind of
    // interaction this panel has, so this single hook captures the
    // pre-action state for all of them without touching their own
    // individual handlers. A multi-tick drag (a slider dragged across
    // many 'input' events, or a reorder dragged across many pointermove
    // events) is correctly captured as ONE undo step, not one per tick,
    // since the gesture gate only pushes on the drag's own initial
    // pointerdown.
    let devUndoStack = [];
    let devUndoGestureActive = false;
    function pushDevPanelUndoSnapshot() {
        // Deep-cloned (JSON round-trip - every field captureFullDevPanelState()
        // returns is already plain JSON-safe data) - REQUIRED, not a
        // defensive extra: that function returns some fields (cssVars-
        // equivalents inside `controls`, devPanelStyle, etc.) by plain
        // reference in places, the SAME live objects later edits mutate
        // in place. Pushing the object literal as-is (caught live on
        // Clicko before this port: a slider dragged from 42.5 to 55, then
        // Undo, "restored" to 55 instead of 42.5) meant every snapshot
        // already on the stack silently changed underneath Undo the
        // moment ANY later edit touched the same underlying state
        // object, since they were never actually 2 separate objects to
        // begin with.
        devUndoStack.push({ kind: 'snapshot', data: JSON.parse(JSON.stringify(captureFullDevPanelState())) });
    }
    // A SEPARATE undo-entry kind, specifically for deleting a group or
    // setting (called from setupDevDeleteGroup()'s own click handler) -
    // NOT just another pushDevPanelUndoSnapshot() call. Captures the
    // REAL, LIVE DOM node being removed (not a clone - a live node keeps
    // its own already-wired event listeners, so no re-wiring is needed on
    // restore) plus exactly where it sat (parent + nextSibling), and puts
    // it straight back on undo - full-fidelity by construction, for a
    // group (with all its own contents, at any nesting depth) or a
    // single setting row alike.
    function pushDevDeleteUndoEntry(node, parent, nextSibling) {
        devUndoStack.push({ kind: 'delete', node, parent, nextSibling });
    }
    function undoDevPanelChange() {
        if (!devUndoStack.length) return;
        const entry = devUndoStack.pop();
        if (entry.kind === 'delete') {
            if (entry.nextSibling && entry.nextSibling.parentNode === entry.parent) {
                entry.parent.insertBefore(entry.node, entry.nextSibling);
            } else {
                entry.parent.appendChild(entry.node);
            }
        } else {
            applyFullDevPanelState(entry.data);
        }
    }
    // How long a "gesture" is allowed to hold the undo-push gate open with
    // no matching pointerup - a real, confirmed bug on Clicko before this
    // port: opening a NATIVE color picker (this panel's own
    // <input type="color"> controls) never delivers a pointerup back to
    // the page at all - the OS-level picker dialog eats it - which
    // permanently stuck devUndoGestureActive at true and silently broke
    // EVERY undo push for the rest of the session after the first color
    // picker use. Generous on purpose - real slider/reorder drags can
    // legitimately run a few seconds; this is a safety net for a
    // genuinely abandoned/swallowed gesture, not a normal timer.
    const DEV_UNDO_GESTURE_TIMEOUT_MS = 2000;
    let devUndoGestureTimer = null;
    function resetDevUndoGesture() {
        devUndoGestureActive = false;
        if (devUndoGestureTimer) { clearTimeout(devUndoGestureTimer); devUndoGestureTimer = null; }
    }
    function setupDevPanelUndo() {
        devPanel.addEventListener('pointerdown', (e) => {
            if (devUndoGestureActive) return;
            // While Delete Group/Setting is armed, the very next click
            // either deletes something (which pushes its own precise
            // pushDevDeleteUndoEntry() instead) or is refused/disarms with
            // no mutation at all - a plain value snapshot here would be a
            // dead, unpoppable-to-any-useful-state entry either way, so
            // skip it.
            if (devDeleteGroupArmed) return;
            // THE root cause of a real, confirmed "Undo does literally
            // nothing" report on Clicko (2026-09-17), ported here as a
            // fix, not just a feature: the Undo button is itself inside
            // devPanel, so clicking it ALSO fires this same capturing
            // pointerdown listener - without this guard, a click on Undo
            // would push a snapshot of the CURRENT (already-changed)
            // state, then its own 'click' handler immediately pops that
            // SAME just-pushed entry, restoring the current state onto
            // itself - a complete no-op that leaves the user's real prior
            // change buried, untouched, one slot deeper on the stack
            // (confirmed live on Clicko: after one real edit + one real
            // Undo click, devUndoStack.length was 1, not the correct 0).
            // Every earlier test of this feature used undoBtn.click() (the
            // JS method) to trigger Undo, which does NOT fire pointerdown/
            // mousedown at all, only 'click' directly - exactly why this
            // never showed up in testing despite extensive verification;
            // only a REAL mouse click (or a synthetic pointerdown+click
            // pair) exposes it.
            if (e.target.closest('#devUndoBtn')) return;
            devUndoGestureActive = true;
            pushDevPanelUndoSnapshot();
            // Belt-and-suspenders reset, on top of the real pointerup/
            // pointercancel/focus listeners below - if NONE of those ever
            // fire for some reason this hasn't been discovered yet, the
            // gate still can't stay stuck forever.
            devUndoGestureTimer = setTimeout(resetDevUndoGesture, DEV_UNDO_GESTURE_TIMEOUT_MS);
        }, true);
        document.addEventListener('pointerup', resetDevUndoGesture, true);
        document.addEventListener('pointercancel', resetDevUndoGesture, true);
        // Catches the native-picker-eats-pointerup case directly - the
        // window reliably regains focus the moment a native color/file/
        // date picker (or any other OS-level dialog) closes, even though
        // the page itself never saw a pointerup for the click that opened
        // it.
        window.addEventListener('focus', resetDevUndoGesture);
        const undoBtn = document.getElementById('devUndoBtn');
        if (undoBtn) undoBtn.addEventListener('click', undoDevPanelChange);
        // Ctrl+Z - standard undo shortcut, matching the D/R single-key
        // shortcuts this panel already has (Hide/Reset). Ignored while
        // focus is in a genuine text-input context (a rename textarea,
        // the search box) so it doesn't fight the browser/OS's own native
        // text-field undo.
        document.addEventListener('keydown', (e) => {
            if (!(e.key === 'z' || e.key === 'Z') || !(e.ctrlKey || e.metaKey)) return;
            const tag = document.activeElement ? document.activeElement.tagName : '';
            if (tag === 'TEXTAREA' || (tag === 'INPUT' && document.activeElement.type === 'text')) return;
            e.preventDefault();
            undoDevPanelChange();
        });
    }
    // Clears the undo stack - called from saveDevPanelSettings() itself
    // (per the request's own explicit "until i click save, then it starts
    // new again"), so a Sync draws a hard line under everything before
    // it; nothing before a Sync is ever undoable after it.
    function clearDevPanelUndoStack() {
        devUndoStack = [];
    }

    // Ctrl+F-style search for group/setting names, ported from
    // DickoClicko's own dpSearchInput mechanism (2026-09-17) and adapted
    // to this template's tab-scoped .dev-section-title/.dev-row DOM shape
    // (DickoClicko has a single flat group tree, no Desktop/Mobile/
    // Landscape tab split, so its own .dp-group/.dp-row selectors don't
    // apply directly here - the underlying navigate/highlight/expand
    // logic is the same, just re-scoped to whichever tab is currently
    // active via getActiveDevPanelTab()). Deliberately does NOT highlight
    // every match at once - per DickoClicko's own direct correction ("dont
    // do the expanding and scroll thing if i havent hit enter yet"):
    // typing only recomputes devSearchMatches and shows a plain "N found"
    // count; only Enter (first press jumps to match 0) or Shift+Enter
    // (previous, wrapping) actually navigates - and navigating to a NEW
    // match first UNDOES whatever the PREVIOUS match's own navigation did
    // (un-highlight, re-collapse whatever this mechanism itself had to
    // expand), so only ONE match is ever expanded/highlighted at a time.
    let devSearchMatches = [];
    let devSearchActiveIndex = -1;
    let devSearchActiveEl = null;
    let devSearchExpandedGroups = [];

    function collectDevSearchMatches(query) {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const tabEl = document.getElementById(getActiveDevPanelTab() + 'TabContent');
        if (!tabEl) return [];
        const matches = [];
        // A single combined selector (not 2 separate querySelectorAll
        // calls) so matches come back in real document order for free.
        tabEl.querySelectorAll('.dev-section-title, .dev-row').forEach(node => {
            if (node.classList.contains('dev-section-title')) {
                // textContent always starts with a "\u25bc " or "\u25b6 " collapse-arrow
                // prefix (toggleSection()'s own convention) - stripped before
                // matching so a search for "dev" doesn't need the arrow glyph.
                const text = node.textContent.slice(2).toLowerCase();
                if (text.includes(q)) matches.push({ type: 'group', targetEl: node, sectionEl: node.closest('.dev-section') });
            } else {
                const label = node.querySelector(':scope > .dev-label');
                if (label && label.textContent.toLowerCase().includes(q)) {
                    matches.push({ type: 'row', targetEl: label, rowEl: node });
                }
            }
        });
        return matches;
    }

    function devSearchCollapseExpanded() {
        devSearchExpandedGroups.forEach(sec => {
            const titleEl = sec.querySelector(':scope > .dev-section-title');
            const content = sec.querySelector(':scope > .dev-section-content');
            if (content) content.classList.add('collapsed');
            if (titleEl) titleEl.textContent = '\u25b6 ' + titleEl.textContent.slice(2);
        });
        devSearchExpandedGroups = [];
    }
    function devSearchClearActiveHighlight() {
        if (devSearchActiveEl) devSearchActiveEl.classList.remove('dev-search-highlight-active');
        devSearchActiveEl = null;
    }
    // Undoes whatever the CURRENT match's own navigation did - always call
    // this before moving to a different match (or abandoning the search).
    function devSearchUndoCurrentMatch() {
        devSearchClearActiveHighlight();
        devSearchCollapseExpanded();
    }
    // startEl is the whole matched element (a .dev-section for a group
    // match, a .dev-row for a row match) so walking up from its OWN parent
    // correctly skips the matched group itself and only expands genuine
    // ANCESTORS - a group's own title is always visible regardless of its
    // own collapsed state, only its content needs expanding.
    function devSearchExpandAncestors(startEl) {
        let sec = startEl.parentElement ? startEl.parentElement.closest('.dev-section') : null;
        while (sec) {
            const titleEl = sec.querySelector(':scope > .dev-section-title');
            const content = sec.querySelector(':scope > .dev-section-content');
            if (content && content.classList.contains('collapsed')) {
                content.classList.remove('collapsed');
                if (titleEl) titleEl.textContent = '\u25bc ' + titleEl.textContent.slice(2);
                devSearchExpandedGroups.push(sec);
            }
            sec = sec.parentElement ? sec.parentElement.closest('.dev-section') : null;
        }
    }
    function devSearchUpdateCount() {
        const countEl = document.getElementById('devSearchCount');
        if (!countEl) return;
        const total = devSearchMatches.length;
        const input = document.getElementById('devSearchInput');
        if (!input || !input.value.trim()) countEl.textContent = '';
        else if (!total) countEl.textContent = '0 found';
        else if (devSearchActiveIndex === -1) countEl.textContent = total + ' found';
        else countEl.textContent = (devSearchActiveIndex + 1) + '/' + total;
    }
    function devSearchGoTo(index) {
        if (!devSearchMatches.length) return;
        devSearchUndoCurrentMatch();
        const n = devSearchMatches.length;
        devSearchActiveIndex = ((index % n) + n) % n;
        const m = devSearchMatches[devSearchActiveIndex];
        devSearchExpandAncestors(m.type === 'row' ? m.rowEl : m.sectionEl);
        m.targetEl.classList.add('dev-search-highlight-active');
        devSearchActiveEl = m.targetEl;
        m.targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        devSearchUpdateCount();
    }
    function setupDevSearch() {
        const input = document.getElementById('devSearchInput');
        if (!input) return;
        input.addEventListener('input', () => {
            devSearchUndoCurrentMatch();
            devSearchActiveIndex = -1;
            devSearchMatches = collectDevSearchMatches(input.value);
            devSearchUpdateCount();
        });
        input.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (e.shiftKey) devSearchGoTo(devSearchActiveIndex - 1);
            else devSearchGoTo(devSearchActiveIndex + 1);
        });
        // Any click that isn't on the search input itself undoes the current
        // match's own highlight/expansion - same "click elsewhere clears it"
        // convention setupDevGroupSelection() already uses.
        document.addEventListener('click', e => {
            if (e.target === input) return;
            if (devSearchActiveIndex === -1) return;
            devSearchUndoCurrentMatch();
            devSearchActiveIndex = -1;
            devSearchUpdateCount();
        }, true);
    }

    // ================================================================
    // [JS-3] DRAG-TO-REORDER ENGINE
    // ================================================================
    // Generic pointer-based drag-to-reorder (groups AND settings use
    // this same function, with different selectors — see the 2 call
    // sites near the bottom of this script). Pointer events (not native
    // HTML5 draggable=true) for real touch support. A live "swap on
    // crossing" reorder — once past a small movement threshold, the
    // dragged item moves in the DOM whenever the pointer crosses a
    // sibling's midpoint.
    //   handleSelector: what starts a drag (e.g. '.dev-section-title')
    //     — deliberately NOT the item's own interactive control, so
    //     dragging a slider/checkbox/input still works normally.
    //   itemSelector: the element that actually moves (may differ from
    //     the handle — a group's handle is its title, but the whole
    //     .dev-section reorders).
    //   onDrop: called once after a real drag completes, to persist the
    //     new order.
    //   crossContainerSelector: omit for a single-container drag (e.g.
    //     groups, which never leave their tab). Pass a CSS selector (or
    //     a function(tabRoot, dragging) => [elements], when you need to
    //     include tabRoot itself as a valid drop target — querySelectorAll
    //     can never return its own context node) to let a dragged item
    //     cross into a DIFFERENT sibling container.
    // ----------------------------------------------------------------
    // Used for the SIBLING-POSITION comparison inside setupDragReorder()
    // (not for `itemSelector`, which stays per-call and decides what the
    // drag HANDLE actually picks up) - 2026-09-19, direct request that a
    // dragged group or row be positionable relative to BOTH types, not
    // just its own kind, so a group can land above/below/between settings
    // and vice versa with no forced ordering either way. Before this, the
    // 2 setupDragReorder() calls below (one for '.dev-section', one for
    // '.dev-row') each only ever compared position against same-type
    // siblings, since the sibling query used the call's own itemSelector -
    // meaning a dragged group could never be interleaved with rows, and a
    // dragged row could never be interleaved with groups.
    const REORDERABLE_SIBLING_SELECTOR = ':scope > .dev-section, :scope > .dev-row';
    let sectionJustDragged = false;
    function setupDragReorder(handleSelector, itemSelector, onDrop, crossContainerSelector) {
        let dragging = null;
        let startY = 0;
        let moved = false;
        // BUG (found live on Clicko, direct report: "when i clcik and drag
        // the icon, it doesnt register. Instead my cursor becomes tot he
        // NA Icon... the dragging doesnt work" - intermittent, retrying
        // sometimes works). Unlike every other custom pointer-drag in this
        // file (the panel's own resize handles, its move-by-header drag),
        // this one never called setPointerCapture() on the handle. The
        // handle is only 22px with touch-action:none - without capture, a
        // fast pointer move can carry the cursor outside that tiny hit
        // area before the next pointermove tick, and the browser
        // re-evaluates touch-action against whatever's now underneath -
        // exactly the ambiguous state Chromium/the OS shows the native
        // "not-allowed" cursor for, silently dropping the gesture.
        // Capturing the pointer on the handle itself routes every
        // subsequent event for this pointerId to it regardless of where
        // the cursor travels, removing the ambiguity entirely.
        let capturedHandle = null;
        const THRESHOLD = 8;

        // Touch needs a hold-to-arm gate that mouse doesn't: the handles
        // are deliberately NOT touch-action:none (so a normal swipe still
        // scrolls the panel), which means a touch drag can't be
        // recognized by movement alone. A touch only commits to drag
        // mode after being held still past TOUCH_HOLD_MS; real movement
        // before that cancels the hold and falls through to native
        // scroll. Mouse/pen keep the original immediate, movement-
        // threshold-based behavior — touch-action never governs them.
        const TOUCH_HOLD_MS = 1000;
        const TOUCH_HOLD_MOVE_TOLERANCE = 10;
        let pendingTouch = null;

        function cancelPendingTouch() {
            if (pendingTouch) { clearTimeout(pendingTouch.timerId); pendingTouch = null; }
        }

        document.addEventListener('pointerdown', (e) => {
            const handle = e.target.closest(handleSelector);
            if (!handle) return;
            const item = handle.closest(itemSelector);
            if (!item) return;
            // Refuses to even START a drag on a .dev-row whose own group is
            // locked (ported from Clicko - see lockedGroups' own comment).
            // Never gates a .dev-section (group) itself, only a .dev-row
            // (setting) - a locked group can still be dragged/reordered/
            // nested as a whole, only its own contents are frozen.
            if (item.matches('.dev-row')) {
                const ownSection = item.closest('.dev-section');
                const ownTitle = ownSection && ownSection.querySelector(':scope > .dev-section-title');
                if (ownTitle && lockedGroups.has(getSectionKey(ownTitle))) return;
            }

            // See capturedHandle's own top-of-function comment - routes
            // every subsequent pointer event for this pointerId to the
            // handle regardless of where the cursor travels, same
            // try/catch-wrapped best-effort convention as every other
            // setPointerCapture() call in this file.
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* best-effort only */ }
            capturedHandle = handle;

            if (e.pointerType === 'touch') {
                const startX0 = e.clientX, startY0 = e.clientY, pointerId = e.pointerId;
                cancelPendingTouch();
                pendingTouch = {
                    item, startX: startX0, startY: startY0, pointerId,
                    timerId: setTimeout(() => {
                        if (!pendingTouch || pendingTouch.pointerId !== pointerId) return;
                        pendingTouch = null;
                        dragging = item;
                        startY = startY0;
                        moved = true;
                        dragging.classList.add('dev-reorder-dragging');
                    }, TOUCH_HOLD_MS),
                };
                return;
            }

            dragging = item;
            startY = e.clientY;
            moved = false;
        });

        document.addEventListener('pointermove', (e) => {
            if (pendingTouch && e.pointerId === pendingTouch.pointerId) {
                const dist = Math.hypot(e.clientX - pendingTouch.startX, e.clientY - pendingTouch.startY);
                if (dist > TOUCH_HOLD_MOVE_TOLERANCE) cancelPendingTouch();
                return;
            }
            if (!dragging) return;
            if (!moved && Math.abs(e.clientY - startY) > THRESHOLD) {
                moved = true;
                dragging.classList.add('dev-reorder-dragging');
            }
            if (!moved) return;
            e.preventDefault();
            if (crossContainerSelector) {
                const tabRoot = dragging.closest(DEV_PANEL_TABS.map(t => '#' + t + 'TabContent').join(', '));
                const containers = typeof crossContainerSelector === 'function'
                    ? crossContainerSelector(tabRoot, dragging)
                    : Array.from(tabRoot.querySelectorAll(crossContainerSelector));
                // A candidate container is normally a .dev-section-content
                // div, but a COLLAPSED group's content is display:none -
                // getBoundingClientRect() on it returns an all-zero rect, so
                // every collapsed group's content ties at the same
                // degenerate {top:0,bottom:0,height:0}. Groups default to
                // collapsed, so this is the common case, not an edge case -
                // it silently breaks both the "pointer is over this
                // container" check and the "nearest by center" fallback
                // below (real incident: Clicko's own deployed panel hit this
                // exact bug - "cant seem to reorder or modify group
                // nesting" - confirmed live: cross-group drop worked the
                // instant the target was pre-expanded, and broke again the
                // moment it was collapsed). Fixed with a hit-test rect that
                // falls back to the group's own TITLE BAR (always rendered,
                // never zero-size) whenever its content is collapsed - also
                // the correct visual target, since that's the only part of
                // a collapsed group a user can actually see and aim at.
                function hitTestRect(c) {
                    const r = c.getBoundingClientRect();
                    if (r.height > 0) return r;
                    const titleEl = c.previousElementSibling;
                    return (titleEl && titleEl.classList.contains('dev-section-title')) ? titleEl.getBoundingClientRect() : r;
                }
                let targetContainer = containers.find(c => {
                    const r = hitTestRect(c);
                    return e.clientY >= r.top && e.clientY <= r.bottom;
                });
                if (!targetContainer) {
                    let minDist = Infinity;
                    containers.forEach(c => {
                        const r = hitTestRect(c);
                        const dist = Math.abs(e.clientY - (r.top + r.height / 2));
                        if (dist < minDist) { minDist = dist; targetContainer = c; }
                    });
                }
                if (!targetContainer) return;
                // Combined selector (not the per-call itemSelector alone) -
                // 2026-09-19, per direct request that a dragged group or
                // row should be positionable relative to EITHER type, not
                // just its own ("no prioritization in terms of settings
                // area lways above groups or anyting liek that"). See
                // REORDERABLE_SIBLING_SELECTOR's own comment.
                const targetSiblings = Array.from(targetContainer.querySelectorAll(REORDERABLE_SIBLING_SELECTOR)).filter(el => el !== dragging);
                const before = targetSiblings.find(sib => e.clientY < sib.getBoundingClientRect().top + sib.getBoundingClientRect().height / 2);
                if (before) targetContainer.insertBefore(dragging, before);
                else targetContainer.appendChild(dragging);
                return;
            }
            const siblings = Array.from(dragging.parentElement.querySelectorAll(REORDERABLE_SIBLING_SELECTOR)).filter(el => el !== dragging);
            for (const sib of siblings) {
                const rect = sib.getBoundingClientRect();
                const mid = rect.top + rect.height / 2;
                const draggingIsBefore = !!(dragging.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING);
                if (e.clientY < mid && !draggingIsBefore) { sib.parentElement.insertBefore(dragging, sib); break; }
                else if (e.clientY >= mid && draggingIsBefore) { sib.parentElement.insertBefore(dragging, sib.nextSibling); break; }
            }
        }, { passive: false });

        // Releases the pointer capture taken in pointerdown above - BEFORE
        // the `if (!dragging) return` early exit, since capture is taken on
        // EVERY handle pointerdown (including a touch still pending its
        // hold-to-arm timer, where dragging is still null) and has to be
        // released even when a drag never actually started, or it stays
        // stuck captured on the handle for the rest of that pointerId's
        // lifetime.
        function releaseCapturedHandle(e) {
            if (!capturedHandle) return;
            try { if (capturedHandle.hasPointerCapture(e.pointerId)) capturedHandle.releasePointerCapture(e.pointerId); } catch (err) { /* best-effort only */ }
            capturedHandle = null;
        }
        document.addEventListener('pointerup', (e) => {
            if (pendingTouch && e.pointerId === pendingTouch.pointerId) cancelPendingTouch();
            releaseCapturedHandle(e);
            if (!dragging) return;
            dragging.classList.remove('dev-reorder-dragging');
            if (moved) { sectionJustDragged = true; if (onDrop) onDrop(); }
            dragging = null;
            moved = false;
        });
        document.addEventListener('pointercancel', (e) => {
            if (pendingTouch && e.pointerId === pendingTouch.pointerId) cancelPendingTouch();
            releaseCapturedHandle(e);
            if (!dragging) return;
            dragging.classList.remove('dev-reorder-dragging');
            dragging = null;
            moved = false;
        });
    }

    // ================================================================
    // [JS-4] GROUP/SETTING ORDER & COLLAPSE-STATE PERSISTENCE
    // ================================================================
    // Group/setting order + collapse-state persistence. Stable identity
    // (not DOM position) for both a group (tab + its data-sid, frozen
    // at creation) and a setting row (the id of whatever control it
    // contains) — position would silently point at the wrong thing
    // after any reorder.
    // ----------------------------------------------------------------
    function getSectionKey(titleEl) {
        const tab = DEV_PANEL_TABS.find(t => titleEl.closest('#' + t + 'TabContent')) || DEV_PANEL_TABS[0];
        return tab + ':' + (titleEl.dataset.sid || titleEl.textContent.replace(/^[▼▶]\s*/, ''));
    }
    function captureSectionCollapseState() {
        const state = {};
        document.querySelectorAll('.dev-section-title').forEach(titleEl => {
            state[getSectionKey(titleEl)] = titleEl.nextElementSibling.classList.contains('collapsed');
        });
        return state;
    }
    function applySectionCollapseState(state) {
        if (!state) return;
        document.querySelectorAll('.dev-section-title').forEach(titleEl => {
            const key = getSectionKey(titleEl);
            if (!(key in state)) return;
            const shouldCollapse = !!state[key];
            const content = titleEl.nextElementSibling;
            if (content.classList.contains('collapsed') !== shouldCollapse) {
                content.classList.toggle('collapsed');
                withPreservedTitleCheckbox(titleEl, () => {
                    titleEl.textContent = content.classList.contains('collapsed') ? '▶ ' + titleEl.textContent.slice(2) : '▼ ' + titleEl.textContent.slice(2);
                });
            }
        });
    }
    function getRowKey(row, fallbackIndex) {
        const idEl = row.querySelector('[id]');
        return idEl ? idEl.id : ('__row' + fallbackIndex);
    }
    // Captures one group's own direct rowKeys, plus (genuinely UNLIMITED
    // depth, via recursion -- verified 2026-09-14 with a direct 3-level
    // capture/destroy/restore round-trip) any subgroups it directly
    // contains. All queries :scope-scoped (direct children only, at
    // whichever level the current recursive call is examining) — a plain
    // descendant selector would also match a NESTED subgroup's own rows,
    // double-counting them. Corrected 2026-09-14: an earlier version of
    // this comment claimed "one level deep only," which was already wrong
    // by the time it was read back -- the recursive call below
    // (`captureSection(sub)`) naturally walks to any depth; only the
    // COMMENT was stale, not the code.
    // items: a SINGLE ordered list, interleaving rows and subgroups in
    // real DOM order (2026-09-19) - replaces the old separate rowKeys/
    // subgroups arrays, which could only ever express "all rows, then all
    // subgroups" (or vice versa on restore), never an actual interleaved
    // order. Direct request: "I want to be able to reorder nested groups
    // and settings such that Nested groups can be placed above settings.
    // there should be no prioritization in terms of settings area lways
    // above groups or anyting liek that." rowKeys/subgroups are still
    // populated alongside items (derived from it, not a 2nd source of
    // truth) purely so anything outside this function that still reads
    // them directly (there is none in this file as of this change, but
    // keeping them cheap insurance against a future reader assuming the
    // old shape) sees a sane, consistent value.
    function captureSection(sec) {
        const titleEl = sec.querySelector(':scope > .dev-section-title');
        const content = sec.querySelector(':scope > .dev-section-content');
        const items = Array.from(content.querySelectorAll(':scope > .dev-row, :scope > .dev-section')).map((el, i) => {
            return el.classList.contains('dev-row')
                ? { type: 'row', key: getRowKey(el, i) }
                : { type: 'group', section: captureSection(el) };
        });
        return {
            key: getSectionKey(titleEl),
            items,
            rowKeys: items.filter(it => it.type === 'row').map(it => it.key),
            subgroups: items.filter(it => it.type === 'group').map(it => it.section),
        };
    }
    function captureSectionOrder() {
        const result = {};
        DEV_PANEL_TABS.forEach(tab => {
            const tabId = tab + 'TabContent';
            const tabEl = document.getElementById(tabId);
            if (!tabEl) return;
            const sections = Array.from(tabEl.querySelectorAll(':scope > .dev-section'));
            result[tabId] = sections.map(sec => captureSection(sec));
        });
        return result;
    }
    function applySectionOrder(order) {
        if (!order) return;
        DEV_PANEL_TABS.forEach(tab => {
            const tabId = tab + 'TabContent';
            const tabEl = document.getElementById(tabId);
            const savedSections = order[tabId];
            if (!tabEl || !savedSections) return;
            const sectionsByKey = {};
            tabEl.querySelectorAll('.dev-section').forEach(sec => {
                sectionsByKey[getSectionKey(sec.querySelector(':scope > .dev-section-title'))] = sec;
            });
            // Widened from '.dev-section-content > .dev-row' to plain
            // '.dev-row' (real bug found live in Clicko - "the ordering
            // and grouping and nesting of the Preview text boxes etc arent
            // being reflected, even in desktop mode"): a row with NO
            // .dev-section-content ancestor at all (a loose row sitting
            // directly under tabEl - a project's own equivalent of
            // Clicko's ~10 loose top-level checkboxes) was captured fine
            // by captureSectionOrder() the moment it was dragged into a
            // group, but could never be FOUND here to restore it there on
            // the next Reset/reload - it silently stayed loose forever.
            // Safe to widen: a row's real identity is its own key
            // (getRowKey), not its current parent.
            const rowsByKey = {};
            tabEl.querySelectorAll('.dev-row').forEach((row, i) => {
                rowsByKey[getRowKey(row, i)] = row;
            });
            // Places one saved group (and, at UNLIMITED depth, its own
            // subgroups) into parentContainer — either tabEl itself
            // (top-level) or another group's own .dev-section-content
            // (nested). Recursive with no depth cap -- verified 2026-09-14
            // with a direct 3-level round-trip; the earlier "only ever
            // called 2 deep" claim here was stale documentation, not an
            // actual limit in the code (`placeSection(sub, content)` below
            // recurses exactly as deep as the saved data goes).
            function placeSection(savedSec, parentContainer) {
                let sec = sectionsByKey[savedSec.key];
                if (!sec) {
                    // Not a mistake — this is how a CUSTOM group (see
                    // addDevGroup()) survives a reload: it doesn't exist
                    // in the static HTML at all, only in saved order.
                    const name = savedSec.key.split('>').pop().replace(new RegExp('^(' + DEV_PANEL_TABS.join('|') + '):'), '');
                    sec = createDevGroupElement(name, tab);
                    sectionsByKey[savedSec.key] = sec;
                }
                parentContainer.appendChild(sec);
                const content = sec.querySelector(':scope > .dev-section-content');
                // Interleaved order (savedSec.items, see captureSection()'s
                // own comment) - falls back to the OLD "all rows, then all
                // subgroups" shape for a save made before this change, so
                // an existing saved settings.json still loads correctly
                // (just without any interleaving it never had to begin
                // with) instead of erroring or silently dropping content.
                if (savedSec.items) {
                    savedSec.items.forEach(item => {
                        if (item.type === 'row') {
                            const row = rowsByKey[item.key];
                            if (row) content.appendChild(row);
                        } else {
                            placeSection(item.section, content);
                        }
                    });
                } else {
                    (savedSec.rowKeys || []).forEach(rowKey => {
                        const row = rowsByKey[rowKey];
                        if (row) content.appendChild(row);
                    });
                    (savedSec.subgroups || []).forEach(sub => placeSection(sub, content));
                }
            }
            savedSections.forEach(savedSec => placeSection(savedSec, tabEl));
        });
    }

    // ================================================================
    // [JS-4b0] DYNAMIC MOBILE/LANDSCAPE VISIBILITY + INDEPENDENCE
    // ================================================================
    // Per direct request (2026-09-13): every Desktop row/group gets a
    // "Show in Mobile/Landscape" checkbox; every Mobile/Landscape
    // row/group gets an "Independent from Desktop" checkbox. DEFAULT
    // state is CATEGORY-AWARE (hasStaticDeviceCounterpart(), below),
    // not a flat ON/OFF - a control that already has a real, separately-
    // registered per-tab entry defaults to visible+independent (its
    // exact pre-existing behavior preserved); a control that never had
    // one defaults to hidden/mirrors-Desktop (also its exact pre-
    // existing behavior preserved, since it never had a Mobile/
    // Landscape presence at all before this feature). Unchecking
    // Desktop's own checkbox for a setting removes it from Mobile/
    // Landscape ENTIRELY (no DOM row there at all) - "if nothing is
    // checked, Mobile/Landscape will look empty and just use Desktop
    // settings" - but per explicit follow-up clarification, hiding/un-
    // independent-izing NEVER discards that tab's own last-tuned value:
    // it's kept in devDeviceValues below, restored the moment
    // visibility/independence is turned back on.
    //
    // Modeled on the DICKOCLICKO project's own just-shipped "Independent
    // from Desktop" feature (per direct request to look at it) -
    // REUSES its 2 key design decisions directly: (1) a group's own
    // checkbox has NO persisted state of its own - it's a pure
    // cascading UI convenience that reads/writes every CURRENT child's
    // own real flag, walking the live DOM at the moment of the click
    // (correct for a custom "+ Add Group" group and drag-reordered rows
    // alike, and works for a real non-dev visitor with no dev-panel DOM
    // at all, since nothing about value RESOLUTION depends on group
    // membership - only on each row's own flag); (2) editing a non-
    // independent Mobile/Landscape control is understood as editing the
    // Desktop value it's currently just mirroring, not a no-op.
    //
    // ONE genuine divergence from DICKOCLICKO's own version, not a
    // simplification: DICKOCLICKO keeps a single active settings object
    // swapped on tab-click; this template (like the real project this
    // engine was built from) keeps Desktop/Mobile/Landscape's controls
    // ALL simultaneously live/interactive regardless of which tab is
    // showing (switchDevPanelTab() doesn't touch cssVars-equivalent
    // state, only visibility) - so a non-independent row's value isn't
    // resolved once on tab-switch, it's LIVE-MIRRORED: applyDesktopMirror()
    // below re-pushes Desktop's current value into every non-independent
    // Mobile/Landscape counterpart the instant Desktop changes, not just
    // when that tab is next opened.
    //
    // SCOPE (this pass): covers the 4 uniform row types (slider/color/
    // select/checkbox) via buildUniformControlRow() - NOT buildTextInputRow()
    // (a project's own text/number inputs), a known, deliberately
    // untouched gap to keep this pass bounded; add the same checkbox-
    // append call there yourself if a project needs it.
    //
    // UNIVERSAL as of 2026-09-17 (ported from a real project, CLICKO,
    // that made this exact change): every control registered under
    // `tab: 'desktop'` gets this whole feature automatically (checkbox,
    // dynamic Mobile/Landscape row creation, live mirroring) - no opt-in
    // flag needed any more. This is SAFE for a control already authored
    // the OLD way (3 SEPARATE, independently-tuned per-tab array
    // entries, still fully supported) specifically BECAUSE the checkbox's
    // own default state is category-aware, not because the checkbox
    // itself is now optional: hasStaticDeviceCounterpart() (below)
    // checks whether a real per-tab entry already exists, so such a
    // control's independence checkbox defaults CHECKED (independent),
    // never silently overwriting its already-tuned value on a mirror-
    // sync the way a flat default-unchecked would have. A NEW control
    // that only ever registers a single Desktop entry needs nothing
    // extra - the old `dynamicDevice: true` flag is no longer read or
    // required anywhere (harmless if still present on an older control).
    //
    // Keyed by the DESKTOP row's own id (e.g. sliderButtonDiameter) for
    // rows, or by the Desktop group's own data-sid for groups - never a
    // Mobile/Landscape-prefixed id, since these maps ARE the source of
    // truth for whether/how a Mobile/Landscape counterpart exists.
    let devVisibility = {}; // { [desktopId]: boolean } - default true (visible) when absent
    let devIndependence = { mobile: {}, landscape: {} }; // { [desktopId]: boolean } - default false (mirrors Desktop) when absent
    let devDeviceValues = { mobile: {}, landscape: {} }; // { [desktopId]: lastIndependentValue } - retained even while hidden/non-independent

    // Whether a REAL, separately-registered per-device control already
    // exists for a Desktop control on a given tab (an old-style control,
    // authored with its own independently-tuned Mobile/Landscape array
    // entry, before this feature existed) - drives the checkbox DEFAULT
    // state below when no explicit devVisibility/devIndependence entry
    // exists yet, so applying this system UNIVERSALLY (every control,
    // not just ones explicitly opted in) never silently changes any
    // existing project's behavior: a control that already had its own
    // real per-tab entry defaults to visible+independent (exactly its
    // pre-existing behavior); a control that never had one defaults to
    // hidden/mirrors-desktop (also exactly its pre-existing behavior,
    // since it had no Mobile/Landscape presence at all before). Ported
    // from a real project (CLICKO) that needed the identical category-
    // aware default to go from opt-in to universal without migrating any
    // of its ~250 existing control definitions.
    function hasStaticDeviceCounterpart(desktopId, tab) {
        const devicePrefix = tab === 'landscape' ? 'Landscape' : 'Mobile';
        const targetId = desktopId.replace(/^(slider|color|select|checkbox)/, '$1' + devicePrefix);
        if (findRegisteredControlById(targetId)) return true;
        // Fallback for a control OUTSIDE the registerDevControlArray()
        // system entirely - a hand-authored row a project added directly
        // (not via the registration API), same as this engine's own
        // skipDeviceCheckbox-excluded chrome controls but for a REAL
        // project control instead. A real DOM element already existing at
        // this id means a real per-device value genuinely exists for it.
        // Ported from CLICKO, which found this exact gap live: a group
        // uncheck correctly hid its array-driven children but left several
        // hand-authored ones behind, un-hidden, because they were never in
        // any registered array at all. Safe for the array-driven system's
        // OWN self-referential construction timing (a control's own row,
        // mid-construction, isn't in the DOM yet at the moment this runs
        // for it) because the registration check above already returns
        // true for those first - this fallback is only ever reached for a
        // control the registration system doesn't cover, and a hand-
        // authored static row is present in the DOM from initial page
        // parse, well before any render call runs.
        return !!document.getElementById(targetId);
    }
    function isDevRowVisible(desktopId) {
        if (devVisibility[desktopId] !== undefined) return devVisibility[desktopId];
        return hasStaticDeviceCounterpart(desktopId, 'mobile') || hasStaticDeviceCounterpart(desktopId, 'landscape');
    }
    function isDevRowIndependent(tab, desktopId) {
        if (devIndependence[tab] && devIndependence[tab][desktopId] !== undefined) return devIndependence[tab][desktopId];
        return hasStaticDeviceCounterpart(desktopId, tab);
    }

    // Shows/hides an existing Mobile/Landscape row per its own
    // devVisibility flag, for a control OUTSIDE the registerDevControlArray()
    // system - ensureDynamicTargetRow() (below) early-returns without ever
    // checking visibility when findRegisteredControlById(desktopId) finds
    // nothing (its own `if (!desktopCtrl) return existingId || null;`
    // guard), so a hand-authored control's row would never actually hide
    // even with a correctly-unchecked checkbox. Uses a CSS class, not DOM
    // removal, since these rows are static HTML that always exists - there
    // is nothing to "recreate". No-op for a REGISTERED control (already
    // correctly handled by ensureDynamicTargetRow/syncTabOrderToDesktop),
    // so the 2 mechanisms never fight over the same row.
    function syncStaticRowVisibility(desktopId) {
        if (findRegisteredControlById(desktopId)) return;
        const visible = isDevRowVisible(desktopId);
        ['mobile', 'landscape'].forEach(tab => {
            const devicePrefix = tab === 'landscape' ? 'Landscape' : 'Mobile';
            const targetId = desktopId.replace(/^(slider|color|select|checkbox)/, '$1' + devicePrefix);
            const el = document.getElementById(targetId);
            const row = el ? el.closest('.dev-row') : null;
            if (!row) return;
            row.classList.toggle('dev-row-hidden-by-checkbox', !visible);
        });
    }
    // Backfills both checkbox kinds onto any .dev-row lacking one, across
    // all 3 tabs - covers a hand-authored control a project added directly
    // rather than through registerDevControlArray() (this engine's own
    // built-in chrome controls are excluded via the skipDeviceCheckbox/
    // data-skip-device-checkbox marker - see buildUniformControlRow()'s own
    // comment). Idempotent - skips a row that already has its checkbox -
    // safe to call repeatedly; only ever needs to run once in practice for
    // a static row, since it's never removed/recreated. Also applies each
    // newly-covered row's own current visibility default immediately.
    // Ported from CLICKO's own identical fix.
    function injectRowDeviceCheckboxes() {
        document.querySelectorAll('#desktopTabContent .dev-row').forEach(row => {
            if (row.querySelector('.dev-visibility-checkbox') || row.dataset.skipDeviceCheckbox) return;
            const controlEl = row.querySelector('[id]');
            if (!controlEl) return;
            row.appendChild(buildVisibilityCheckbox(controlEl, controlEl.id));
        });
        ['mobile', 'landscape'].forEach(tab => {
            document.querySelectorAll('#' + tab + 'TabContent .dev-row').forEach(row => {
                if (row.querySelector('.dev-independence-checkbox') || row.dataset.skipDeviceCheckbox) return;
                const controlEl = row.querySelector('[id]');
                if (!controlEl) return;
                const { desktopId } = resolveDevControlId(controlEl.id);
                row.appendChild(buildIndependenceCheckbox(tab, desktopId, controlEl));
            });
        });
        document.querySelectorAll('#desktopTabContent .dev-row [id]').forEach(controlEl => {
            syncStaticRowVisibility(controlEl.id);
        });
    }

    // Auto-hides an ENTIRE Mobile/Landscape group (any nesting depth) the
    // instant none of its own rows or subgroups are visible any more -
    // matching DickoClicko's own refreshVisibilityUI() (its groupEl.style.display
    // driven by "does the group body have any non-hidden child" check).
    // Ported from CLICKO, which found this exact bug live (unchecking a
    // whole group correctly hid its real rows but left the empty group
    // shell, and empty nested subgroups, visible). Depth-sorted deepest-
    // first (same technique as refreshAllGroupCascadeCheckboxes()) so a
    // parent's own "any visible child" check always sees its children's
    // ALREADY-current hidden state. A row hidden via DOM removal (the
    // registered-control dynamic system) is automatically excluded just by
    // not existing in the query; a row hidden via .dev-row-hidden-by-checkbox
    // (the non-registered/static-row system) is excluded via the :not()
    // below - both hide mechanisms are correctly accounted for.
    function refreshEmptyGroupVisibility(tab) {
        const tabEl = document.getElementById(tab + 'TabContent');
        if (!tabEl) return;
        function depth(el) {
            let d = 0, cur = el.parentElement;
            while (cur) { if (cur.classList.contains('dev-section')) d++; cur = cur.parentElement; }
            return d;
        }
        const sections = Array.from(tabEl.querySelectorAll('.dev-section')).sort((a, b) => depth(b) - depth(a));
        sections.forEach(sec => {
            const content = sec.querySelector(':scope > .dev-section-content');
            if (!content) return;
            const hasVisibleRow = !!content.querySelector(':scope > .dev-row:not(.dev-row-hidden-by-checkbox)');
            const hasVisibleSubgroup = !!content.querySelector(':scope > .dev-section:not(.dev-section-hidden-empty)');
            sec.classList.toggle('dev-section-hidden-empty', !hasVisibleRow && !hasVisibleSubgroup);
        });
    }

    // Re-syncs every already-built .dev-visibility-checkbox/.dev-
    // independence-checkbox element's own .checked DOM property from
    // devVisibility/devIndependence - needed after applyFullDevPanelState()
    // (Undo/Reset/Load) restores those state objects, since nothing else
    // touches an ALREADY-EXISTING checkbox element's own .checked:
    // syncTabOrderToDesktop() only creates/destroys MOBILE/LANDSCAPE rows
    // via ensureDynamicTargetRow() (a newly-created row's checkbox is
    // already correct at creation time), and refreshAllGroupCascadeCheckboxes()
    // only recomputes GROUP-level state by READING whatever these row
    // checkboxes currently show - neither ever pushes restored state back
    // onto a row checkbox that already existed before the restore. Call
    // BEFORE refreshAllGroupCascadeCheckboxes() so group state computes
    // from freshly-synced, not stale, row state. Ported from a real
    // project (CLICKO) that found this exact bug live: toggling a
    // visibility checkbox then clicking Undo correctly reverted
    // devVisibility underneath, but the checkbox stayed visually checked.
    function syncDeviceCheckboxesFromState() {
        document.querySelectorAll('#desktopTabContent .dev-visibility-checkbox').forEach(cb => {
            const controlEl = cb.closest('.dev-row') && cb.closest('.dev-row').querySelector('[id]');
            if (!controlEl) return;
            cb.checked = isDevRowVisible(controlEl.id);
            // Also re-applies hide/show to a non-registered control's
            // static Mobile/Landscape counterpart - see
            // syncStaticRowVisibility()'s own comment. A no-op for a
            // registered control (already handled by
            // syncTabOrderToDesktop(), called just before this at every
            // real call site).
            syncStaticRowVisibility(controlEl.id);
        });
        ['mobile', 'landscape'].forEach(tab => {
            document.querySelectorAll('#' + tab + 'TabContent .dev-independence-checkbox').forEach(cb => {
                const controlEl = cb.closest('.dev-row') && cb.closest('.dev-row').querySelector('[id]');
                if (!controlEl) return;
                const { desktopId } = resolveDevControlId(controlEl.id);
                cb.checked = isDevRowIndependent(tab, desktopId);
            });
        });
    }

    // Finds a control's own registered metadata (label/type/min/max/
    // options/etc) by id, searching every array registered via
    // registerDevControlArray() - used to clone a Desktop control's
    // definition into a dynamically-created Mobile/Landscape row.
    function findRegisteredControlById(id) {
        for (const { array } of DEV_PANEL_REGISTERED_ARRAYS) {
            const found = array.find(c => c.id === id);
            if (found) return found;
        }
        return null;
    }
    // Reads a row's own current live value directly off its DOM control
    // - single source of truth, same convention as captureAllRegisteredControlValues().
    function readDevControlValue(id) {
        const el = document.getElementById(id);
        if (!el) return undefined;
        return el.type === 'checkbox' ? el.checked : (el.type === 'range' || el.type === 'number') ? parseFloat(el.value) : el.value;
    }
    // Writes a value into a row's own DOM control + display, mirroring
    // applyControlValues()'s own per-type logic (but without dispatching
    // an event - this is a display/state sync, not a simulated user
    // edit, so it must never itself trigger the mirroring/independence
    // listeners below - that would recurse).
    function writeDevControlValue(id, value) {
        const el = document.getElementById(id);
        if (!el || value === undefined) return;
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = value;
        if (el.type === 'range') {
            const valEl = document.getElementById(id.replace(/^slider/, 'value'));
            if (valEl && !valEl.querySelector('input')) valEl.textContent = value;
        }
    }
    // Pushes Desktop's CURRENT value into every non-independent Mobile/
    // Landscape counterpart's own DOM - called live, on every Desktop
    // control's own input/change (see wireDesktopMirrorSource() below),
    // not just on tab-switch, since all 3 tabs stay simultaneously live
    // here (see this section's own top comment on why this differs from
    // DICKOCLICKO's switch-time-only resolve).
    function applyDesktopMirror(desktopId) {
        const value = readDevControlValue(desktopId);
        if (value === undefined) return;
        ['mobile', 'landscape'].forEach(tab => {
            if (isDevRowIndependent(tab, desktopId)) return;
            const devicePrefix = tab === 'landscape' ? 'Landscape' : 'Mobile';
            const targetId = desktopId.replace(/^(slider|color|select|checkbox)/, '$1' + devicePrefix);
            writeDevControlValue(targetId, value);
        });
    }
    // Wires a Desktop control so every real edit live-mirrors to its
    // non-independent Mobile/Landscape counterparts. Takes the element
    // DIRECTLY (not an id to look up via document.getElementById) -
    // this is called from buildUniformControlRow() while the row is
    // still an in-memory, not-yet-attached DOM subtree (before whatever
    // called it appends the row somewhere), where getElementById would
    // find nothing at all; querying/passing the element straight from
    // the row itself works regardless of attachment. Idempotent (checks
    // a data flag) since ensureDynamicTargetRow()/buildUniformControlRow()
    // can both end up calling this for the same control.
    function wireDesktopMirrorSource(el, desktopId) {
        if (!el || el.dataset.mirrorWired) return;
        el.dataset.mirrorWired = '1';
        el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => applyDesktopMirror(desktopId));
    }
    // Called when a Mobile/Landscape control is edited directly. Per
    // this section's own top comment (DICKOCLICKO design decision 2):
    // while NOT independent, the edit is understood as editing Desktop's
    // own value (which this row is just mirroring), so it's redirected
    // there (and Desktop's own control DOM is updated to match, then
    // applyDesktopMirror() re-broadcasts to any OTHER non-independent
    // tab too - e.g. editing a non-independent Mobile slider also moves
    // the non-independent Landscape one). While independent, the edit
    // just updates this tab's own retained value store, nothing else.
    function onDevTargetControlEdited(tab, desktopId, targetId) {
        if (isDevRowIndependent(tab, desktopId)) {
            devDeviceValues[tab][desktopId] = readDevControlValue(targetId);
            return;
        }
        const value = readDevControlValue(targetId);
        writeDevControlValue(desktopId, value);
        const desktopEl = document.getElementById(desktopId);
        if (desktopEl) desktopEl.dispatchEvent(new Event(desktopEl.type === 'checkbox' || desktopEl.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    }
    // Desktop-only: "Show in Mobile/Landscape" - unchecking removes any
    // existing Mobile/Landscape row for this control entirely (next
    // sync); checking restores it, seeded from devDeviceValues (or
    // Desktop's current value, the first time). Appended by
    // buildUniformControlRow() itself, see that function's own comment -
    // `controlEl` is the row's own just-built control (see
    // wireDesktopMirrorSource()'s own comment on why an element
    // reference, not an id-lookup, is required here).
    function buildVisibilityCheckbox(controlEl, desktopId) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'dev-visibility-checkbox';
        cb.title = 'Show in Mobile/Landscape';
        cb.checked = isDevRowVisible(desktopId);
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
            devVisibility[desktopId] = cb.checked;
            syncTabOrderToDesktop('mobile');
            syncTabOrderToDesktop('landscape');
            syncStaticRowVisibility(desktopId);
            refreshEmptyGroupVisibility('mobile');
            refreshEmptyGroupVisibility('landscape');
            refreshGroupCascadeCheckboxState('desktop', desktopId);
        });
        wireDesktopMirrorSource(controlEl, desktopId);
        return cb;
    }
    // Mobile/Landscape-only: "Independent from Desktop." Unchecking
    // immediately snaps this row back to Desktop's current value
    // (matching DICKOCLICKO's own identical behavior - "unchecking
    // reverts this ONE control back to mirroring Desktop's own current
    // value immediately"); checking restores whatever this tab's own
    // value was the last time it was independent (devDeviceValues), or
    // just leaves the current (mirrored) value in place the first time.
    // `targetEl` is this row's own just-built control (element
    // reference, not an id - see wireDesktopMirrorSource()'s own
    // comment for why).
    function buildIndependenceCheckbox(tab, desktopId, targetEl) {
        const targetId = targetEl ? targetEl.id : null;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'dev-independence-checkbox';
        cb.title = 'Independent from Desktop';
        cb.checked = isDevRowIndependent(tab, desktopId);
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
            devIndependence[tab][desktopId] = cb.checked;
            if (cb.checked) {
                const restored = devDeviceValues[tab][desktopId];
                if (restored !== undefined) writeDevControlValue(targetId, restored);
            } else {
                // Captures the CURRENT (about-to-be-overwritten) value
                // before snapping to Desktop's - otherwise a control that
                // defaults independent (a real per-tab value, never live-
                // edited yet so onDevTargetControlEdited never ran) loses
                // its only copy of that tuned value the first time it's
                // unchecked, since devDeviceValues was never populated for
                // it. Ported from CLICKO, which found this exact bug live.
                devDeviceValues[tab][desktopId] = readDevControlValue(targetId);
                writeDevControlValue(targetId, readDevControlValue(desktopId));
            }
            refreshGroupCascadeCheckboxState(tab, desktopId);
        });
        if (targetEl && !targetEl.dataset.indepWired) {
            targetEl.dataset.indepWired = '1';
            targetEl.addEventListener(targetEl.type === 'checkbox' || targetEl.tagName === 'SELECT' ? 'change' : 'input', () => onDevTargetControlEdited(tab, desktopId, targetId));
        }
        return cb;
    }
    // Shared cascade behavior for BOTH group-level checkbox kinds
    // (Desktop visibility, Mobile/Landscape independence) - per this
    // section's own top comment, neither has persisted state of its
    // own; checking/unchecking the group checkbox just writes through
    // to every CURRENT child row's real flag (walking the live DOM), and
    // its own checked/indeterminate display is always COMPUTED from
    // children, never read back from storage. `getRowCheckbox(rowEl)`
    // returns that row's own real checkbox (visibility or independence,
    // whichever this cascade instance is for); `setChecked(rowEl, v)`
    // performs the actual state change (delegates to the same handler a
    // real click would run, so every side effect - sync, mirroring,
    // devDeviceValues - happens identically either way).
    function buildGroupCascadeCheckbox(sectionEl, kind) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'dev-group-cascade-checkbox';
        cb.dataset.cascadeKind = kind;
        cb.title = kind === 'visibility' ? 'Show in Mobile/Landscape (whole group)' : 'Independent from Desktop (whole group)';
        // CORRECTED 2026-09-21 (found live on HANDYSET, a real project built
        // from this template): this used to hardcode `cb.style.display =
        // 'none'` here, and nothing anywhere else in this file ever set it
        // back to visible (confirmed by exhaustive grep) -- the checkbox
        // existed in the DOM and worked functionally, but was permanently
        // invisible on every project built from this template, in every
        // group, forever. Left it fully visible by default instead (it's
        // meant to be a real, usable control sitting left of the group's
        // own undock/lock icons, per §12e/§12f-1's own documentation).
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
            const checked = cb.checked;
            const content = sectionEl.querySelector(':scope > .dev-section-content');
            if (!content) return;
            content.querySelectorAll(':scope > .dev-row [id]').forEach(idEl => {
                const rowCb = idEl.closest('.dev-row').querySelector(kind === 'visibility' ? '.dev-visibility-checkbox' : '.dev-independence-checkbox');
                if (rowCb && rowCb.checked !== checked) { rowCb.checked = checked; rowCb.dispatchEvent(new Event('change')); }
            });
            content.querySelectorAll(':scope > .dev-section').forEach(subSec => {
                const subCb = subSec.querySelector(':scope > .dev-section-title > .dev-group-cascade-checkbox[data-cascade-kind="' + kind + '"]');
                // subCb.indeterminate is checked separately from
                // subCb.checked !== checked - a subgroup already showing
                // checked:false/indeterminate:true (mixed) would otherwise
                // be silently skipped (false !== false is false), leaving
                // its own descendants completely untouched by the cascade.
                // Found live on CLICKO: unchecking a large group left a
                // nested mixed-state subgroup - and everything under it -
                // fully checked, never actually cascaded into at all.
                if (subCb && (subCb.indeterminate || subCb.checked !== checked)) {
                    subCb.checked = checked;
                    subCb.indeterminate = false;
                    subCb.dispatchEvent(new Event('change'));
                }
            });
        });
        return cb;
    }
    // Undock/Dock (2026-09-19, direct request: "next to the lock button per
    // settings group, provide a 'undock' button that undocks that one
    // setting group and allows me to use it, visibly as a differetn panel.
    // But when i click the 'undock/dock' button again, it will dock back
    // in its previous position in the dev panel. I want the undocked
    // panel to be able to be resized and drag and moved same as the dev
    // panel." - "lock button" was clarified to mean the group-level
    // cascade checkbox above). Session-only by design - no position/size/
    // undocked-state persistence across reload/Save/Copy (see
    // dockAllUndockedGroups()'s own comment below) - undocking is a live
    // viewing convenience, not a saved layout choice.
    // Lock icon (2026-09-19, ported from Clicko - "add a lock icon that i
    // can select. If selected, the settings within that group cannot be
    // reordered or moved into another group"). Keyed the same way as
    // devTextOverrides/sectionCollapseState (getSectionKey(titleEl) -
    // stable, DOM-position-independent). Deliberately scoped to ONLY the
    // settings INSIDE a locked group - the locked group ITSELF can still
    // be dragged/reordered/nested as a whole; only its own rows can't be
    // reordered within it or dragged out to another group. Enforced in
    // setupDragReorder() itself (search "lockedGroups.has") by refusing to
    // even START a drag on a .dev-row whose own closest .dev-section is
    // locked - satisfies both halves of the request at once, since a drag
    // that never starts can neither reorder in place nor be dropped into a
    // different group. Also refuses delete (findDevDeleteProtectionReason()).
    let lockedGroups = new Set();
    // Builds and appends one group's own lock-toggle icon - a SIBLING of
    // .dev-section-title (same rename-survival reasoning as the drag
    // handle/undock button). Shared by createDevGroupElement() (a freshly-
    // created group) and injectGroupLockIcons() (every group already in
    // the DOM at panel-build time) - idempotent, so calling it twice on
    // the same section just replaces the old icon rather than duplicating it.
    function addGroupLockIcon(section) {
        const existing = section.querySelector(':scope > .dev-group-lock-icon');
        if (existing) existing.remove();
        const titleEl = section.querySelector(':scope > .dev-section-title');
        if (!titleEl) return;
        const icon = document.createElement('span');
        icon.className = 'dev-group-lock-icon';
        const key = getSectionKey(titleEl);
        icon.classList.toggle('locked', lockedGroups.has(key));
        icon.textContent = lockedGroups.has(key) ? '🔒' : '🔓';
        icon.title = lockedGroups.has(key) ? 'Locked - click to unlock' : 'Unlocked - click to lock';
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            const k = getSectionKey(titleEl);
            if (lockedGroups.has(k)) { lockedGroups.delete(k); icon.textContent = '🔓'; icon.title = 'Unlocked - click to lock'; icon.classList.remove('locked'); }
            else { lockedGroups.add(k); icon.textContent = '🔒'; icon.title = 'Locked - click to unlock'; icon.classList.add('locked'); }
        });
        // pointerdown also needs stopping - setupDragReorder() listens at
        // the document level, and the icon visually overlaps the title bar
        // (the group-reorder drag handle's own hit area), so without this a
        // click on the icon would also arm a group-drag underneath it.
        icon.addEventListener('pointerdown', (e) => e.stopPropagation());
        section.appendChild(icon);
    }
    // One-time pass over every group already in the DOM when the panel is
    // first built - createDevGroupElement() covers any group created AFTER
    // this point via its own addGroupLockIcon() call (see its own comment).
    function injectGroupLockIcons() {
        DEV_PANEL_TABS.forEach(tab => {
            const tabEl = document.getElementById(tab + 'TabContent');
            if (!tabEl) return;
            tabEl.querySelectorAll('.dev-section').forEach(addGroupLockIcon);
        });
    }
    const undockedGroups = new Map(); // sectionEl -> { panel, parent, nextSibling, btn }
    function buildGroupUndockButton(sectionEl) {
        const btn = document.createElement('span');
        btn.className = 'dev-group-undock-btn';
        // U+2197 (simple NORTH EAST ARROW), not U+2B08 (a Miscellaneous
        // Symbols and Arrows glyph with much weaker font-fallback support -
        // direct report: "i dont see the dock and undock button", root-
        // caused to this rendering as an unrecognizable small mark rather
        // than a real icon, not the element being absent). ↗/↙ below are
        // in the basic Arrows block, same broad support as ←→↑↓.
        btn.textContent = '↗';
        btn.title = 'Undock this group into its own floating panel';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleGroupUndock(sectionEl, btn);
        });
        return btn;
    }
    // Creates the floating panel a group's content moves into while
    // undocked - own drag-to-move header + 8-handle resize (reusing
    // setupPanelResizeHandle()'s now-generalized setLeftTop callback, see
    // its own comment, plus the same .dev-panel-resize-edge/-corner CSS
    // classes the main panel uses) - position/size held as plain inline
    // styles, independent per undocked panel, never persisted.
    function createUndockPanel(sectionEl, titleText) {
        const rect = sectionEl.getBoundingClientRect();
        const panel = document.createElement('div');
        panel.className = 'dev-undock-panel';
        panel.style.left = Math.round(rect.left) + 'px';
        panel.style.top = Math.round(rect.top) + 'px';
        panel.style.width = Math.max(240, Math.round(rect.width)) + 'px';
        panel.style.height = Math.min(window.innerHeight - Math.round(rect.top) - 20, Math.max(160, Math.round(rect.height) + 60)) + 'px';

        const header = document.createElement('div');
        header.className = 'dev-undock-panel-header';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = titleText;
        const dockBtn = document.createElement('button');
        dockBtn.className = 'dev-undock-panel-dock-btn';
        dockBtn.textContent = 'DOCK';
        dockBtn.title = 'Dock this group back into the dev panel';
        dockBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entry = undockedGroups.get(sectionEl);
            if (entry) toggleGroupUndock(sectionEl, entry.btn);
        });
        header.appendChild(titleSpan);
        header.appendChild(dockBtn);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = 'dev-undock-panel-body';
        panel.appendChild(body);

        ['edge-top', 'edge-bottom', 'edge-left', 'edge-right', 'corner-tl', 'corner-tr', 'corner-bl', 'corner-br'].forEach(cls => {
            const handle = document.createElement('div');
            handle.className = (cls.indexOf('edge') === 0 ? 'dev-panel-resize-edge ' : 'dev-panel-resize-corner ') + cls;
            panel.appendChild(handle);
        });
        const setLeftTop = (key, value) => { panel.style[key] = value + 'px'; };
        setupPanelResizeHandle(panel, panel.querySelector('.edge-top'), null, 'top', setLeftTop);
        setupPanelResizeHandle(panel, panel.querySelector('.edge-bottom'), null, 'bottom', setLeftTop);
        setupPanelResizeHandle(panel, panel.querySelector('.edge-left'), 'left', null, setLeftTop);
        setupPanelResizeHandle(panel, panel.querySelector('.edge-right'), 'right', null, setLeftTop);
        setupPanelResizeHandle(panel, panel.querySelector('.corner-tl'), 'left', 'top', setLeftTop);
        setupPanelResizeHandle(panel, panel.querySelector('.corner-tr'), 'right', 'top', setLeftTop);
        setupPanelResizeHandle(panel, panel.querySelector('.corner-bl'), 'left', 'bottom', setLeftTop);
        setupPanelResizeHandle(panel, panel.querySelector('.corner-br'), 'right', 'bottom', setLeftTop);

        // Drag-to-move via the header, same pattern as devPanelHeader's own
        // drag handler above, simplified (no mobile-edge-swipe-gesture
        // clamping - that's specifically a concern for the ALWAYS-present
        // main panel; an undocked panel is a transient, opt-in convenience).
        let dragging = false;
        let dragStart = { pointerX: 0, pointerY: 0, left: 0, top: 0 };
        header.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            e.preventDefault();
            const r = panel.getBoundingClientRect();
            dragStart = { pointerX: e.clientX, pointerY: e.clientY, left: r.left, top: r.top };
            dragging = true;
            header.classList.add('dragging');
            try { header.setPointerCapture(e.pointerId); } catch (err) {}
        });
        document.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            if (e.buttons === 0) { endDrag(e); return; }
            const panelRect = panel.getBoundingClientRect();
            const dx = e.clientX - dragStart.pointerX;
            const dy = e.clientY - dragStart.pointerY;
            const newLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, dragStart.left + dx));
            const newTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, dragStart.top + dy));
            panel.style.left = Math.round(newLeft) + 'px';
            panel.style.top = Math.round(newTop) + 'px';
        });
        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            header.classList.remove('dragging');
            if (e && e.pointerId !== undefined && header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId);
        }
        document.addEventListener('pointerup', endDrag);
        document.addEventListener('pointercancel', endDrag);
        header.addEventListener('lostpointercapture', endDrag);

        document.body.appendChild(panel);
        body.appendChild(sectionEl);
        return panel;
    }
    // Toggles ONE group between docked (living in its normal place inside
    // the main dev panel) and undocked (living in its own floating panel -
    // createUndockPanel() above). Docking back uses the saved parent +
    // nextSibling reference to restore the EXACT original position, same
    // real-DOM-node-preservation technique this file's own Undo/Delete
    // already use for byte-identical restoration (not a rebuild from
    // captured data, which could drift).
    function toggleGroupUndock(sectionEl, btn) {
        const entry = undockedGroups.get(sectionEl);
        if (entry) {
            if (entry.nextSibling && entry.nextSibling.parentElement === entry.parent) {
                entry.parent.insertBefore(sectionEl, entry.nextSibling);
            } else {
                entry.parent.appendChild(sectionEl);
            }
            entry.panel.remove();
            undockedGroups.delete(sectionEl);
            btn.textContent = '↗';
            btn.title = 'Undock this group into its own floating panel';
            sectionEl.classList.remove('dev-group-undocked');
        } else {
            const parent = sectionEl.parentElement;
            const nextSibling = sectionEl.nextSibling;
            const titleText = sectionEl.querySelector(':scope > .dev-section-title')?.dataset.sid || 'Group';
            const panel = createUndockPanel(sectionEl, titleText);
            undockedGroups.set(sectionEl, { panel, parent, nextSibling, btn });
            btn.textContent = '↙';
            btn.title = 'Dock this group back into the dev panel';
            sectionEl.classList.add('dev-group-undocked');
        }
    }
    // Docks every currently-undocked group back into place - called before
    // any operation that captures/reads the panel's structure from its
    // normal DOM location (Copy/Sync/Named Setting States/Undo snapshot),
    // since an undocked group's .dev-section is no longer a descendant of
    // its tab's #<tab>TabContent at all (it's inside a floating panel,
    // appended to document.body) and would otherwise be silently invisible
    // to captureSectionOrder()/captureFullDevPanelState(). Keeps undocking
    // a purely live/transient state, never a saved one - simpler and safer
    // than teaching every capture path to look inside floating panels too.
    function dockAllUndockedGroups() {
        Array.from(undockedGroups.keys()).forEach(sectionEl => {
            const entry = undockedGroups.get(sectionEl);
            if (entry) toggleGroupUndock(sectionEl, entry.btn);
        });
    }
    // Recomputes every ancestor group's own cascade-checkbox checked/
    // indeterminate display from its current children - called after any
    // individual row checkbox changes (both a real click and a group-
    // cascade write-through), so an ancestor never shows a stale
    // all-checked/all-unchecked state. `tab` selects which kind
    // ('desktop' -> visibility, else -> independence); `desktopId` is
    // only used to find the row to start walking up from.
    function refreshGroupCascadeCheckboxState(tab, desktopId) {
        const kind = tab === 'desktop' ? 'visibility' : 'independence';
        const id = tab === 'desktop' ? desktopId : desktopId.replace(/^(slider|color|select|checkbox)/, '$1' + (tab === 'landscape' ? 'Landscape' : 'Mobile'));
        const rowEl = document.getElementById(id)?.closest('.dev-row');
        let sectionEl = rowEl ? rowEl.closest('.dev-section') : null;
        while (sectionEl) {
            recomputeOneGroupCascadeCheckbox(sectionEl, kind);
            sectionEl = sectionEl.parentElement ? sectionEl.parentElement.closest('.dev-section') : null;
        }
    }
    // Computes ONE section's own cascade checkbox (of the given `kind`)
    // checked/indeterminate display from its DIRECT children only - a
    // no-op if this section has no such checkbox (e.g. a static group
    // before ensureStaticGroupCascadeCheckboxes() has run, or simply the
    // wrong `kind` for this tab). Shared by refreshGroupCascadeCheckboxState()
    // above (ancestor-walking, after one real checkbox change) and
    // refreshAllGroupCascadeCheckboxes() below (every section, after a
    // batch of rows was just built) - callers are responsible for
    // ordering (deepest-first for a full refresh, since a parent's own
    // correct state depends on its children already being current).
    function recomputeOneGroupCascadeCheckbox(sectionEl, kind) {
        const cb = sectionEl.querySelector(':scope > .dev-section-title > .dev-group-cascade-checkbox[data-cascade-kind="' + kind + '"]');
        if (!cb) return;
        const rowSelector = kind === 'visibility' ? '.dev-visibility-checkbox' : '.dev-independence-checkbox';
        const content = sectionEl.querySelector(':scope > .dev-section-content');
        const states = [];
        content.querySelectorAll(':scope > .dev-row').forEach(r => {
            const rcb = r.querySelector(rowSelector);
            if (rcb) states.push(rcb.checked);
        });
        content.querySelectorAll(':scope > .dev-section').forEach(sub => {
            const scb = sub.querySelector(':scope > .dev-section-title > .dev-group-cascade-checkbox[data-cascade-kind="' + kind + '"]');
            if (scb) states.push(scb.indeterminate ? 'mixed' : scb.checked);
        });
        const allChecked = states.length > 0 && states.every(s => s === true);
        const allUnchecked = states.every(s => s === false);
        cb.checked = allChecked;
        cb.indeterminate = !allChecked && !allUnchecked && states.length > 0;
    }
    // Full, one-shot refresh of EVERY group's own cascade checkbox
    // (both kinds) from its current children - needed because
    // refreshGroupCascadeCheckboxState() above only ever fires reactively,
    // off one real checkbox's own 'change' event. A batch of rows built
    // by a project's own render*Controls() call and appended with an
    // already-checked/unchecked default (buildVisibilityCheckbox()/
    // buildIndependenceCheckbox() set `.checked` directly, no 'change'
    // event fires for that) would otherwise leave every ancestor group's
    // own checkbox showing its stale build-time default (unchecked)
    // forever, until something happened to be toggled by hand. Call once
    // after your own render*Controls() calls finish (see
    // ensureDevPanelBuilt()'s own call below) - depth-sorted (deepest
    // groups computed first, same technique DICKOCLICKO's own
    // refreshGroupIndependenceStates() uses) so a parent's own
    // computation always sees its children's ALREADY-current state, not
    // last-refresh's stale one.
    function refreshAllGroupCascadeCheckboxes() {
        function depth(el) {
            let d = 0, cur = el.parentElement;
            while (cur) { if (cur.classList.contains('dev-section')) d++; cur = cur.parentElement; }
            return d;
        }
        const sections = Array.from(document.querySelectorAll('.dev-section')).sort((a, b) => depth(b) - depth(a));
        ['visibility', 'independence'].forEach(kind => {
            sections.forEach(sec => recomputeOneGroupCascadeCheckbox(sec, kind));
        });
    }
    // Backfills a group cascade checkbox onto any EXISTING .dev-section-title
    // that doesn't already have one - specifically the 3 static built-in
    // "Dev Panel" groups in the HTML above (createDevGroupElement()
    // already adds one to every group IT creates - custom "+ Add Group"
    // groups and dynamically-mirrored ones alike - so this only ever
    // needs to backfill markup that predates this feature and can't run
    // JS inline). Runs once at init (see initDevPanelEngine() below) -
    // nothing after that point can ever create a titleEl missing one.
    function ensureStaticGroupCascadeCheckboxes() {
        // Scoped to titles actually inside a tab content root - a
        // panel-level group outside the tab system entirely ("Saved Dev
        // Settings", added 2026-09-14 - see its own HTML comment) has no
        // Mobile/Landscape counterpart to be visible-in/independent-from
        // at all, so a cascade checkbox there would be meaningless. Was a
        // bare global '.dev-section-title' query before this group
        // existed.
        document.querySelectorAll('[id$="TabContent"] .dev-section-title').forEach(titleEl => {
            if (titleEl.querySelector(':scope > .dev-group-cascade-checkbox')) return;
            const tabContentEl = titleEl.closest('[id$="TabContent"]');
            const tab = tabContentEl ? tabContentEl.id.replace('TabContent', '') : 'desktop';
            const section = titleEl.closest('.dev-section');
            titleEl.appendChild(buildGroupCascadeCheckbox(section, tab === 'desktop' ? 'visibility' : 'independence'));
        });
    }
    // Same static-group backfill as ensureStaticGroupCascadeCheckboxes()
    // above, for the Undock button instead - every group that predates
    // this feature (i.e. every group in this template's own static HTML)
    // needs its button injected once, here; createDevGroupElement() above
    // covers any group created AFTER this feature exists. Idempotent
    // (skips a section that already has one) so it's safe to call again.
    function ensureStaticGroupUndockButtons() {
        document.querySelectorAll('[id$="TabContent"] .dev-section').forEach(section => {
            if (section.querySelector(':scope > .dev-group-undock-btn')) return;
            section.appendChild(buildGroupUndockButton(section));
        });
    }
    // Creates (or finds) a Mobile/Landscape counterpart row for one
    // Desktop control, per its own devVisibility flag - the dynamic
    // heart of this whole feature, called from syncTabOrderToDesktop()
    // below for EVERY Desktop row it walks (universal as of 2026-09-17 -
    // no opt-in flag any more). Returns the target-tab control's own id,
    // or null if this row shouldn't exist on this tab right now
    // (genuinely hidden, not one of the 4 uniform types this pass
    // covers, or not a registered control at all).
    function ensureDynamicTargetRow(targetTab, desktopId, targetRowByDesktopId, scratch) {
        const existingId = targetRowByDesktopId[desktopId];
        const desktopCtrl = findRegisteredControlById(desktopId);
        // No opt-in gate any more (UNIVERSAL as of 2026-09-17, see
        // buildUniformControlRow()'s own comment) - only a genuinely
        // unregistered desktopId (not a real control at all) short-
        // circuits here now.
        if (!desktopCtrl) return existingId || null;
        const visible = isDevRowVisible(desktopId);
        if (!visible) {
            if (existingId) {
                const el = document.getElementById(existingId);
                const rowEl = el ? el.closest('.dev-row') : null;
                if (rowEl) rowEl.remove();
                delete targetRowByDesktopId[desktopId];
            }
            return null;
        }
        if (existingId) return existingId;
        const devicePrefix = targetTab === 'landscape' ? 'Landscape' : 'Mobile';
        const newId = desktopId.replace(/^(slider|color|select|checkbox)/, '$1' + devicePrefix);
        // Prefer a REAL, separately-registered per-device ctrl (an old-
        // style control, authored with its own independently-tuned
        // Mobile/Landscape entry before this feature existed) over
        // cloning Desktop's own definition - Desktop's min/max/value can
        // be flatly wrong for a control genuinely meant to differ per
        // device (e.g. a smaller Desktop range vs. a larger Mobile one).
        // Only reached when a hidden-then-re-shown row needs rebuilding,
        // since an already-visible old-style row is found via existingId
        // above and never touches this path at all.
        const realCtrl = findRegisteredControlById(newId);
        const baseCtrl = realCtrl || desktopCtrl;
        if (!UNIFORM_ROW_BUILDERS[baseCtrl.type]) return null; // not a uniform-type control - out of this pass's scope, see top comment
        const clonedCtrl = Object.assign({}, baseCtrl, { id: newId, tab: targetTab });
        const row = buildUniformControlRow(clonedCtrl);
        if (clonedCtrl.type === 'select') row.querySelector('select').value = clonedCtrl.value;
        else if (clonedCtrl.type === 'checkbox') row.querySelector('input').checked = !!clonedCtrl.value;
        scratch.appendChild(row);
        const restored = devDeviceValues[targetTab][desktopId];
        const independent = isDevRowIndependent(targetTab, desktopId);
        if (independent && restored !== undefined) writeDevControlValue(newId, restored);
        else if (independent && realCtrl) writeDevControlValue(newId, realCtrl.value);
        else writeDevControlValue(newId, readDevControlValue(desktopId));
        targetRowByDesktopId[desktopId] = newId;
        return newId;
    }

    // ================================================================
    // [JS-4b] CROSS-TAB ORDER MIRRORING (DESKTOP -> MOBILE/LANDSCAPE)
    // ================================================================
    // Whenever Mobile or Landscape is opened, its own group/setting
    // order is re-derived from Desktop's CURRENT order, live, every
    // time — Desktop is always the source of truth, one-directional by
    // design (ported from a real project's own dev panel, where this
    // shipped in response to direct reports that renaming/reordering/
    // regrouping/nesting groups on Desktop wasn't reflected on the
    // other tabs — see the MAINTENANCE note at the top of this file).
    // Matches each Desktop group to its target-tab counterpart by
    // data-sid (a stable id frozen at creation - see getSectionKey()'s
    // own comment - so matching survives a rename; the DISPLAYED name
    // is a completely separate thing, mirrored by syncRename() below,
    // NOT by this id match alone) and each row by resolveDevControlId()'s
    // desktopId (a Mobile/Landscape control's id with the device name
    // removed — see [JS-5] below). A Desktop-only control (no id exists
    // on the target tab) is correctly dropped, never force-created; a
    // target-tab-only control (no Desktop id matches — e.g. a setting
    // that's deliberately only meaningful on Mobile) is preserved by
    // appending it to the end of whichever group it's currently sitting
    // in; a target-tab-only GROUP (no Desktop counterpart at all) is
    // preserved by appending it to the end of the tab, after every
    // Desktop-matched group, rather than being silently dropped or left
    // stranded at whatever DOM position it happened to occupy. Nesting
    // depth is unlimited and handled for free — captureSection()/
    // applySectionOrder() above are already fully recursive, this only
    // needs to translate through the same recursive shape.
    //
    // RENAME MIRRORING: a group's displayed TITLE and each setting's
    // displayed LABEL (both driven by devTextOverrides, [JS-9] above)
    // are ALSO mirrored here, live, every sync - not just carried over
    // once when a target-tab counterpart is first created. See
    // syncRename()'s own comment below for exactly why a naive
    // "copy-once" version is a real, shipped bug and not just a
    // theoretical risk.
    //
    // Known narrow gap, left unhandled (call this again from your own
    // code with a fix if you need it): a target-tab-only GROUP nested
    // INSIDE a Desktop-matched group isn't found by the leftover-group
    // pass below, which only scans the tab's own top-level groups — it
    // needs both a device-only nested group AND that exact nesting
    // depth to matter, a narrow enough case that a real project (CLICKO)
    // shipped without it and revisited only if it ever actually came up.
    function syncTabOrderToDesktop(targetTab) {
        if (targetTab === 'desktop') return;
        const desktopOrder = captureSectionOrder().desktopTabContent;
        const targetTabId = targetTab + 'TabContent';
        const targetTabEl = document.getElementById(targetTabId);
        if (!desktopOrder || !targetTabEl) return;

        // Every target-tab row, keyed by ITS OWN desktop-equivalent id -
        // tab-wide (not :scope-scoped to any one group), since a row's
        // target-tab counterpart may currently live nested, top-level,
        // or under a totally different parent than Desktop's.
        const targetRowByDesktopId = {};
        targetTabEl.querySelectorAll('.dev-row [id]').forEach(idEl => {
            targetRowByDesktopId[resolveDevControlId(idEl.id).desktopId] = idEl.id;
        });
        const placedRowIds = new Set();
        let overridesChanged = false;
        // Temporary parking spot for a row ensureDynamicTargetRow() just
        // created dynamically - needs to sit inside SOME .dev-section-content
        // for applySectionOrder()'s own rowsByKey lookup (built via
        // '.dev-section-content > .dev-row') to find it by id; removed
        // once applySectionOrder() has moved every real row out of it
        // into its correct final position (see below - it's always
        // empty by then, never left behind).
        const scratch = document.createElement('div');
        scratch.className = 'dev-section-content';
        scratch.style.display = 'none';
        targetTabEl.appendChild(scratch);

        // Mirrors ONE rename from its Desktop key onto its target-tab
        // counterpart key, live, EVERY sync - not just the first time
        // the counterpart is matched/created (ported from a real
        // project's own dev panel, which shipped without this re-copy
        // the first time and found a real bug: a rename only carried
        // over ONCE, since a naive "does the target already have an
        // override" check was true forever after that first carry-over
        // - see devTextOverridesManual's own comment, [JS-9] above).
        // Skips a key this tab has been independently renamed on
        // directly, so a deliberate target-tab-only name is never
        // clobbered; otherwise keeps re-copying Desktop's current value
        // - including clearing it back to null when Desktop's own
        // rename is itself cleared - so a LATER Desktop rename, not
        // just the initial one, reaches the target tab on every
        // subsequent switch. Used for both group titles and individual
        // row labels below.
        function syncRename(desktopKey, targetKey) {
            if (devTextOverridesManual.has(targetKey)) return;
            const desktopVal = devTextOverrides[desktopKey] != null ? devTextOverrides[desktopKey] : null;
            if (devTextOverrides[targetKey] !== desktopVal) {
                devTextOverrides[targetKey] = desktopVal;
                overridesChanged = true;
            }
        }

        function translateGroup(savedGroup) {
            const sid = savedGroup.key.slice(savedGroup.key.indexOf(':') + 1);
            // Mouse Log ([JS-13c]) is a single, Desktop-only widget - its
            // checkbox/slider ARE real registered rows (so they'd
            // otherwise mirror fine), but the live log display + Copy/
            // Save/Clear buttons are hand-built DOM outside the control-
            // registration system entirely, so a mirrored copy would only
            // ever be an empty, non-functional shell (confirmed live: 0
            // children). Skipped by name rather than generalizing "skip
            // truly empty groups" into this shared function for every
            // project's own groups - a narrow, explicitly-commented
            // exception for this one built-in widget.
            if (sid === 'Mouse Log') return null;
            const groupKey = targetTab + ':' + sid;
            // Walks savedGroup.items (the interleaved row/subgroup order -
            // 2026-09-19, see captureSection()'s own comment) instead of
            // the old separate rowKeys/subgroups arrays, so a row placed
            // ABOVE a subgroup on Desktop mirrors that same interleaved
            // order onto Mobile/Landscape, not "all rows first." Falls
            // back to the pre-2026-09-19 rowKeys-then-subgroups shape for
            // a savedGroup captured before this change (there is none in
            // practice - captureSectionOrder() above always produces the
            // new shape now - but this keeps translateGroup() correct
            // even if called on an externally-sourced legacy sectionOrder,
            // e.g. one round-tripped through localStorage from an older
            // page load).
            const items = savedGroup.items || [
                ...(savedGroup.rowKeys || []).map(key => ({ type: 'row', key })),
                ...(savedGroup.subgroups || []).map(section => ({ type: 'group', section })),
            ];
            const translatedItems = items.map(item => {
                if (item.type === 'row') {
                    // Per direct request: a row's presence here is now
                    // decided by its OWN devVisibility flag (default
                    // visible - see this feature's own [JS-4b0] section
                    // above), not by whether a target-tab DOM row happens
                    // to already exist - ensureDynamicTargetRow() creates
                    // one on the fly (cloning Desktop's own control
                    // metadata) or removes an existing one, whichever the
                    // flag currently says, and returns null only when
                    // neither applies (row hidden, or a control type
                    // outside this pass's scope).
                    const targetId = ensureDynamicTargetRow(targetTab, item.key, targetRowByDesktopId, scratch);
                    if (!targetId) return null;
                    placedRowIds.add(targetId);
                    syncRename(item.key, targetId);
                    return { type: 'row', key: targetId };
                }
                const translatedSub = translateGroup(item.section);
                return translatedSub ? { type: 'group', section: translatedSub } : null;
            }).filter(Boolean);
            syncRename(savedGroup.key, groupKey);
            return {
                key: groupKey,
                items: translatedItems,
                rowKeys: translatedItems.filter(it => it.type === 'row').map(it => it.key),
                subgroups: translatedItems.filter(it => it.type === 'group').map(it => it.section),
            };
        }
        const translated = desktopOrder.map(translateGroup).filter(Boolean);

        function findByKey(groups, key) {
            for (const g of groups) {
                if (g.key === key) return g;
                const found = findByKey(g.subgroups || [], key);
                if (found) return found;
            }
            return null;
        }
        // Leftover rows (target-tab-only controls, no Desktop id
        // matched anything above) - appended to the end of whichever
        // translated group they're CURRENTLY sitting in, found via
        // their live parent .dev-section's own key. applySectionOrder()
        // only ever places rows it's explicitly told about, so skipping
        // this step would silently drop these instead of preserving them.
        targetTabEl.querySelectorAll('.dev-row [id]').forEach(idEl => {
            if (placedRowIds.has(idEl.id)) return;
            const sec = idEl.closest('.dev-section');
            if (!sec) return;
            const key = getSectionKey(sec.querySelector(':scope > .dev-section-title'));
            const group = findByKey(translated, key);
            if (group) {
                // Pushed into BOTH items (what applySectionOrder() actually
                // reads now - see placeSection()'s own comment) and the
                // derived rowKeys, so this leftover row doesn't silently
                // vanish on restore the way it would if only rowKeys were
                // updated here (2026-09-19 - items/rowKeys used to be the
                // same single source before the interleaved-order change,
                // this push predates that change).
                group.items.push({ type: 'row', key: idEl.id });
                group.rowKeys.push(idEl.id);
            }
        });

        // Leftover groups (target-tab-only, no Desktop counterpart at
        // all) - appended to the end of the tab. See this function's
        // own top comment for the narrow nested-leftover-group gap this
        // doesn't cover.
        function collectKeys(groups, out) {
            groups.forEach(g => { out.add(g.key); collectKeys(g.subgroups || [], out); });
            return out;
        }
        const translatedKeys = collectKeys(translated, new Set());
        targetTabEl.querySelectorAll(':scope > .dev-section').forEach(sec => {
            const key = getSectionKey(sec.querySelector(':scope > .dev-section-title'));
            if (!translatedKeys.has(key)) translated.push(captureSection(sec));
        });

        applySectionOrder({ [targetTabId]: translated });
        // Always empty by now - every row ensureDynamicTargetRow() ever
        // parked here was included in `translated` above (via rowKeys),
        // so applySectionOrder() just moved each one out into its real
        // group. Safe to remove unconditionally.
        scratch.remove();
        // A newly-created group is painted with its raw internal name
        // by createDevGroupElement()/applySectionOrder() - re-run the
        // override painter now that devTextOverrides may have gained a
        // fresh entry for it (or for any row above), so a carried-over
        // rename actually shows instead of the raw fallback text.
        if (overridesChanged) applyDevTextOverrides();
        // Unlike Clicko (where every row is static, built once at page
        // load), this template's own dynamicDevice feature (ensureDynamicTargetRow()
        // above) DOES create new row DOM after the panel is first built -
        // any freshly-created Mobile/Landscape row needs its own drag
        // handle too, so re-run the same idempotent injection pass rather
        // than assuming injectRowDragHandles()'s one initial call already
        // covered it.
        injectRowDragHandles();
    }

    // ================================================================
    // [JS-5] DEVICE-SPLIT ID NAMING CONVENTION
    // ================================================================
    // Device-split naming convention: a Desktop control's own id
    // (e.g. sliderButtonSpeed) gets a Mobile/Landscape twin by inserting
    // "Mobile"/"Landscape" right after the type prefix (sliderMobile
    // ButtonSpeed, sliderLandscapeButtonSpeed) — per CLAUDE.md Section
    // 12f, spatial/size settings default to independently-tunable per
    // device; this is the naming convention that makes that pattern
    // parseable generically instead of hand-listing every id 3x.
    // Pure regex/naming logic, no project-specific coupling — use this
    // in your OWN device-split settings the same way the engine's own
    // DEVPANEL_STYLE_CONTROLS ids already follow it.
    function resolveDevControlId(id) {
        const m = id.match(/^(slider|color|select|checkbox)(Mobile|Landscape)(.+)$/);
        if (m) return { device: m[2] === 'Landscape' ? 'landscape' : 'mobile', desktopId: m[1] + m[3] };
        return { device: 'desktop', desktopId: id };
    }

    // ================================================================
    // [JS-6] ROW BUILDERS (SLIDER / COLOR / SELECT / CHECKBOX / TEXT INPUT)
    // ================================================================
    // Row builders — one function per control type + a dispatch table.
    // Each takes a plain {id, label, ...} object and returns a
    // <div class="dev-row"> ready to append into a group's content.
    // ----------------------------------------------------------------

    // Resolves a group's .dev-section-content by tab + data-sid,
    // warning on 0 matches (group not found) or 2+ matches (a data-sid
    // collision — e.g. 2 groups both named "New Group").
    function findGroupContent(tabId, groupSid, callerName, ctrlId) {
        const matches = document.querySelectorAll('#' + tabId + 'TabContent > .dev-section > .dev-section-title[data-sid="' + groupSid.replace(/"/g, '\\"') + '"]');
        if (matches.length === 0) {
            console.warn(callerName + ': group not found', groupSid, ctrlId);
            return null;
        }
        if (matches.length > 1) {
            console.warn(callerName + ': ' + matches.length + ' groups share this data-sid (using the first) - a rename/duplication collision', groupSid, ctrlId);
        }
        return matches[0].nextElementSibling;
    }

    // {id, label, min, max, step, value}
    function buildSliderRow(ctrl) {
        const row = document.createElement('div');
        row.className = 'dev-row';
        const label = document.createElement('span');
        label.className = 'dev-label';
        label.textContent = ctrl.label;
        row.appendChild(label);
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'dev-slider';
        input.id = ctrl.id;
        input.min = ctrl.min;
        input.max = ctrl.max;
        input.step = ctrl.step;
        input.value = ctrl.value;
        row.appendChild(input);
        const value = document.createElement('span');
        value.className = 'dev-value';
        value.id = ctrl.id.replace(/^slider/, 'value');
        value.textContent = ctrl.value;
        row.appendChild(value);
        return row;
    }
    // {id, label, value, note?} — note is an optional small descriptive
    // string shown instead of a plain value readout (e.g. "(tint)").
    function buildColorRow(ctrl) {
        const row = document.createElement('div');
        row.className = 'dev-row';
        const label = document.createElement('span');
        label.className = 'dev-label';
        label.textContent = ctrl.label;
        row.appendChild(label);
        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'dev-color-picker';
        input.id = ctrl.id;
        input.value = ctrl.value;
        row.appendChild(input);
        if (ctrl.note) {
            const note = document.createElement('span');
            note.className = 'dev-value';
            note.style.fontSize = '9px';
            note.style.color = '#888';
            note.textContent = ctrl.note;
            row.appendChild(note);
        }
        return row;
    }
    // {id, label, options: [{value, text}]}
    function buildSelectRow(ctrl) {
        const row = document.createElement('div');
        row.className = 'dev-row';
        const label = document.createElement('span');
        label.className = 'dev-label';
        label.textContent = ctrl.label;
        row.appendChild(label);
        const select = document.createElement('select');
        select.className = 'dev-select';
        select.id = ctrl.id;
        ctrl.options.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.text;
            select.appendChild(option);
        });
        row.appendChild(select);
        return row;
    }
    // {id, label} — checkboxes use an inverted shape vs every other
    // control here (a <label> wraps the checkbox FIRST, then a
    // dev-label span for the text), so this doesn't share the
    // label-first row skeleton the other builders use.
    function buildCheckboxRow(ctrl) {
        const row = document.createElement('div');
        row.className = 'dev-row';
        const wrapLabel = document.createElement('label');
        wrapLabel.style.cssText = 'display:flex; align-items:center; gap:6px; cursor:pointer;';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = ctrl.id;
        wrapLabel.appendChild(input);
        const span = document.createElement('span');
        span.className = 'dev-label';
        span.style.minWidth = 'auto';
        span.textContent = ctrl.label;
        wrapLabel.appendChild(span);
        row.appendChild(wrapLabel);
        return row;
    }
    // {id, label, inputType: 'text'|'number', value, step?, wide?}
    function buildTextInputRow(ctrl) {
        const row = document.createElement('div');
        row.className = 'dev-row';
        const label = document.createElement('span');
        label.className = 'dev-label';
        label.textContent = ctrl.label;
        row.appendChild(label);
        const input = document.createElement('input');
        input.type = ctrl.inputType;
        input.className = 'dev-text-input' + (ctrl.wide ? ' dev-text-input-wide' : '');
        input.id = ctrl.id;
        if (ctrl.inputType === 'number' && ctrl.step !== undefined) input.step = ctrl.step;
        input.value = ctrl.value;
        row.appendChild(input);
        return row;
    }
    const UNIFORM_ROW_BUILDERS = { slider: buildSliderRow, color: buildColorRow, select: buildSelectRow, checkbox: buildCheckboxRow };
    // Dispatches on ctrl.type. Use this for slider/color/select/checkbox
    // controls; call buildTextInputRow(ctrl) directly for text/number
    // inputs (it has its own required fields, not just {type,...}).
    function buildUniformControlRow(ctrl) {
        const builder = UNIFORM_ROW_BUILDERS[ctrl.type];
        if (!builder) {
            console.error('buildUniformControlRow: unknown control type', ctrl.type, ctrl.id);
            const row = document.createElement('div');
            row.className = 'dev-row';
            return row;
        }
        const row = builder(ctrl);
        // Dynamic Mobile/Landscape visibility/independence checkboxes
        // ([JS-4b0] above) - UNIVERSAL as of 2026-09-17 (ported from a
        // real project, CLICKO, that made this same change), applied to
        // every uniform-type control automatically, no opt-in flag
        // needed any more. This is SAFE for a pre-existing control
        // authored the OLD way (3 separate, independently-tuned per-tab
        // array entries) because the checkbox's own DEFAULT state is
        // category-aware (hasStaticDeviceCounterpart(), just above) - a
        // control that already has a real per-tab entry defaults to
        // visible+independent (its exact pre-existing behavior,
        // unchanged unless the checkbox is deliberately toggled); a
        // control that never had one defaults to hidden/mirrors-desktop
        // (also its exact pre-existing behavior). The old `dynamicDevice`
        // opt-in flag is no longer read/required anywhere - a control
        // still carrying it from before this change is harmless (simply
        // ignored). EXCEPTION: `ctrl.skipDeviceCheckbox` opts a control
        // OUT - reserved for this engine's OWN built-in chrome controls
        // (renderDevPanelStyleControls()'s Dev-Panel-self-styling rows,
        // buildMouseLogWidget()'s interval slider), which are NOT part of
        // the registerDevControlArray()/findRegisteredControlById()
        // system this feature's category-aware default relies on, and in
        // the Dev-Panel-style case specifically already have their OWN,
        // separate, pre-existing per-device sync mechanism (devPanelStyle/
        // mobileDevPanelStyle/landscapeDevPanelStyle) that this system
        // would otherwise silently double up with or fight - found live
        // while porting this feature (a Scroll Strength independence
        // checkbox defaulted unchecked because hasStaticDeviceCounterpart()
        // can't see this unregistered system, which would have wired a
        // second, redundant mirror path on top of the existing one). A
        // real project's own controls are unaffected either way - they go
        // through registerDevControlArray(), so the category-aware
        // default is always correct for them.
        if (!ctrl.skipDeviceCheckbox) {
            // row.querySelector (not document.getElementById) - `row`
            // isn't attached to the document yet at this point (whatever
            // called buildUniformControlRow appends it somewhere AFTER
            // it returns), so only a subtree-scoped query finds
            // anything; see wireDesktopMirrorSource()'s own comment.
            const controlEl = row.querySelector('#' + CSS.escape(ctrl.id));
            if (ctrl.tab === 'desktop') row.appendChild(buildVisibilityCheckbox(controlEl, ctrl.id));
            else row.appendChild(buildIndependenceCheckbox(ctrl.tab, resolveDevControlId(ctrl.id).desktopId, controlEl));
        } else {
            // Marks the row itself, not just the (long-gone by the time
            // injectRowDeviceCheckboxes() runs) ctrl object, so that
            // generic backfill pass also respects this exclusion - see
            // its own comment.
            row.dataset.skipDeviceCheckbox = '1';
        }
        return row;
    }

    // ================================================================
    // [JS-7] REGISTRATION API (ARRAYS, VALIDATION, VALUE RESOLVERS)
    // ================================================================
    // Registration: a project calls registerDevControlArray(name, array)
    // once per config array it defines (see the worked example below).
    // This is what powers the generic validation/render-check/save-load
    // machinery without this engine needing to know your array names.
    //
    // WORKED EXAMPLE — a project's own code, NOT part of this template:
    //
    //   const MY_SLIDERS = [
    //     { group: 'Player', id: 'sliderPlayerSpeed', type: 'slider',
    //       label: 'Speed:', min: 0, max: 10, step: 0.1, value: 5 },
    //   ];
    //   function renderMySliders() {
    //     MY_SLIDERS.forEach(ctrl => {
    //       const content = findGroupContent('desktop', ctrl.group, 'renderMySliders', ctrl.id);
    //       if (content) content.appendChild(buildUniformControlRow(ctrl));
    //     });
    //   }
    //   renderMySliders();
    //   registerDevControlArray('MY_SLIDERS', MY_SLIDERS);
    //
    //   // Wire it to your actual game state (this part is inherently
    //   // yours — the engine has no idea what "player speed" means):
    //   document.getElementById('sliderPlayerSpeed').addEventListener('input', (e) => {
    //     myGameState.playerSpeed = parseFloat(e.target.value);
    //     applyPlayerSpeedToGame();
    //   });
    //
    // That's it — Copy/Save/Reset, the render-check tripwire, and (if
    // you also call registerDevControlIdValidator, see below) mapping
    // validation all now cover this control automatically.
    // ----------------------------------------------------------------
    const DEV_PANEL_REGISTERED_ARRAYS = [];
    function registerDevControlArray(name, array) {
        DEV_PANEL_REGISTERED_ARRAYS.push({ name, array });
    }

    // Optional: a project can register its own "is this control id
    // actually wired to something real" checker — (ctrl) => true | a
    // string describing the problem. Without this, validateDevControlMappings()
    // is a no-op (there's nothing generic to check — whether an id is
    // "mapped" depends entirely on your own state shape). Example: if
    // your own project keys its settings by a map like
    // MY_STATE_MAP = { sliderPlayerSpeed: 'playerSpeed' }, register
    // registerDevControlIdValidator(ctrl => (ctrl.id in MY_STATE_MAP)
    // || 'unmapped id: ' + ctrl.id).
    let devControlIdValidator = null;
    function registerDevControlIdValidator(fn) { devControlIdValidator = fn; }
    function validateDevControlMappings() {
        if (!devControlIdValidator) return 0;
        let badCount = 0;
        DEV_PANEL_REGISTERED_ARRAYS.forEach(({ name, array }) => {
            array.forEach(ctrl => {
                const result = devControlIdValidator(ctrl);
                if (result !== true) {
                    console.error('validateDevControlMappings: ' + (typeof result === 'string' ? result : 'unmapped id'), name, ctrl.id);
                    badCount++;
                }
            });
        });
        if (badCount > 0) console.error('validateDevControlMappings: ' + badCount + ' control(s) failed validation - see errors above.');
        return badCount;
    }

    // Load-order tripwire: every control from every registered array
    // must actually exist in the DOM by the time this runs (call it
    // once, near the end of your init sequence, right before your own
    // event-wiring setup — see the init block at the bottom of this
    // file). Catches a render call that's missing, misordered, or
    // whose group lookup silently failed.
    function assertDevControlsRendered() {
        let missing = 0;
        DEV_PANEL_REGISTERED_ARRAYS.forEach(({ array }) => {
            array.forEach(ctrl => { if (!document.getElementById(ctrl.id)) missing++; });
        });
        if (missing > 0) {
            console.error('assertDevControlsRendered: ' + missing + ' generated control(s) missing from the DOM at setup time - a render call may be missing, misordered, or its group lookup failed (see findGroupContent warnings above).');
        }
        return missing;
    }

    // Optional: register (id) => value resolver functions to sync every
    // slider/color's DOM value from YOUR live game state right after
    // render (closes the brief "shows the config array's own literal,
    // not the real live value" flash before any load resolves). Skip
    // this if you're fine relying on the default localStorage load
    // alone (see applyControlValues below) - it's not required.
    let devSliderValueResolver = null;
    let devColorValueResolver = null;
    function registerDevValueResolvers({ slider, color }) {
        if (slider) devSliderValueResolver = slider;
        if (color) devColorValueResolver = color;
    }
    function syncSlidersFromState() {
        if (!devSliderValueResolver) return;
        document.querySelectorAll('.dev-slider').forEach(el => {
            const value = devSliderValueResolver(el.id);
            if (value === undefined) return;
            if (typeof value === 'number') {
                const min = parseFloat(el.min), max = parseFloat(el.max);
                if (!isNaN(max) && value > max) el.max = String(value + Math.abs(value) * 0.2);
                if (!isNaN(min) && value < min) el.min = String(value - Math.abs(value) * 0.2);
            }
            el.value = value;
            // Dispatched, not a direct function call — whatever
            // project-specific 'input' listener you attached (per the
            // worked example above) fires naturally, same as a real drag.
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    function syncColorPickersFromState() {
        if (!devColorValueResolver) return;
        document.querySelectorAll('.dev-color-picker').forEach(el => {
            const value = devColorValueResolver(el.id);
            if (value !== undefined) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
        });
    }

    // ================================================================
    // [JS-7b] STANDARD TEXT SETTINGS
    // ================================================================
    // A drop-in registration for ONE text element's full "standard"
    // settings battery - per CLAUDE.md Section 12p, direct request ("I
    // want it so that if within another project, if I ask... for text
    // settings... the chat will know to provide all these settings
    // without me listing them out" + "include info about how we
    // implemented it... so every project's font settings are coded in
    // the same way"). This is a generalized port of Clicko's own proven,
    // live mechanism (font-size/scale-with-browser blend, edge-lock
    // anchor formula, pixel-art text-shadow border) - Clicko's OWN
    // per-element special cases (a shared 2-state DOM element, a multi-
    // part decomposed element, independent win/lose splits) are its own
    // project-specific layering on TOP of this, not part of the generic
    // version here. The 13 controls this builds are in CLAUDE.md 12p's
    // exact order - do not reorder them without updating 12p to match.
    //
    // NAMING: given a tab ('desktop'/'mobile'/'landscape'), a
    // devicePrefix (''/'Mobile'/'Landscape' - matching [JS-5]'s own
    // convention) and a nameRoot (e.g. 'StartText'), this builds ids
    // like sliderStartTextFontSize / sliderMobileStartTextFontSize /
    // colorStartTextColor / selectStartTextAlign / checkboxStartTextCaps
    // - call it 3x (once per tab, with '' / 'Mobile' / 'Landscape') the
    // same way this file's own DESKTOP/MOBILE/LANDSCAPE_UNIFORM_CONTROLS
    // arrays are 3 separate calls, per CLAUDE.md 12f (spatial/size
    // settings default to independently-tunable per device).
    //
    // ONE SIMPLIFICATION vs. Clicko's own real implementation: Clicko
    // exposes a SEPARATE, independently-tunable "Font Size (vw)" slider
    // alongside "Font Size (px)" (2 controls) so Scale With Browser can
    // blend between 2 hand-tuned values. CLAUDE.md 12p's checklist has
    // only ONE "Font Size" entry, so this version derives the vw-scaled
    // size FROM the one px value instead, relative to a reference
    // viewport width (applyStandardTextElement's own referenceVw
    // parameter, default 1280 - override per element/device, e.g. ~390
    // for a Mobile-tab element, so Scale With Browser doesn't jump the
    // instant it's checked). Add a 2nd, independently-tunable vw slider
    // yourself on top (same pattern as any other control here) if a
    // specific element needs Clicko's finer control - not the default.
    //
    // Border is Clicko's own separate "Border Thickness/Color" ring
    // effect only (buildTextBorderShadow below) - not combined with an
    // extrusion-depth layer the way Clicko's OWN buildCombinedShadow()
    // also supports, since 12p's checklist has no separate "Extrusion
    // Depth" entry. Add that yourself on top the same way if a specific
    // element wants it.
    //
    // "Capitalize" has no Clicko precedent to port - Clicko only ever
    // built this at the DEV-PANEL-CHROME level (the built-in "Dev Panel"
    // group's own 4 Capitalize-*-Text toggles, [CSS-10]/[JS-12] below),
    // never per game-text-element. This is a clean, minimal new
    // implementation (a plain text-transform toggle) for that checklist
    // entry, not a port of an existing mechanism.

    // Simple pixel-art text-stroke via text-shadow - one ring of 8
    // directional offsets at the given thickness, no extrusion depth
    // (unlike Clicko's own buildBorderRingShadow/buildCombinedShadow,
    // which also layer in a depth trail - out of scope here, see this
    // section's own top comment).
    function buildTextBorderShadow(thicknessPx, color) {
        const t = Math.round(thicknessPx);
        if (t <= 0) return 'none';
        const dirs = [[t,0],[-t,0],[0,t],[0,-t],[t,t],[t,-t],[-t,t],[-t,-t]];
        return dirs.map(([dx, dy]) => dx + 'px ' + dy + 'px 0 ' + color).join(', ');
    }
    // Shared by the Horizontal/Vertical Alignment + Edge Lock formula
    // below - same values Clicko's own EDGE_LOCK_BASE/EDGE_LOCK_SIGN/
    // VALIGN_TY use, ported as-is (these are just the 3 anchor points'
    // own %-position and direction-sign, not Clicko-specific).
    const STD_TEXT_EDGE_LOCK_BASE = { left: '0%', top: '0%', center: '50%', right: '100%', bottom: '100%' };
    const STD_TEXT_EDGE_LOCK_SIGN = { left: 1, top: 1, center: 1, right: -1, bottom: -1 };
    const STD_TEXT_VALIGN_TY = { top: '0%', center: '-50%', bottom: '-100%' };

    // {tab, devicePrefix, nameRoot, group, defaults?} -> the 13-control
    // array, in CLAUDE.md 12p's exact order. `defaults` overrides any of
    // {fontSizePx, color, borderThicknessPx, borderColor, letterSpacingPx,
    // lineSpacing, xOffsetVw, yOffsetVh, valign, align, alignEdgeLock,
    // valignEdgeLock, caps, scaleWithBrowser} - only pass what this
    // element's own defaults actually differ on.
    function buildStandardTextSettingsControls(tab, devicePrefix, nameRoot, group, defaults) {
        const d = Object.assign({
            fontSizePx: 24, color: '#ffffff', borderThicknessPx: 0, borderColor: '#000000',
            letterSpacingPx: 0, lineSpacing: 1.2, xOffsetVw: 0, yOffsetVh: 0,
            valign: 'center', align: 'center', alignEdgeLock: 0, valignEdgeLock: 0,
            caps: 0, scaleWithBrowser: 0,
        }, defaults || {});
        const n = (devicePrefix || '') + nameRoot;
        return [
            { tab, group, id: 'slider' + n + 'FontSize', type: 'slider', label: 'Font Size (px):', min: 6, max: 300, step: 1, value: d.fontSizePx },
            { tab, group, id: 'color' + n + 'Color', type: 'color', label: 'Text Color:', value: d.color },
            { tab, group, id: 'slider' + n + 'BorderThickness', type: 'slider', label: 'Border Thickness (px):', min: 0, max: 20, step: 1, value: d.borderThicknessPx },
            { tab, group, id: 'color' + n + 'BorderColor', type: 'color', label: 'Border Color:', value: d.borderColor },
            { tab, group, id: 'slider' + n + 'LetterSpacing', type: 'slider', label: 'Letter Spacing (px):', min: -10, max: 50, step: 0.5, value: d.letterSpacingPx },
            { tab, group, id: 'slider' + n + 'LineSpacing', type: 'slider', label: 'Line Spacing:', min: 0.5, max: 3, step: 0.05, value: d.lineSpacing },
            { tab, group, id: 'slider' + n + 'X', type: 'slider', label: 'X Offset (vw):', min: -50, max: 50, step: 0.1, value: d.xOffsetVw },
            { tab, group, id: 'slider' + n + 'Y', type: 'slider', label: 'Y Offset (vh):', min: -50, max: 50, step: 0.1, value: d.yOffsetVh },
            { tab, group, id: 'select' + n + 'Valign', type: 'select', label: 'Vertical Alignment:', options: [{value:'top',text:'Top'},{value:'center',text:'Center'},{value:'bottom',text:'Bottom'}], value: d.valign },
            { tab, group, id: 'select' + n + 'Align', type: 'select', label: 'Horizontal Alignment:', options: [{value:'left',text:'Left'},{value:'center',text:'Center'},{value:'right',text:'Right'}], value: d.align },
            { tab, group, id: 'checkbox' + n + 'AlignEdgeLock', type: 'checkbox', label: 'Horizontal Edge Lock', value: d.alignEdgeLock },
            { tab, group, id: 'checkbox' + n + 'ValignEdgeLock', type: 'checkbox', label: 'Vertical Edge Lock', value: d.valignEdgeLock },
            { tab, group, id: 'checkbox' + n + 'Caps', type: 'checkbox', label: 'Capitalize', value: d.caps },
            { tab, group, id: 'checkbox' + n + 'ScaleWithBrowser', type: 'checkbox', label: 'Scale With Browser', value: d.scaleWithBrowser },
        ];
    }
    // Renders any UNIFORM_ROW_BUILDERS-shaped array (not just a standard-
    // text-settings one) into its groups AND applies each row's own
    // initial value/checked for select/checkbox types -
    // buildUniformControlRow's own row builders only self-apply `value`
    // for slider/color (see buildSelectRow/buildCheckboxRow's own doc
    // comments); every existing render*Controls() below (e.g.
    // renderDevPanelStyleControls()) repeats that same select/checkbox
    // special-case by hand, per control. This is that same fix, once,
    // generically - use it for a standard-text-settings array OR any
    // other array with select/checkbox controls in it.
    function renderControlArray(array, callerName) {
        array.forEach(ctrl => {
            const content = findGroupContent(ctrl.tab, ctrl.group, callerName || 'renderControlArray', ctrl.id);
            if (!content) return;
            const row = buildUniformControlRow(ctrl);
            content.appendChild(row);
            if (ctrl.type === 'select') row.querySelector('select').value = ctrl.value;
            else if (ctrl.type === 'checkbox') row.querySelector('input').checked = !!ctrl.value;
        });
    }
    // Reads a standard-text-settings control battery straight off its OWN
    // DOM controls (no separate state object - single source of truth is
    // the control itself, same as every other setting in this file) and
    // writes the result as INLINE custom properties on the target
    // element. Deliberately unprefixed property names (--font-size-px,
    // not --startTextFontSize-px) - safe because el.style.setProperty()
    // scopes them to this one element (and its descendants), so 2
    // different standard-text elements never collide even though they
    // use the exact same property names; see this section's own worked-
    // example CSS rule below for how a project's element then reads them.
    // devicePrefix: which device's controls to read ('' / 'Mobile' /
    // 'Landscape') - the CALLER decides which is "active" (your own
    // device-detection, same as every other setting in this file per
    // step 4 of the top-of-file usage note - this file deliberately
    // doesn't invent a generic breakpoint/orientation detector). Call
    // this once on load and again on every one of this element's own
    // 14 controls' input/change event, AND whenever your own active-
    // device state changes (a resize crossing your own breakpoint).
    // referenceVw: the viewport width (px) Font Size's px value is
    // treated as "designed at" for Scale With Browser's blend - see this
    // section's own top comment on why this differs from Clicko's own
    // 2-slider approach; pass your own element's actual typical
    // viewport width per device (e.g. ~1280 desktop, ~390 mobile) so
    // checking the box doesn't visibly jump the size.
    function applyStandardTextElement(nameRoot, elId, devicePrefix, referenceVw) {
        const el = document.getElementById(elId);
        if (!el) return;
        const n = (devicePrefix || '') + nameRoot;
        const ref = referenceVw || 1280;
        const get = (type, suffix) => document.getElementById(type + n + suffix);
        const fontSizeEl = get('slider', 'FontSize');
        const fontSizePx = fontSizeEl ? parseFloat(fontSizeEl.value) : 24;
        const color = get('color', 'Color')?.value || '#ffffff';
        const borderThickness = parseFloat(get('slider', 'BorderThickness')?.value || 0);
        const borderColor = get('color', 'BorderColor')?.value || '#000000';
        const letterSpacing = parseFloat(get('slider', 'LetterSpacing')?.value || 0);
        const lineSpacing = parseFloat(get('slider', 'LineSpacing')?.value || 1.2);
        const xOffset = parseFloat(get('slider', 'X')?.value || 0);
        const yOffset = parseFloat(get('slider', 'Y')?.value || 0);
        const valign = get('select', 'Valign')?.value || 'center';
        const align = get('select', 'Align')?.value || 'center';
        const alignEdgeLock = !!get('checkbox', 'AlignEdgeLock')?.checked;
        const valignEdgeLock = !!get('checkbox', 'ValignEdgeLock')?.checked;
        const caps = !!get('checkbox', 'Caps')?.checked;
        const scaleWithBrowser = !!get('checkbox', 'ScaleWithBrowser')?.checked;

        el.style.setProperty('--font-size-px', fontSizePx);
        el.style.setProperty('--font-size-reference-vw', ref);
        el.style.setProperty('--scale-with-browser', scaleWithBrowser ? 1 : 0);
        el.style.setProperty('--color', color);
        el.style.setProperty('--border-shadow', buildTextBorderShadow(borderThickness, borderColor));
        el.style.setProperty('--letter-spacing-px', letterSpacing);
        el.style.setProperty('--line-spacing', lineSpacing);
        el.style.setProperty('--x-offset', xOffset);
        el.style.setProperty('--y-offset', yOffset);
        el.style.setProperty('--anchor-ty', STD_TEXT_VALIGN_TY[valign] || STD_TEXT_VALIGN_TY.center);
        el.classList.remove('std-text-align-left', 'std-text-align-center', 'std-text-align-right');
        el.classList.add('std-text-align-' + align);
        el.style.setProperty('--x-base', alignEdgeLock ? STD_TEXT_EDGE_LOCK_BASE[align] : '50%');
        el.style.setProperty('--x-sign', alignEdgeLock ? STD_TEXT_EDGE_LOCK_SIGN[align] : 1);
        el.style.setProperty('--x-unit', alignEdgeLock ? '1px' : '1vw');
        el.style.setProperty('--y-base', valignEdgeLock ? STD_TEXT_EDGE_LOCK_BASE[valign] : '50%');
        el.style.setProperty('--y-sign', valignEdgeLock ? STD_TEXT_EDGE_LOCK_SIGN[valign] : 1);
        el.style.setProperty('--y-unit', valignEdgeLock ? '1px' : '1vh');
        el.style.setProperty('--caps', caps ? 'uppercase' : 'none');
    }
    // WORKED EXAMPLE - copy this whole pattern per text element you add:
    //
    //   const START_TEXT_DESKTOP = buildStandardTextSettingsControls('desktop', '', 'StartText', 'Start Button', { fontSizePx: 40 });
    //   const START_TEXT_MOBILE  = buildStandardTextSettingsControls('mobile', 'Mobile', 'StartText', 'Start Button', { fontSizePx: 28 });
    //   const START_TEXT_LANDSCAPE = buildStandardTextSettingsControls('landscape', 'Landscape', 'StartText', 'Start Button', { fontSizePx: 28 });
    //
    //   // Inside ensureDevPanelBuilt() (same placement rule as every
    //   // other render call - see top-of-file usage step 3):
    //   registerDevControlArray('startTextDesktop', START_TEXT_DESKTOP);
    //   registerDevControlArray('startTextMobile', START_TEXT_MOBILE);
    //   registerDevControlArray('startTextLandscape', START_TEXT_LANDSCAPE);
    //   renderControlArray(START_TEXT_DESKTOP, 'startText');
    //   renderControlArray(START_TEXT_MOBILE, 'startText');
    //   renderControlArray(START_TEXT_LANDSCAPE, 'startText');
    //   // Wiring (also inside ensureDevPanelBuilt(), right after the
    //   // render calls above - same placement rule, step 4):
    //   function applyStartText() {
    //       const active = isMobileActive() ? 'Mobile' : (isLandscapeActive() ? 'Landscape' : '');
    //       // your own device detection - see this function's own
    //       // devicePrefix param comment above
    //       applyStandardTextElement('StartText', 'startButtonLabel', active, active === 'Mobile' ? 390 : 1280);
    //   }
    //   [...START_TEXT_DESKTOP, ...START_TEXT_MOBILE, ...START_TEXT_LANDSCAPE].forEach(ctrl => {
    //       const el = document.getElementById(ctrl.id);
    //       if (el) el.addEventListener(ctrl.type === 'checkbox' ? 'change' : 'input', applyStartText);
    //   });
    //   applyStartText(); // once, so it's correct before any control is touched
    //
    //   // Your own CSS rule for #startButtonLabel - copy this verbatim,
    //   // every standard-text element's own rule looks the same:
    //   //   #startButtonLabel {
    //   //     position: absolute;
    //   //     left: calc(var(--x-base, 50%) + var(--x-sign, 1) * var(--x-offset, 0) * var(--x-unit, 1vw));
    //   //     top: calc(var(--y-base, 50%) + var(--y-sign, 1) * var(--y-offset, 0) * var(--y-unit, 1vh));
    //   //     transform: translate(-50%, var(--anchor-ty, -50%));
    //   //     font-size: calc(var(--font-size-px, 24) * 1px * (1 + var(--scale-with-browser, 0) * (100vw / (var(--font-size-reference-vw, 1280) * 1px) - 1)));
    //   //     color: var(--color, #fff);
    //   //     text-shadow: var(--border-shadow, none);
    //   //     letter-spacing: calc(var(--letter-spacing-px, 0) * 1px);
    //   //     line-height: var(--line-spacing, 1.2);
    //   //     text-transform: var(--caps, none);
    //   //   }
    //   //   #startButtonLabel.std-text-align-left { text-align: left; }
    //   //   #startButtonLabel.std-text-align-center { text-align: center; }
    //   //   #startButtonLabel.std-text-align-right { text-align: right; }

    // ================================================================
    // [JS-8] CLICK-TO-EDIT VALUES
    // ================================================================
    // Click-to-type exact value (CLAUDE.md Section 12h) — click a
    // slider's own value readout to type an exact number, including one
    // outside the slider's current range (auto-expands the crossed
    // bound to typed-value ± 20%, so the new value isn't left pinned at
    // the extreme).
    // ----------------------------------------------------------------
    function makeDevValuesEditable() {
        document.querySelectorAll('.dev-value[id]').forEach(valueEl => {
            const sliderId = valueEl.id.replace(/^value/, 'slider');
            const slider = document.getElementById(sliderId);
            if (!slider || slider.type !== 'range') return;
            valueEl.classList.add('dev-value-editable');
        });

        document.addEventListener('click', (e) => {
            const valueEl = e.target.closest('.dev-value-editable');
            if (!valueEl || valueEl.querySelector('input')) return;
            const slider = document.getElementById(valueEl.id.replace(/^value/, 'slider'));
            if (!slider) return;

            const originalText = valueEl.textContent;
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'dev-value-edit-input';
            input.value = slider.value;
            valueEl.textContent = '';
            valueEl.appendChild(input);
            input.focus();
            input.select();

            let settled = false;
            function commit() {
                if (settled) return;
                settled = true;
                let val = parseFloat(input.value);
                if (isNaN(val)) val = parseFloat(slider.value);
                const min = parseFloat(slider.min), max = parseFloat(slider.max);
                if (val > max) slider.max = String(val + Math.abs(val) * 0.2);
                if (val < min) slider.min = String(val - Math.abs(val) * 0.2);
                slider.value = val;
                // Remove the temporary <input> BEFORE dispatching -
                // otherwise the value-readout update your own 'input'
                // listener does (if any) can't repaint this span, since
                // it's still occupied by the (about-to-be-removed) input.
                input.remove();
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
            function cancel() {
                if (settled) return;
                settled = true;
                valueEl.textContent = originalText;
            }
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') input.blur();
                else if (ev.key === 'Escape') cancel();
            });
            input.addEventListener('click', (ev) => ev.stopPropagation());
        });
    }

    // ================================================================
    // [JS-9] TEXT EDIT MODE (GROUP/LABEL RENAME)
    // ================================================================
    // Text Edit Mode — right-click-free inline rename of any group
    // title or setting label. Toggle textEditModeEnabled (a checkbox in
    // the "Dev Panel" built-in group does this by default, see below) to enable.
    // ----------------------------------------------------------------
    let textEditModeEnabled = false;
    let devTextOverrides = {};
    // Tracks which devTextOverrides keys were typed directly into THAT
    // tab, as opposed to carried over automatically by
    // syncTabOrderToDesktop() ([JS-4b] above) - needed so a sync can
    // tell "this Mobile group has never been touched, keep mirroring
    // Desktop's rename" apart from "this Mobile group was deliberately
    // given its own different name, leave it alone" - both look
    // identical as a bare non-null devTextOverrides entry otherwise.
    // Ported from a real project's own dev panel (MAINTENANCE note at
    // the top of this file), which shipped without this the first time
    // and found 2 real bugs as a result: a rename only ever carried
    // over the FIRST time a group synced (the naive "does the target
    // already have an override" check was true forever after that
    // first carry-over, since carrying over IS what set it), and
    // individual row/setting labels never synced at all, only group
    // titles.
    let devTextOverridesManual = new Set();
    const devTextOriginals = {};
    function getDevLabelKey(labelEl) {
        const row = labelEl.closest('.dev-row');
        const control = row ? row.querySelector('[id]') : null;
        return control ? control.id : null;
    }
    function devTextOriginalFor(key, currentText) {
        if (!(key in devTextOriginals)) devTextOriginals[key] = currentText;
        return devTextOriginals[key];
    }
    function applyDevTextOverrides() {
        document.querySelectorAll('.dev-section-title').forEach(titleEl => {
            const key = getSectionKey(titleEl);
            const arrow = titleEl.textContent.slice(0, 2);
            const original = devTextOriginalFor(key, titleEl.textContent.slice(2));
            withPreservedTitleCheckbox(titleEl, () => {
                titleEl.textContent = arrow + (devTextOverrides[key] != null ? devTextOverrides[key] : original);
            });
        });
        document.querySelectorAll('.dev-label').forEach(labelEl => {
            const key = getDevLabelKey(labelEl);
            if (!key) return;
            const original = devTextOriginalFor(key, labelEl.textContent);
            labelEl.textContent = devTextOverrides[key] != null ? devTextOverrides[key] : original;
        });
    }
    function openDevTextEditFor(el, key, isTitle) {
        if (!key || el.querySelector('textarea')) return;
        // A group title created by createDevGroupElement() carries a
        // trailing cascade checkbox as a real DOM child, not just text -
        // detached HERE, before originalHTML is even captured, so it's
        // never part of the wiped/restored markup below at all (an
        // innerHTML round-trip on cancel() would otherwise silently
        // rebuild it as a fresh, listener-less node - see
        // buildGroupCascadeCheckbox()'s own comment). Re-appended (the
        // SAME node, listeners and all) at the end of both commit() and
        // cancel() below.
        const preservedCheckbox = isTitle ? el.querySelector(':scope > .dev-group-cascade-checkbox') : null;
        if (preservedCheckbox) preservedCheckbox.remove();
        const arrow = isTitle ? el.textContent.slice(0, 2) : '';
        const original = devTextOriginalFor(key, isTitle ? el.textContent.slice(2) : el.textContent);
        const currentValue = devTextOverrides[key] != null ? devTextOverrides[key] : original;
        const originalHTML = el.innerHTML;
        const input = document.createElement('textarea');
        input.rows = 1;
        input.value = currentValue;
        el.textContent = '';
        if (isTitle) el.appendChild(document.createTextNode(arrow));
        el.appendChild(input);
        input.focus();
        input.select();
        // Stop this element's own document-level drag-reorder listener
        // from seeing events that originate inside the textarea.
        input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        input.addEventListener('click', (ev) => ev.stopPropagation());
        let settled = false;
        function commit() {
            if (settled) return;
            settled = true;
            const typed = input.value;
            devTextOverrides[key] = (typed === '' || typed === original) ? null : typed;
            // A rename typed directly into THIS element marks it manual
            // (survives future syncTabOrderToDesktop() calls untouched)
            // - clearing it back to the original (null) un-marks it too,
            // so it goes back to mirroring Desktop again - see
            // devTextOverridesManual's own comment above.
            if (devTextOverrides[key] != null) devTextOverridesManual.add(key);
            else devTextOverridesManual.delete(key);
            el.textContent = arrow + (devTextOverrides[key] != null ? devTextOverrides[key] : original);
            if (preservedCheckbox) el.appendChild(preservedCheckbox);
        }
        function cancel() {
            if (settled) return;
            settled = true;
            el.innerHTML = originalHTML;
            if (preservedCheckbox) el.appendChild(preservedCheckbox);
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); input.blur(); }
            else if (ev.key === 'Escape') cancel();
        });
    }
    // Delegated single listener (not one per label) — capture phase +
    // preventDefault so clicking a checkbox row's label text doesn't
    // also toggle the checkbox (native <label> click-through behavior).
    function setupDevPanelTextEdit() {
        devPanel.addEventListener('click', (e) => {
            if (!textEditModeEnabled) return;
            const label = e.target.closest('.dev-label');
            if (!label) return;
            if (label.querySelector('textarea')) return;
            if (sectionJustDragged) { sectionJustDragged = false; return; }
            e.preventDefault();
            e.stopPropagation();
            openDevTextEditFor(label, getDevLabelKey(label), false);
        }, true);
    }

    // ================================================================
    // [JS-10] PANEL MOVE / RESIZE / COLLAPSE / HIDE CHROME
    // ================================================================
    // Panel move/resize/collapse/hide chrome.
    // DEV_PANEL_LAYOUT is this engine's OWN internal state for the
    // panel's position/size — deliberately not tied to any project's
    // settings object, so this engine has zero dependency on how a
    // project stores its state. It's included by default in the
    // localStorage save/load (see saveDevPanelSettings/loadDevPanelSettings
    // below) — a project doing its own save/load instead should persist
    // this object too if it wants the panel to remember where it was.
    // ----------------------------------------------------------------
    const DEV_PANEL_LAYOUT = { left: 20, top: 20, width: 340, height: 520 };
    const DEV_PANEL_HANDLE_OVERHANG_PX = 6;
    // Extra clamp margin from the left/right viewport edge, mobile only
    // — keeps the panel's drag/resize hit-zones off the physical screen
    // edge, where an OS edge-swipe-back gesture can capture a touch
    // before it ever reaches the page.
    const DEV_PANEL_MOBILE_EDGE_GESTURE_MARGIN_PX = 20;
    function devPanelEdgeMarginX() {
        return DEV_PANEL_HANDLE_OVERHANG_PX + (isNarrowViewport() ? DEV_PANEL_MOBILE_EDGE_GESTURE_MARGIN_PX : 0);
    }
    function setDevPanelLayoutVar(key, cssVarName, value) {
        DEV_PANEL_LAYOUT[key] = value;
        document.documentElement.style.setProperty(cssVarName, value);
    }
    function applyDevPanelLayout() {
        document.documentElement.style.setProperty('--dev-panel-left-px', DEV_PANEL_LAYOUT.left);
        document.documentElement.style.setProperty('--dev-panel-top-px', DEV_PANEL_LAYOUT.top);
        document.documentElement.style.setProperty('--dev-panel-width-px', DEV_PANEL_LAYOUT.width);
        document.documentElement.style.setProperty('--dev-panel-height-px', DEV_PANEL_LAYOUT.height);
    }
    function clampDevPanelPosition() {
        const rect = devPanel.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // hidden - nothing to clamp yet
        const o = DEV_PANEL_HANDLE_OVERHANG_PX;
        const ox = devPanelEdgeMarginX();
        const maxLeft = Math.max(ox, window.innerWidth - rect.width - ox);
        const maxTop = Math.max(o, window.innerHeight - rect.height - o);
        const clampedLeft = Math.min(Math.max(ox, DEV_PANEL_LAYOUT.left), maxLeft);
        const clampedTop = Math.min(Math.max(o, DEV_PANEL_LAYOUT.top), maxTop);
        if (clampedLeft !== DEV_PANEL_LAYOUT.left) setDevPanelLayoutVar('left', '--dev-panel-left-px', clampedLeft);
        if (clampedTop !== DEV_PANEL_LAYOUT.top) setDevPanelLayoutVar('top', '--dev-panel-top-px', clampedTop);
    }

    const devPanelHeader = document.getElementById('devPanelHeader');
    let isDraggingDevPanel = false;
    let devPanelDragStart = { pointerX: 0, pointerY: 0, panelLeft: 0, panelTop: 0 };
    devPanelHeader.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return; // Collapse/Hide keep their own click behavior
        e.preventDefault();
        const rect = devPanel.getBoundingClientRect();
        devPanelDragStart = { pointerX: e.clientX, pointerY: e.clientY, panelLeft: rect.left, panelTop: rect.top };
        isDraggingDevPanel = true;
        devPanelHeader.classList.add('dragging');
        try { devPanelHeader.setPointerCapture(e.pointerId); } catch (err) { /* best-effort only */ }
    });
    document.addEventListener('pointermove', (e) => {
        if (!isDraggingDevPanel) return;
        // Recovery for a dropped gesture (a touch-drag whose pointerdown
        // fired but no further pointermove/up/cancel ever arrived) -
        // without this, isDraggingDevPanel gets stuck true forever,
        // which would break every subsequent pointer interaction (this
        // flag unconditionally gates this handler).
        if (e.buttons === 0) { endDevPanelDrag(e); return; }
        const dx = e.clientX - devPanelDragStart.pointerX;
        const dy = e.clientY - devPanelDragStart.pointerY;
        const panelRect = devPanel.getBoundingClientRect();
        const o = DEV_PANEL_HANDLE_OVERHANG_PX;
        const ox = devPanelEdgeMarginX();
        const newLeft = Math.max(ox, Math.min(window.innerWidth - panelRect.width - ox, devPanelDragStart.panelLeft + dx));
        const newTop = Math.max(o, Math.min(window.innerHeight - panelRect.height - o, devPanelDragStart.panelTop + dy));
        setDevPanelLayoutVar('left', '--dev-panel-left-px', Math.round(newLeft));
        setDevPanelLayoutVar('top', '--dev-panel-top-px', Math.round(newTop));
    });
    function endDevPanelDrag(e) {
        if (!isDraggingDevPanel) return;
        isDraggingDevPanel = false;
        devPanelHeader.classList.remove('dragging');
        if (e && e.pointerId !== undefined && devPanelHeader.hasPointerCapture(e.pointerId)) {
            devPanelHeader.releasePointerCapture(e.pointerId);
        }
    }
    document.addEventListener('pointerup', endDevPanelDrag);
    document.addEventListener('pointercancel', endDevPanelDrag);
    // lostpointercapture fires whenever the browser/OS revokes capture
    // for any reason (including a native gesture recognizer stepping in
    // mid-touch) - a more direct signal than waiting for pointerup/
    // pointercancel, which can both simply never arrive.
    devPanelHeader.addEventListener('lostpointercapture', endDevPanelDrag);

    function toggleDevPanelCollapsed() {
        const collapsed = devPanel.classList.toggle('panel-collapsed');
        document.getElementById('devCollapseBtn').textContent = collapsed ? '▢' : '▁';
        if (collapsed) {
            const headerHeight = devPanelHeader.getBoundingClientRect().height;
            const panelPadding = parseFloat(getComputedStyle(devPanel).paddingTop) + parseFloat(getComputedStyle(devPanel).paddingBottom);
            devPanel.style.setProperty('height', (headerHeight + panelPadding) + 'px', 'important');
        } else {
            devPanel.style.removeProperty('height');
        }
    }

    // Custom resize handles (native CSS `resize` isn't reliably touch-
    // draggable). Generic factory, not 8 near-duplicate handlers -
    // xEdge/yEdge say which side(s) this handle moves. 'right'/'bottom'
    // grow from the fixed opposite side; 'left'/'top' also shift the
    // panel's own left/top by however much the size changed (post-
    // clamp), so the OPPOSITE edge stays visually fixed, matching how
    // an OS window resize behaves. `setLeftTop(key, value)` (optional,
    // 2026-09-19 - added for the Undock feature's own floating panels,
    // see createUndockPanel()) lets a caller other than the main dev
    // panel persist a left/top change its OWN way - defaults to the
    // original devPanel-specific CSS-custom-property behavior when
    // omitted, so every existing call site (the main panel's own 8
    // handles) is completely unaffected by this generalization.
    function setupPanelResizeHandle(panel, handle, xEdge, yEdge, setLeftTop) {
        setLeftTop = setLeftTop || ((key, value) => setDevPanelLayoutVar(key, '--dev-panel-' + key + '-px', value));
        let dragging = false;
        let start = { pointerX: 0, pointerY: 0, left: 0, top: 0, width: 0, height: 0 };

        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            start = { pointerX: e.clientX, pointerY: e.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            dragging = true;
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* best-effort only */ }
        });

        document.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            if (e.buttons === 0) { end(e); return; }
            const cs = getComputedStyle(panel);
            const minW = parseFloat(cs.minWidth) || 0, maxW = parseFloat(cs.maxWidth) || Infinity;
            const minH = parseFloat(cs.minHeight) || 0, maxH = parseFloat(cs.maxHeight) || Infinity;
            const dx = e.clientX - start.pointerX;
            const dy = e.clientY - start.pointerY;

            let newWidth = start.width, newLeft = start.left;
            if (xEdge === 'right') {
                newWidth = Math.max(minW, Math.min(maxW, start.width + dx));
                const maxWidthFromEdge = window.innerWidth - start.left - devPanelEdgeMarginX();
                newWidth = Math.min(newWidth, Math.max(minW, maxWidthFromEdge));
            } else if (xEdge === 'left') {
                newWidth = Math.max(minW, Math.min(maxW, start.width - dx));
                newLeft = start.left + (start.width - newWidth);
                const clampedLeft = Math.max(devPanelEdgeMarginX(), newLeft);
                if (clampedLeft !== newLeft) { newWidth = newWidth - (clampedLeft - newLeft); newLeft = clampedLeft; }
            }
            let newHeight = start.height, newTop = start.top;
            if (yEdge === 'bottom') {
                newHeight = Math.max(minH, Math.min(maxH, start.height + dy));
            } else if (yEdge === 'top') {
                newHeight = Math.max(minH, Math.min(maxH, start.height - dy));
                newTop = start.top + (start.height - newHeight);
                const clampedTop = Math.max(DEV_PANEL_HANDLE_OVERHANG_PX, newTop);
                if (clampedTop !== newTop) { newHeight = newHeight - (clampedTop - newTop); newTop = clampedTop; }
            }

            panel.style.width = newWidth + 'px';
            panel.style.height = newHeight + 'px';
            // NOT also panel.style.left/top for the right/bottom-only
            // case - a direct inline write there would permanently
            // shadow the CSS rule (left: calc(var(--dev-panel-left-px)
            // * 1px)) regardless of the custom property's later value,
            // which would silently break the header drag-to-move
            // afterward. setProperty() below already re-renders the
            // position immediately for the left/top-moving cases.
            if (xEdge === 'left') setLeftTop('left', Math.round(newLeft));
            if (yEdge === 'top') setLeftTop('top', Math.round(newTop));
        });

        function end(e) {
            if (!dragging) return;
            dragging = false;
            if (e && e.pointerId !== undefined && handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        }
        document.addEventListener('pointerup', end);
        document.addEventListener('pointercancel', end);
        handle.addEventListener('lostpointercapture', end);
    }

    // ================================================================
    // [JS-11] TAB SWITCHING
    // ================================================================
    // Tab switching. Mobile/Landscape's own group/setting order always
    // mirrors Desktop's CURRENT order the moment that tab is opened -
    // see syncTabOrderToDesktop()'s own comment ([JS-4b] above). Runs
    // BEFORE the 'hidden' class toggle below so the tab's content is
    // already in its correct order the instant it becomes visible, not
    // reordering visibly after the fact.
    function switchDevPanelTab(tab) {
        syncTabOrderToDesktop(tab);
        // Re-syncs checkbox .checked display, group cascade indeterminate
        // display, and empty-group hiding for whichever tab is about to
        // show - state can change while a tab isn't active, and none of
        // that is otherwise guaranteed to have refreshed THIS tab's own
        // display yet. Ported from CLICKO, direct request: "the checkboxes
        // for groups and settings in different tabs should also auto
        // update appropriately."
        if (devPanelBuilt) {
            syncDeviceCheckboxesFromState();
            if (tab === 'mobile' || tab === 'landscape') refreshEmptyGroupVisibility(tab);
            refreshAllGroupCascadeCheckboxes();
        }
        DEV_PANEL_TABS.forEach(t => {
            document.getElementById(t + 'TabContent').classList.toggle('hidden', t !== tab);
            const btn = document.getElementById('devTab' + t[0].toUpperCase() + t.slice(1) + 'Btn');
            if (btn) btn.classList.toggle('active', t === tab);
        });
        // The panel's OWN styling (below) is independent per tab, not
        // tied to the real device viewport - re-apply whichever tab's
        // own saved look now that it's the one showing.
        applyDevPanelOwnStyling(tab);
    }

    // ================================================================
    // [JS-12] BUILT-IN "DEV PANEL" SELF-STYLING GROUP
    // ================================================================
    // Built-in "Dev Panel" self-styling group (CLAUDE.md Section 12i) -
    // font sizes/colors/opacity/capitalize-toggles for the PANEL'S OWN
    // text, independent of the actual game. Fully generic - not tied to
    // any project's settings.
    // ----------------------------------------------------------------
    // Defaults below are this template's own deliberately-tuned,
    // lived-with starting look (a blue accent, Verdana, capitalized
    // button/tab/group text) rather than arbitrary placeholder values -
    // change them freely, this is just a sensible starting point.
    const devPanelStyle = {
        titleFontSize: 17, tabFontSize: 12, groupTitleFontSize: 14, settingTitleFontSize: 12,
        buttonTextBorder: 0, scrollStrength: 0.2, opacity: 1,
        bgColor: '#000000', titleTextColor: '#ffffff', nonTitleTextColor: '#ffffff',
        accentColor: '#005f8f', sliderColor: '#ffffff', fontFamily: 'Helvetica, Arial, sans-serif',
        capsButtonText: true, capsTabText: true, capsGroupNames: true, capsSettingsText: false,
        buttonTextLetterSpacing: 0, tabTextLetterSpacing: 0, groupTextLetterSpacing: 0.8, settingsTextLetterSpacing: 0,
        buttonHeight: 21, valueFontSize: 12,
        // Also drives the "+ Add Group" button's own background (styled
        // like a tab button otherwise - see .dev-add-group-btn) so both
        // stay visually tied to the same color, per direct request.
        groupLabelBgColor: '#005f8f',
        // Added 2026-09-14, porting Clicko's own current Dev Panel group
        // as this template's new standard (direct request: "our current
        // Dev Panel settings will be the standard") - the per-category
        // Title/Group/Settings/Tab/Button text battery (Bold, Capitalize,
        // Letter Spacing, Line Spacing, Text Color) plus Button Font Size
        // and Title's own Letter Spacing/Line Spacing. Boolean defaults
        // (titleBold/tabBold/buttonBold/groupBold true, settingsBold/
        // titleCapitalize false) match Clicko's own current live values
        // exactly. Corrected 2026-09-14 (2nd pass, direct request "I want
        // you to set the color fields as defaults... our settings should
        // be default"): every color above (accentColor/sliderColor/
        // groupLabelBgColor here, groupTextColor/buttonTextColor/
        // settingNumberColor/tabTextColor below) now matches Clicko's own
        // real, live-fetched current values exactly too, superseding this
        // comment's own earlier "follow the template's own palette
        // instead" reasoning - re-fetched fresh rather than reused from
        // memory, since colors had already drifted from what an earlier
        // pass in this same session once read (tabTextColor, in
        // particular, had changed from black to white since).
        titleLetterSpacing: 2.3, titleLineHeight: 1.2, tabLineHeight: 1.2, buttonLineHeight: 1.2, settingsLineHeight: 1.2, groupLineHeight: 1.2,
        buttonFontSize: 10,
        titleBold: true, tabBold: true, buttonBold: true, settingsBold: false, groupBold: true, titleCapitalize: false,
        groupTextColor: '#ffffff', buttonTextColor: '#ffffff', settingNumberColor: '#5cc9ff', tabTextColor: '#ffffff',
    };
    const mobileDevPanelStyle = { ...devPanelStyle };
    const landscapeDevPanelStyle = { ...devPanelStyle };
    const DEV_PANEL_STYLE_VAR_MAP = {
        titleFontSize: '--dev-panel-title-font-size-px', tabFontSize: '--dev-tab-font-size-px',
        groupTitleFontSize: '--dev-group-title-font-size-px', settingTitleFontSize: '--dev-setting-title-font-size-px',
        buttonTextBorder: '--dev-button-text-border-px', scrollStrength: '--dev-scroll-strength',
        opacity: '--dev-panel-opacity', bgColor: '--dev-panel-bg-color', titleTextColor: '--dev-panel-title-text-color',
        nonTitleTextColor: '--dev-panel-non-title-text-color', accentColor: '--dev-accent-color', sliderColor: '--dev-slider-color',
        fontFamily: '--dev-panel-font-family', buttonHeight: '--dev-button-height-px',
        buttonTextLetterSpacing: '--dev-button-text-letter-spacing-px', tabTextLetterSpacing: '--dev-tab-text-letter-spacing-px',
        groupTextLetterSpacing: '--dev-group-text-letter-spacing-px', settingsTextLetterSpacing: '--dev-settings-text-letter-spacing-px',
        valueFontSize: '--dev-value-font-size-px', groupLabelBgColor: '--dev-group-label-bg-color',
        // Added 2026-09-14, porting Clicko's own current Dev Panel group.
        titleLetterSpacing: '--dev-panel-title-letter-spacing-px', titleLineHeight: '--dev-panel-title-line-height',
        tabLineHeight: '--dev-tab-line-height', buttonLineHeight: '--dev-button-text-line-height',
        settingsLineHeight: '--dev-settings-line-height', groupLineHeight: '--dev-group-text-line-height',
        buttonFontSize: '--dev-button-text-font-size-px',
        groupTextColor: '--dev-panel-group-text-color', buttonTextColor: '--dev-panel-button-text-color',
        settingNumberColor: '--dev-value-text-color', tabTextColor: '--dev-tab-text-color',
    };
    // Opacity/colors/font/caps toggles are desktop-only by default
    // (always resolve from devPanelStyle regardless of active tab) -
    // font sizes and button height stay genuinely per-tab. This mirrors
    // CLAUDE.md Section 12f: cosmetic/non-spatial settings default to
    // shared across tabs, spatial/size settings default to independent.
    // groupLabelBgColor is a color, not a size - shared, like every other
    // color here. valueFontSize stays OUT of this list deliberately - a
    // real size, per-tab like every other font size above.
    // Added 2026-09-14 to the shared-keys list: groupTextColor/buttonTextColor/
    // settingNumberColor/tabTextColor (colors - same "desktop-only cosmetic"
    // bucket as every other color here) and titleBold/tabBold/buttonBold/
    // settingsBold/groupBold/titleCapitalize (booleans - same bucket as the
    // 4 existing caps toggles). Matches Clicko's own current Dev Panel group.
    const DEV_PANEL_STYLE_SHARED_KEYS = ['opacity', 'bgColor', 'titleTextColor', 'nonTitleTextColor', 'accentColor', 'sliderColor', 'fontFamily', 'capsButtonText', 'capsTabText', 'capsGroupNames', 'capsSettingsText', 'buttonTextLetterSpacing', 'tabTextLetterSpacing', 'groupTextLetterSpacing', 'settingsTextLetterSpacing', 'groupLabelBgColor', 'groupTextColor', 'buttonTextColor', 'settingNumberColor', 'tabTextColor', 'titleBold', 'tabBold', 'buttonBold', 'settingsBold', 'groupBold', 'titleCapitalize'];
    const DEV_PANEL_CAPS_CLASS_MAP = {
        capsButtonText: 'dev-caps-button-text', capsTabText: 'dev-caps-tab-text',
        capsGroupNames: 'dev-caps-group-names', capsSettingsText: 'dev-caps-settings-text',
        titleCapitalize: 'dev-caps-title-text', titleBold: 'dev-bold-title',
        tabBold: 'dev-bold-tab', buttonBold: 'dev-bold-button',
        settingsBold: 'dev-bold-settings', groupBold: 'dev-bold-group',
    };
    function applyDevPanelOwnStyling(tab) {
        const style = tab === 'desktop' ? devPanelStyle : tab === 'mobile' ? mobileDevPanelStyle : landscapeDevPanelStyle;
        for (const [key, varName] of Object.entries(DEV_PANEL_STYLE_VAR_MAP)) {
            const value = DEV_PANEL_STYLE_SHARED_KEYS.includes(key) ? devPanelStyle[key] : style[key];
            document.documentElement.style.setProperty(varName, value);
        }
        for (const [key, className] of Object.entries(DEV_PANEL_CAPS_CLASS_MAP)) {
            devPanel.classList.toggle(className, !!devPanelStyle[key]);
        }
    }

    const DEVPANEL_STYLE_CONTROLS = (() => {
        const perTab = (tab, idPrefix, sharedOnly) => {
            const rows = [
                { tab, group: 'Dev Panel', id: idPrefix + 'TitleFontSize', type: 'slider', label: 'Title Font Size (px):', min: 6, max: 30, step: 1, value: 17 },
                { tab, group: 'Dev Panel', id: idPrefix + 'TabFontSize', type: 'slider', label: 'Tab Font Size (px):', min: 6, max: 30, step: 1, value: 12 },
                { tab, group: 'Dev Panel', id: idPrefix + 'GroupTitleFontSize', type: 'slider', label: 'Group Title Font Size (px):', min: 6, max: 30, step: 1, value: 14 },
                { tab, group: 'Dev Panel', id: idPrefix + 'SettingTitleFontSize', type: 'slider', label: 'Setting Title Font Size (px):', min: 6, max: 30, step: 1, value: 12 },
                { tab, group: 'Dev Panel', id: idPrefix + 'ButtonTextBorder', type: 'slider', label: 'Button Text Border (px):', min: 0, max: 20, step: 1, value: 0 },
                { tab, group: 'Dev Panel', id: idPrefix + 'ScrollStrength', type: 'slider', label: 'Dev Panel Scroll Strength (x):', min: 0.2, max: 5, step: 0.1, value: 0.2 },
                { tab, group: 'Dev Panel', id: idPrefix + 'ButtonHeight', type: 'slider', label: 'Button Height (px):', min: 12, max: 60, step: 1, value: 21 },
                { tab, group: 'Dev Panel', id: idPrefix + 'ValueFontSize', type: 'slider', label: 'Setting Number Font Size (px):', min: 6, max: 30, step: 1, value: 12 },
                { tab, group: 'Dev Panel', id: idPrefix + 'TitleLetterSpacing', type: 'slider', label: 'Dev Panel Title Letter Spacing (px):', min: -2, max: 10, step: 0.1, value: 2.3 },
                { tab, group: 'Dev Panel', id: idPrefix + 'TitleLineHeight', type: 'slider', label: 'Dev Panel Title Line Spacing (x):', min: 0.8, max: 3, step: 0.05, value: 1.2 },
                { tab, group: 'Dev Panel', id: idPrefix + 'TabLineHeight', type: 'slider', label: 'Tab Line Spacing (x):', min: 0.8, max: 3, step: 0.05, value: 1.2 },
                { tab, group: 'Dev Panel', id: idPrefix + 'GroupLineHeight', type: 'slider', label: 'Group Text Line Spacing (x):', min: 0.8, max: 3, step: 0.05, value: 1.2 },
                { tab, group: 'Dev Panel', id: idPrefix + 'SettingsLineHeight', type: 'slider', label: 'Settings Text Line Spacing (x):', min: 0.8, max: 3, step: 0.05, value: 1.2 },
                { tab, group: 'Dev Panel', id: idPrefix + 'ButtonLineHeight', type: 'slider', label: 'Button Text Line Spacing (x):', min: 0.8, max: 3, step: 0.05, value: 1.2 },
                { tab, group: 'Dev Panel', id: idPrefix + 'ButtonFontSize', type: 'slider', label: 'Button Text Font Size (px):', min: 6, max: 30, step: 1, value: 10 },
            ];
            if (sharedOnly) return rows;
            return [
                ...rows,
                { tab, group: 'Dev Panel', id: idPrefix + 'Opacity', type: 'slider', label: 'Opacity:', min: 0.1, max: 1, step: 0.01, value: 1 },
                { tab, group: 'Dev Panel', id: 'colorDevPanelBg', type: 'color', label: 'Background Color:', value: '#000000' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelTitleText', type: 'color', label: 'Title Text Color:', value: '#ffffff' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelNonTitleText', type: 'color', label: 'Settings Title Text Color:', value: '#ffffff' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelAccent', type: 'color', label: 'Accent Color (Buttons/UI):', value: '#005f8f' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelSliderColor', type: 'color', label: 'Slider Color:', value: '#ffffff' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelGroupLabelBg', type: 'color', label: 'Group Label Background Color:', value: '#005f8f' },
                { tab, group: 'Dev Panel', id: 'selectDevPanelFontFamily', type: 'select', label: 'Font (All Text):', options: [
                    { value: 'monospace', text: 'Monospace' }, { value: 'Arial, Helvetica, sans-serif', text: 'Arial' },
                    // Matches Clicko's own current live fontFamily value exactly
                    // (Clicko is the Gold Standard for this group's defaults -
                    // CLAUDE.md §12i) - kept as its own option rather than
                    // reusing the pre-existing 'Arial, Helvetica, sans-serif'
                    // entry above, since the font STACK ORDER differs and the
                    // select's value must match devPanelStyle.fontFamily
                    // byte-for-byte for the initial selection to resolve
                    // correctly (added 2026-09-14).
                    { value: 'Helvetica, Arial, sans-serif', text: 'Helvetica' },
                    { value: "'Segoe UI', Arial, sans-serif", text: 'Segoe UI' }, { value: 'Verdana, Geneva, sans-serif', text: 'Verdana' },
                    { value: "'Trebuchet MS', Arial, sans-serif", text: 'Trebuchet MS' }, { value: 'Calibri, Arial, sans-serif', text: 'Calibri' },
                ] },
                { tab, group: 'Dev Panel', id: 'checkboxDevCapsButtonText', type: 'checkbox', label: 'Capitalize Button Text' },
                { tab, group: 'Dev Panel', id: 'checkboxDevCapsTabText', type: 'checkbox', label: 'Capitalize Tab Text' },
                { tab, group: 'Dev Panel', id: 'checkboxDevCapsGroupNames', type: 'checkbox', label: 'Capitalize Group Names' },
                { tab, group: 'Dev Panel', id: 'checkboxDevCapsSettingsText', type: 'checkbox', label: 'Capitalize Settings Text' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelGroupText', type: 'color', label: 'Group Text Color:', value: '#ffffff' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelButtonText', type: 'color', label: 'Button Text Color:', value: '#ffffff' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelSettingNumber', type: 'color', label: 'Setting Number Text Color:', value: '#5cc9ff' },
                { tab, group: 'Dev Panel', id: 'colorDevPanelTabText', type: 'color', label: 'Tab Text Color:', value: '#ffffff' },
                { tab, group: 'Dev Panel', id: 'sliderDevTabTextLetterSpacing', type: 'slider', label: 'Tab Letter Spacing (px):', min: -2, max: 10, step: 0.1, value: 0 },
                { tab, group: 'Dev Panel', id: 'sliderDevGroupTextLetterSpacing', type: 'slider', label: 'Group Letter Spacing (px):', min: -2, max: 10, step: 0.1, value: 0.8 },
                { tab, group: 'Dev Panel', id: 'sliderDevSettingsTextLetterSpacing', type: 'slider', label: 'Settings Letter Spacing (px):', min: -2, max: 10, step: 0.1, value: 0 },
                { tab, group: 'Dev Panel', id: 'sliderDevButtonTextLetterSpacing', type: 'slider', label: 'Buttons Letter Spacing (px):', min: -2, max: 10, step: 0.1, value: 0 },
                { tab, group: 'Dev Panel', id: 'checkboxDevCapsTitleText', type: 'checkbox', label: 'Capitalize Title' },
                { tab, group: 'Dev Panel', id: 'checkboxDevBoldTitle', type: 'checkbox', label: 'Bold Title' },
                { tab, group: 'Dev Panel', id: 'checkboxDevBoldGroup', type: 'checkbox', label: 'Bold Group Text' },
                { tab, group: 'Dev Panel', id: 'checkboxDevBoldSettings', type: 'checkbox', label: 'Bold Settings Text' },
                { tab, group: 'Dev Panel', id: 'checkboxDevBoldTab', type: 'checkbox', label: 'Bold Tab' },
                { tab, group: 'Dev Panel', id: 'checkboxDevBoldButton', type: 'checkbox', label: 'Bold Button' },
            ];
        };
        return [
            ...perTab('desktop', 'sliderDevPanel', false),
            ...perTab('mobile', 'sliderMobileDevPanel', true),
            ...perTab('landscape', 'sliderLandscapeDevPanel', true),
        ];
    })();
    // Select/checkbox rows (font family, the 4 caps toggles, text-edit
    // mode) don't have their own `.dev-select`/`.dev-color-picker`-style
    // generic post-render sync (syncSlidersFromState/syncColorPickersFromState
    // only cover sliders/colors) - synced here, once, right after each
    // is built, so their initial DOM state actually matches devPanelStyle's
    // real defaults instead of silently falling back to "first option"/
    // "unchecked" on a fresh load.
    const DEV_PANEL_CAPS_CHECKBOX_KEYS = {
        checkboxDevCapsButtonText: 'capsButtonText', checkboxDevCapsTabText: 'capsTabText',
        checkboxDevCapsGroupNames: 'capsGroupNames', checkboxDevCapsSettingsText: 'capsSettingsText',
        checkboxDevCapsTitleText: 'titleCapitalize', checkboxDevBoldTitle: 'titleBold',
        checkboxDevBoldTab: 'tabBold', checkboxDevBoldButton: 'buttonBold',
        checkboxDevBoldSettings: 'settingsBold', checkboxDevBoldGroup: 'groupBold',
    };
    // Hoisted out of setupDevPanelStyleControls() (which still owns
    // WIRING the change listeners) so syncDevPanelStyleControlsFromState()
    // below can reuse the exact same id/key mapping for the opposite
    // direction (state -> DOM) without a 2nd, drift-prone copy of it.
    const DEV_PANEL_STYLE_SLIDER_KEYS = [
        ['titleFontSize', 'sliderDevPanelTitleFontSize', 'sliderMobileDevPanelTitleFontSize', 'sliderLandscapeDevPanelTitleFontSize'],
        ['tabFontSize', 'sliderDevPanelTabFontSize', 'sliderMobileDevPanelTabFontSize', 'sliderLandscapeDevPanelTabFontSize'],
        ['groupTitleFontSize', 'sliderDevPanelGroupTitleFontSize', 'sliderMobileDevPanelGroupTitleFontSize', 'sliderLandscapeDevPanelGroupTitleFontSize'],
        ['settingTitleFontSize', 'sliderDevPanelSettingTitleFontSize', 'sliderMobileDevPanelSettingTitleFontSize', 'sliderLandscapeDevPanelSettingTitleFontSize'],
        ['buttonTextBorder', 'sliderDevPanelButtonTextBorder', 'sliderMobileDevPanelButtonTextBorder', 'sliderLandscapeDevPanelButtonTextBorder'],
        ['scrollStrength', 'sliderDevPanelScrollStrength', 'sliderMobileDevPanelScrollStrength', 'sliderLandscapeDevPanelScrollStrength'],
        ['buttonHeight', 'sliderDevPanelButtonHeight', 'sliderMobileDevPanelButtonHeight', 'sliderLandscapeDevPanelButtonHeight'],
        ['valueFontSize', 'sliderDevPanelValueFontSize', 'sliderMobileDevPanelValueFontSize', 'sliderLandscapeDevPanelValueFontSize'],
        // Added 2026-09-14, porting Clicko's own current Dev Panel group.
        ['titleLetterSpacing', 'sliderDevPanelTitleLetterSpacing', 'sliderMobileDevPanelTitleLetterSpacing', 'sliderLandscapeDevPanelTitleLetterSpacing'],
        ['titleLineHeight', 'sliderDevPanelTitleLineHeight', 'sliderMobileDevPanelTitleLineHeight', 'sliderLandscapeDevPanelTitleLineHeight'],
        ['tabLineHeight', 'sliderDevPanelTabLineHeight', 'sliderMobileDevPanelTabLineHeight', 'sliderLandscapeDevPanelTabLineHeight'],
        ['groupLineHeight', 'sliderDevPanelGroupLineHeight', 'sliderMobileDevPanelGroupLineHeight', 'sliderLandscapeDevPanelGroupLineHeight'],
        ['settingsLineHeight', 'sliderDevPanelSettingsLineHeight', 'sliderMobileDevPanelSettingsLineHeight', 'sliderLandscapeDevPanelSettingsLineHeight'],
        ['buttonLineHeight', 'sliderDevPanelButtonLineHeight', 'sliderMobileDevPanelButtonLineHeight', 'sliderLandscapeDevPanelButtonLineHeight'],
        ['buttonFontSize', 'sliderDevPanelButtonFontSize', 'sliderMobileDevPanelButtonFontSize', 'sliderLandscapeDevPanelButtonFontSize'],
    ];
    const DEV_PANEL_STYLE_COLOR_KEYS = [
        ['bgColor', 'colorDevPanelBg'], ['titleTextColor', 'colorDevPanelTitleText'], ['nonTitleTextColor', 'colorDevPanelNonTitleText'],
        ['accentColor', 'colorDevPanelAccent'], ['sliderColor', 'colorDevPanelSliderColor'], ['groupLabelBgColor', 'colorDevPanelGroupLabelBg'],
        ['groupTextColor', 'colorDevPanelGroupText'], ['buttonTextColor', 'colorDevPanelButtonText'],
        ['settingNumberColor', 'colorDevPanelSettingNumber'], ['tabTextColor', 'colorDevPanelTabText'],
    ];
    // Restores every Dev-Panel-style control's own DOM state (slider
    // handle position + its .dev-value readout, color picker swatch,
    // font <select>, every checkbox) from devPanelStyle/mobile.../
    // landscape... - a real, pre-existing gap found while building
    // [JS-13b]: applyDevPanelOwnStyling() only ever pushes these into
    // CSS custom properties, never into the CONTROLS' own DOM (confirmed
    // live - Reset, and now Use/Set-as-Default, changed the panel's
    // actual rendered look correctly but left every Dev-Panel-style
    // slider/color/checkbox showing its PRE-reset position/value until
    // separately touched). Call this anywhere devPanelStyle-family state
    // just changed out from under the DOM (applyFullDevPanelState()
    // below) - safe to call even before the panel's been built at all
    // (ensureDevPanelBuilt() lazy-build), since every lookup here already
    // no-ops on a missing element.
    function syncDevPanelStyleControlsFromState() {
        DEV_PANEL_STYLE_SLIDER_KEYS.forEach(([key, deskId, mobId, landId]) => {
            [[deskId, devPanelStyle], [mobId, mobileDevPanelStyle], [landId, landscapeDevPanelStyle]].forEach(([id, store]) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.value = store[key];
                const valEl = document.getElementById(id.replace('slider', 'value'));
                if (valEl && !valEl.querySelector('input')) valEl.textContent = el.value;
            });
        });
        // Opacity is shared/desktop-only (see DEV_PANEL_STYLE_SHARED_KEYS)
        // and wired as its own standalone case in setupDevPanelStyleControls()
        // - never part of the per-tab DEV_PANEL_STYLE_SLIDER_KEYS loop above,
        // so it needs the same standalone treatment here too.
        const opacityEl = document.getElementById('sliderDevPanelOpacity');
        if (opacityEl) {
            opacityEl.value = devPanelStyle.opacity;
            const valEl = document.getElementById('valueDevPanelOpacity');
            if (valEl && !valEl.querySelector('input')) valEl.textContent = opacityEl.value;
        }
        DEV_PANEL_STYLE_COLOR_KEYS.forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (el) el.value = devPanelStyle[key];
        });
        const fontEl = document.getElementById('selectDevPanelFontFamily');
        if (fontEl) fontEl.value = devPanelStyle.fontFamily;
        Object.entries(DEV_PANEL_CAPS_CHECKBOX_KEYS).forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!devPanelStyle[key];
        });
        // Text Edit Mode's own visual sync moved to
        // setupDevHeaderIconButtons() (it's a header icon button now, not
        // a checkbox rendered by this function).
    }
    function renderDevPanelStyleControls() {
        DEVPANEL_STYLE_CONTROLS.forEach(ctrl => {
            const content = findGroupContent(ctrl.tab, ctrl.group, 'renderDevPanelStyleControls', ctrl.id);
            if (!content) return;
            // skipDeviceCheckbox: true - see buildUniformControlRow()'s
            // own comment for why the Dev-Panel-self-styling system is
            // excluded from the universal checkbox feature.
            const row = buildUniformControlRow(Object.assign({}, ctrl, { skipDeviceCheckbox: true }));
            content.appendChild(row);
            if (ctrl.id === 'selectDevPanelFontFamily') row.querySelector('select').value = devPanelStyle.fontFamily;
            else if (ctrl.id in DEV_PANEL_CAPS_CHECKBOX_KEYS) row.querySelector('input').checked = !!devPanelStyle[DEV_PANEL_CAPS_CHECKBOX_KEYS[ctrl.id]];
        });
    }
    // Default nested subgroup arrangement for the built-in "Dev Panel"
    // group - per direct request (2026-09-14): "I want this specifically
    // integrated into the Dev Panel Template... our current Dev Panel
    // settings will be the standard", porting Clicko's own current live
    // organization (group names, nesting, and row order - confirmed live
    // via its own devTextOverrides/sectionOrder after the user renamed
    // every group). Every control is still REGISTERED flat under the
    // top-level "Dev Panel" group (findGroupContent only ever resolves a
    // TOP-LEVEL group - see its own comment - nesting is always a runtime
    // construct, built by relocating already-rendered rows, exactly how
    // Clicko's own structure was actually built via drag-and-drop, never
    // hardcoded HTML). This reuses createDevGroupElement() (the same
    // function "+ Add Group"/applySectionOrder() use) to build 3 top-
    // level subgroups - MECHANICS (Scroll Speed), PANEL UI (background/
    // accent/slider color, opacity), and TEXT (font family) - with TEXT
    // itself nesting 5 further subgroups, one per text category (Dev
    // Panel Title, Group Title, Setting Title, TABS, BUTTONS), each
    // holding that category's own Bold/Capitalize/Font-Size/Letter-
    // Spacing/Line-Spacing/Color battery. Idempotent - checks for its own
    // MECHANICS marker group before doing anything, so a later real
    // reorganization (the user dragging things around, or a saved/synced
    // order loading afterward) is never clobbered by a repeat call.
    function applyDefaultDevPanelSubgroupOrder(tab) {
        const tabEl = document.getElementById(tab + 'TabContent');
        if (!tabEl) return;
        const devPanelSec = Array.from(tabEl.querySelectorAll(':scope > .dev-section')).find(s => {
            const t = s.querySelector(':scope > .dev-section-title');
            return t && (t.dataset.sid || t.textContent.replace(/^[\u25bc\u25b6]\s*/, '')) === 'Dev Panel';
        });
        if (!devPanelSec) return;
        const content = devPanelSec.querySelector(':scope > .dev-section-content');
        if (!content || content.querySelector(':scope > .dev-section[data-sid="MECHANICS"]')) return;
        const rowsByKey = {};
        content.querySelectorAll(':scope > .dev-row [id]').forEach(el => { rowsByKey[el.id] = el.closest('.dev-row'); });
        function makeGroup(name, ids, parentContent) {
            const g = createDevGroupElement(name, tab);
            parentContent.appendChild(g);
            const gc = g.querySelector(':scope > .dev-section-content');
            ids.forEach(id => { const row = rowsByKey[id]; if (row) gc.appendChild(row); });
            return g;
        }
        const p = tab === 'desktop' ? 'sliderDevPanel' : tab === 'mobile' ? 'sliderMobileDevPanel' : 'sliderLandscapeDevPanel';
        makeGroup('MECHANICS', [p + 'ScrollStrength'], content);
        makeGroup('PANEL UI', ['colorDevPanelBg', 'colorDevPanelAccent', 'colorDevPanelSliderColor', p + 'Opacity'], content);
        const text = makeGroup('TEXT', ['selectDevPanelFontFamily'], content);
        const textContent = text.querySelector(':scope > .dev-section-content');
        makeGroup('Dev Panel Title', ['checkboxDevBoldTitle', 'checkboxDevCapsTitleText', p + 'TitleFontSize', p + 'TitleLetterSpacing', p + 'TitleLineHeight', p + 'ButtonTextBorder', 'colorDevPanelTitleText'], textContent);
        makeGroup('Group Title', ['checkboxDevBoldGroup', 'checkboxDevCapsGroupNames', p + 'GroupTitleFontSize', 'sliderDevGroupTextLetterSpacing', p + 'GroupLineHeight', 'colorDevPanelGroupText', 'colorDevPanelGroupLabelBg'], textContent);
        makeGroup('Setting Title', ['checkboxDevCapsSettingsText', 'checkboxDevBoldSettings', p + 'SettingTitleFontSize', p + 'ValueFontSize', p + 'SettingsLineHeight', 'sliderDevSettingsTextLetterSpacing', 'colorDevPanelNonTitleText', 'colorDevPanelSettingNumber'], textContent);
        makeGroup('TABS', ['checkboxDevBoldTab', 'checkboxDevCapsTabText', p + 'TabFontSize', 'sliderDevTabTextLetterSpacing', p + 'TabLineHeight', 'colorDevPanelTabText'], textContent);
        makeGroup('BUTTONS', ['checkboxDevBoldButton', 'checkboxDevCapsButtonText', p + 'ButtonFontSize', 'sliderDevButtonTextLetterSpacing', p + 'ButtonLineHeight', 'colorDevPanelButtonText', p + 'ButtonHeight'], textContent);
    }

    function setupDevPanelStyleControls() {
        DEV_PANEL_STYLE_SLIDER_KEYS.forEach(([key, deskId, mobId, landId]) => {
            [[deskId, devPanelStyle, 'desktop'], [mobId, mobileDevPanelStyle, 'mobile'], [landId, landscapeDevPanelStyle, 'landscape']].forEach(([id, store, tab]) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.addEventListener('input', (e) => {
                    store[key] = parseFloat(e.target.value);
                    applyDevPanelOwnStyling(tab);
                    const valEl = document.getElementById(id.replace('slider', 'value'));
                    if (valEl) valEl.textContent = e.target.value;
                });
            });
        });
        const opacityEl = document.getElementById('sliderDevPanelOpacity');
        if (opacityEl) opacityEl.addEventListener('input', (e) => {
            devPanelStyle.opacity = parseFloat(e.target.value);
            applyDevPanelOwnStyling('desktop');
            const valEl = document.getElementById('valueDevPanelOpacity');
            if (valEl) valEl.textContent = e.target.value;
        });
        DEV_PANEL_STYLE_COLOR_KEYS.forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', (e) => { devPanelStyle[key] = e.target.value; applyDevPanelOwnStyling('desktop'); });
        });
        const fontEl = document.getElementById('selectDevPanelFontFamily');
        if (fontEl) fontEl.addEventListener('change', (e) => { devPanelStyle.fontFamily = e.target.value; applyDevPanelOwnStyling('desktop'); });
        [['capsButtonText', 'checkboxDevCapsButtonText'], ['capsTabText', 'checkboxDevCapsTabText'],
         ['capsGroupNames', 'checkboxDevCapsGroupNames'], ['capsSettingsText', 'checkboxDevCapsSettingsText'],
         ['titleCapitalize', 'checkboxDevCapsTitleText'], ['titleBold', 'checkboxDevBoldTitle'],
         ['tabBold', 'checkboxDevBoldTab'], ['buttonBold', 'checkboxDevBoldButton'],
         ['settingsBold', 'checkboxDevBoldSettings'], ['groupBold', 'checkboxDevBoldGroup']].forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', (e) => { devPanelStyle[key] = e.target.checked; applyDevPanelOwnStyling('desktop'); });
        });
        // Text Edit Mode's own wiring moved to setupDevHeaderIconButtons()
        // (2026-09-16) - it's a header icon button now, always present
        // regardless of ensureDevPanelBuilt()'s lazy build, so it's set up
        // once from initDevPanelEngine() instead of here.

        const scrollContent = document.querySelector('.dev-panel-scroll-content');
        if (scrollContent) scrollContent.addEventListener('wheel', (e) => {
            const activeTab = DEV_PANEL_TABS.find(t => !document.getElementById(t + 'TabContent').classList.contains('hidden')) || 'desktop';
            const strength = (activeTab === 'desktop' ? devPanelStyle : activeTab === 'mobile' ? mobileDevPanelStyle : landscapeDevPanelStyle).scrollStrength;
            if (strength === 1) return;
            e.preventDefault();
            scrollContent.scrollTop += e.deltaY * strength;
        }, { passive: false });
    }

    // ================================================================
    // [JS-13] COPY / SAVE / RESET
    // ================================================================
    // Copy / Save / Reset — generic by default, backed by localStorage.
    // Captures/restores every control from every array registered via
    // registerDevControlArray(), by id, generically (works for any
    // slider/color/checkbox/select/text input regardless of what
    // project-specific state it's wired to) — plus this panel's own
    // layout/style/order/text-override/text-edit-mode state.
    //
    // Swap this out for a project-specific backend (e.g. the git-synced
    // Vercel pipeline, CLAUDE.md Section 12l) by replacing
    // saveDevPanelSettings()/loadDevPanelSettings() - the shape of
    // captureAllRegisteredControlValues()'s output (a flat {id: value}
    // object) is a reasonable wire format to keep either way.
    // ----------------------------------------------------------------
    const DEV_PANEL_LOCALSTORAGE_KEY = 'devPanelSettings';

    function captureAllRegisteredControlValues() {
        const out = {};
        DEV_PANEL_REGISTERED_ARRAYS.forEach(({ array }) => {
            array.forEach(ctrl => {
                const el = document.getElementById(ctrl.id);
                if (!el) return;
                out[ctrl.id] = el.type === 'checkbox' ? el.checked : (el.type === 'range' || el.type === 'number') ? parseFloat(el.value) : el.value;
            });
        });
        return out;
    }
    function applyControlValues(values) {
        if (!values) return;
        Object.entries(values).forEach(([id, value]) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = !!value; else el.value = value;
            el.dispatchEvent(new Event(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', { bubbles: true }));
        });
    }
    function captureFullDevPanelState() {
        // Undock is session-only/never persisted (see dockAllUndockedGroups()'s
        // own comment) - dock everything back first so nothing captured
        // below is silently missing a group that currently lives inside a
        // floating panel instead of its normal tab location.
        dockAllUndockedGroups();
        return {
            controls: captureAllRegisteredControlValues(),
            layout: { ...DEV_PANEL_LAYOUT },
            devPanelStyle: { ...devPanelStyle },
            mobileDevPanelStyle: { ...mobileDevPanelStyle },
            landscapeDevPanelStyle: { ...landscapeDevPanelStyle },
            sectionOrder: captureSectionOrder(),
            sectionCollapseState: captureSectionCollapseState(),
            devTextOverrides: { ...devTextOverrides },
            devTextOverridesManual: Array.from(devTextOverridesManual),
            lockedGroups: Array.from(lockedGroups),
            textEditModeEnabled,
            // Dynamic Mobile/Landscape visibility/independence state
            // ([JS-4b0] above) - NOT covered by `controls` above (a
            // dynamically-created row's own ctrl object is never passed
            // to registerDevControlArray(), so captureAllRegisteredControlValues()
            // never sees it) - deliberately: a non-independent row's
            // live value is always just Desktop's own (already captured
            // normally, via `controls`), and an independent row's is
            // devDeviceValues below, so nothing is actually missing.
            devVisibility: { ...devVisibility },
            devIndependence: { mobile: { ...devIndependence.mobile }, landscape: { ...devIndependence.landscape } },
            devDeviceValues: { mobile: { ...devDeviceValues.mobile }, landscape: { ...devDeviceValues.landscape } },
        };
    }
    function applyFullDevPanelState(state) {
        if (!state) return;
        applyControlValues(state.controls);
        // Restore BEFORE syncTabOrderToDesktop() runs below (via
        // applySectionOrder() -> nothing yet, this is a separate call) -
        // devVisibility/devIndependence/devDeviceValues must already be
        // in place before rows get dynamically rebuilt, or every dynamic
        // row would rebuild against stale (default) flags.
        if (state.devVisibility) devVisibility = { ...state.devVisibility };
        if (state.devIndependence) devIndependence = { mobile: { ...(state.devIndependence.mobile || {}) }, landscape: { ...(state.devIndependence.landscape || {}) } };
        if (state.devDeviceValues) devDeviceValues = { mobile: { ...(state.devDeviceValues.mobile || {}) }, landscape: { ...(state.devDeviceValues.landscape || {}) } };
        if (state.layout) { Object.assign(DEV_PANEL_LAYOUT, state.layout); applyDevPanelLayout(); }
        if (state.devPanelStyle) Object.assign(devPanelStyle, state.devPanelStyle);
        if (state.mobileDevPanelStyle) Object.assign(mobileDevPanelStyle, state.mobileDevPanelStyle);
        if (state.landscapeDevPanelStyle) Object.assign(landscapeDevPanelStyle, state.landscapeDevPanelStyle);
        applyDevPanelOwnStyling(DEV_PANEL_TABS.find(t => !document.getElementById(t + 'TabContent').classList.contains('hidden')) || 'desktop');
        if (state.devTextOverrides) devTextOverrides = { ...state.devTextOverrides };
        // Defaults to empty for state saved before this field existed -
        // see devTextOverridesManual's own comment above.
        if (state.devTextOverridesManual) devTextOverridesManual = new Set(state.devTextOverridesManual);
        applyDevTextOverrides();
        if (state.lockedGroups) lockedGroups = new Set(state.lockedGroups);
        if (devPanelBuilt) injectGroupLockIcons();
        if (typeof state.textEditModeEnabled === 'boolean') textEditModeEnabled = state.textEditModeEnabled;
        // Pushes everything just reassigned above (devPanelStyle/mobile/
        // landscape, textEditModeEnabled) into the CONTROLS' own DOM -
        // applyDevPanelOwnStyling() above only ever updated CSS custom
        // properties, never the sliders/colors/checkboxes themselves -
        // see this function's own comment for the bug this closes.
        syncDevPanelStyleControlsFromState();
        applySectionOrder(state.sectionOrder);
        applySectionCollapseState(state.sectionCollapseState);
        // Re-derives Mobile/Landscape from Desktop's now-restored order +
        // the devVisibility/devIndependence/devDeviceValues just restored
        // above - creates any dynamic row that doesn't exist in the DOM
        // yet (e.g. a fresh page load) and seeds its value correctly,
        // same call switchDevPanelTab() already makes on every tab open -
        // just needed here too since a restore isn't necessarily
        // followed by opening either tab.
        syncTabOrderToDesktop('mobile');
        syncTabOrderToDesktop('landscape');
        // Re-syncs row checkboxes' own .checked from the just-restored
        // devVisibility/devIndependence BEFORE recomputing group cascade
        // state from them - see syncDeviceCheckboxesFromState()'s own
        // comment ([JS-4b0] above) for the bug this closes.
        syncDeviceCheckboxesFromState();
        refreshEmptyGroupVisibility('mobile');
        refreshEmptyGroupVisibility('landscape');
        refreshAllGroupCascadeCheckboxes();
    }
    function copyDevPanelSettings() {
        const text = JSON.stringify(captureFullDevPanelState(), null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => window.prompt('Copy:', text));
        } else {
            window.prompt('Copy:', text);
        }
    }
    // Flashes the HEADER Sync button itself (devHeaderSyncBtn) with a
    // temporary checkmark/X and tooltip - ported from Clicko (2026-09-19,
    // "for the save button on the top panel, shwo some sort of indication
    // of 'Saved' after i click it"). The original bottom SYNC button
    // already has feedback via #devSaveSyncStatus below, but that status
    // text lives at the BOTTOM of the panel - not visible without
    // scrolling back up, defeating the whole point of the header button
    // existing (see its own "add a Sync button in the header too"
    // comment).
    function flashDevHeaderSyncStatus(success, message) {
        const btn = document.getElementById('devHeaderSyncBtn');
        if (!btn) return;
        if (btn._syncFlashTimeout) clearTimeout(btn._syncFlashTimeout);
        btn.textContent = success ? '✅' : '❌';
        btn.title = message || (success ? 'Saved!' : 'Save failed');
        btn._syncFlashTimeout = setTimeout(() => {
            btn.textContent = '💾';
            btn.title = 'Sync (Save)';
        }, 1800);
    }
    function saveDevPanelSettings() {
        const status = document.getElementById('devSaveSyncStatus');
        try {
            localStorage.setItem(DEV_PANEL_LOCALSTORAGE_KEY, JSON.stringify(captureFullDevPanelState()));
            if (status) { status.textContent = 'saved'; setTimeout(() => { status.textContent = ''; }, 1500); }
            flashDevHeaderSyncStatus(true, 'Saved!');
        } catch (e) {
            if (status) status.textContent = 'save failed';
            flashDevHeaderSyncStatus(false, 'Save failed');
        }
    }
    function loadDevPanelSettings() {
        try {
            const raw = localStorage.getItem(DEV_PANEL_LOCALSTORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }
    function resetDevPanelSettings() {
        applyFullDevPanelState(loadDevPanelSettings());
    }

    // ================================================================
    // [JS-13b] NAMED SETTING STATES (SAVE / USE / DELETE / SET AS DEFAULT)
    // ================================================================
    // Multiple named, full-panel-state snapshots to switch between
    // without losing your actual synced settings - direct request
    // ("I want to try different UI settings but dont want to overwrite
    // old settings... Refer to Hando project for this Save Use Delete
    // Set Default functionality"). Generalizes Hando's own
    // buildListPickerRow() (Save/Use/Rename/Delete for ONE named-item
    // control, e.g. its Camera/Pose presets - see devPanel.js) up to the
    // WHOLE PANEL's state instead - "different setting states" (plural,
    // whole states), not a per-control preset list, so this reuses
    // captureFullDevPanelState()/applyFullDevPanelState() (the exact
    // snapshot Copy/Sync/Reset already use) as what gets saved/restored.
    // Uses a plain <select> instead of Hando's own custom scrollable
    // list widget - simpler for a generic template with no Rename
    // requested here; swap in Hando's own richer widget on top if a
    // project wants Rename too.
    //
    // Save: prompts for a name, snapshots captureFullDevPanelState()
    // under it - asks before overwriting an existing name (the same fix
    // Hando's own picker needed after a real duplicate-name bug, see its
    // own comment: saving under a name that already existed used to
    // silently create a 2nd, separate item instead of updating it).
    // Use: applies the selected saved state to the live panel/game
    // WITHOUT touching whatever Sync/Reset would restore - a reversible
    // "try it", exactly the ask. Delete: removes the selected saved
    // state only. Set as Default: applies the selected state, THEN runs
    // it straight through saveDevPanelSettings() - THAT's what actually
    // replaces what Reset/a fresh load restores; Use alone never does.
    const DEV_PANEL_SAVED_STATES_KEY = 'devPanelSavedStates';
    function getSavedDevPanelStates() {
        try {
            const raw = localStorage.getItem(DEV_PANEL_SAVED_STATES_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }
    function setSavedDevPanelStates(states) {
        // Silently no-ops on a storage failure (full/unavailable) - same
        // tolerance as saveDevPanelSettings()'s own try/catch.
        try { localStorage.setItem(DEV_PANEL_SAVED_STATES_KEY, JSON.stringify(states)); } catch (e) { /* ignore */ }
    }
    function renderSavedDevPanelStatesList() {
        const select = document.getElementById('devSavedStatesSelect');
        if (!select) return;
        const states = getSavedDevPanelStates();
        const prevValue = select.value;
        select.innerHTML = '';
        Object.keys(states).forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        });
        if (states[prevValue]) select.value = prevValue;
    }
    function saveNamedDevPanelState() {
        const name = prompt('Save current settings as:');
        if (!name) return;
        const states = getSavedDevPanelStates();
        if (states[name] && !confirm('"' + name + '" already exists. Overwrite it?')) return;
        states[name] = captureFullDevPanelState();
        setSavedDevPanelStates(states);
        renderSavedDevPanelStatesList();
        const select = document.getElementById('devSavedStatesSelect');
        if (select) select.value = name;
    }
    function useNamedDevPanelState() {
        const select = document.getElementById('devSavedStatesSelect');
        const name = select && select.value;
        if (!name) return;
        const states = getSavedDevPanelStates();
        if (states[name]) applyFullDevPanelState(states[name]);
    }
    function deleteNamedDevPanelState() {
        const select = document.getElementById('devSavedStatesSelect');
        const name = select && select.value;
        if (!name) return;
        if (!confirm('Delete "' + name + '"?')) return;
        const states = getSavedDevPanelStates();
        delete states[name];
        setSavedDevPanelStates(states);
        renderSavedDevPanelStatesList();
    }
    function setNamedDevPanelStateAsDefault() {
        const select = document.getElementById('devSavedStatesSelect');
        const name = select && select.value;
        if (!name) return;
        const states = getSavedDevPanelStates();
        const state = states[name];
        if (!state) return;
        applyFullDevPanelState(state);
        saveDevPanelSettings();
    }

    // ================================================================
    // [JS-13c] MOUSE LOG (built-in "Debug" group feature)
    // ================================================================
    // Per direct request (2026-09-14): a live log of mouse/touch position,
    // click type, and what it hit - lives inside the built-in "Debug"
    // group (CLAUDE.md 12i-1), a SIBLING of "Dev Panel", both mandatory
    // built-in groups now. Referenced DickoClicko's own "CLICK LOG"
    // (structured {event, data} pairs, DOM-per-line, clipboard-only) and
    // Handy Dandies' own "Mouse Tracking Log" (Debug-group placement, a
    // sampling-interval slider for an optional continuous position
    // stream, array-backed) per direct pointer to both - this version
    // extends past either: touch gesture classification (tap/double-tap/
    // long-press/swipe/pinch, neither reference has any), device/viewport
    // context entries, and a Save-to-file export (both references are
    // clipboard-only).
    //
    // SINGLE INSTANCE, not tripled per tab: there is exactly one real
    // mouse/touch input stream in the browser regardless of which Desktop/
    // Mobile/Landscape tab happens to be showing, so the widget (checkbox,
    // slider, buttons, live display) is only ever built once, inside
    // Desktop's own Debug group - Mobile/Landscape still get their own
    // built-in Debug group (per the "must include" mandate), just without
    // their own separate copy of this specific widget.
    //
    // Unified mouse+touch capture via Pointer Events (pointerdown/move/up/
    // cancel on window) - e.pointerType ('mouse'/'touch'/'pen') is the
    // input-source axis; isNarrowViewport() is the separate device/layout
    // axis (a touch-capable laptop at a wide viewport still logs as
    // "desktop" device context) - CLAUDE.md 12i-1 documents why both are
    // tracked, not merged into one field.
    const MOUSE_LOG_MAX_ENTRIES = 500;
    const MOUSE_LOG_HOLD_MS = 500;
    const MOUSE_LOG_MULTICLICK_MS = 350;
    const MOUSE_LOG_MOVE_THRESHOLD_PX = 10;
    let mouseLog = [];
    let mouseLogEl = null;
    let mouseLogPositionEnabled = false;
    let mouseLogPositionIntervalMs = 1000;
    let mouseLogPositionTimer = null;
    // Both default OFF (opt-in), matching Log Mouse Position's own
    // default - per direct request (Clicko project, 2026-09-15:
    // "provide a checkbox to turn on and off scroll logging" / "provide
    // a checkbox to log keystrokes too"). Scroll events are high-volume/
    // noisy the same way continuous position sampling is; keystrokes are
    // additionally privacy-sensitive (could capture real typed text in a
    // rename/text box), so opt-in is the more conservative default there
    // too.
    let mouseLogScrollEnabled = false;
    let mouseLogKeystrokesEnabled = false;
    let mouseLogLastPointerPos = null;
    let mouseLogLastViewport = null;
    const mouseLogActivePointers = new Map();
    let mouseLogClickCount = 0;
    let mouseLogClickTimer = null;
    let mouseLogHoldTimer = null;
    let mouseLogPinchStartDist = null;
    let mouseLogPinchActive = false;

    function mouseLogDeviceContext() { return isNarrowViewport() ? 'mobile' : 'desktop'; }
    function formatMouseLogTime(d) {
        const pad2 = n => String(n).padStart(2, '0');
        const pad3 = n => String(n).padStart(3, '0');
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + pad3(d.getMilliseconds());
    }
    // Resolves WHAT a mouse/touch action hit - a Dev Panel control (by its
    // own .dev-label text, or a button's own text) vs. something in the
    // project's own app/game area (by id, else tag+first-class, else
    // "(background)") - and a best-effort "triggered" guess: true for any
    // genuinely interactive element (button/input/select/textarea/a[href]/
    // [onclick]/label), false otherwise. Per the request's own "(maybe)"
    // hedge on this part - a real success/failure signal isn't generically
    // knowable here, this is a structural guess, not app-logic awareness.
    // Reads back the CURRENT value of a form control for the Mouse Log's
    // own "what input" detail - per direct request ("when it logs what
    // function was triggered. I need more information than just 'set
    // dev panel setting'. I need it to say what setting and what
    // input."). Only meaningful for actual form controls (range/color/
    // text/number inputs, checkboxes, selects) - null for anything
    // else (a button, a group title bar), which describeMouseLogTarget
    // below then leaves off the log line entirely rather than printing
    // a hollow "= null".
    function describeMouseLogControlValue(el) {
        if (!el || !el.tagName) return null;
        const tag = el.tagName;
        if (tag === 'SELECT') {
            const opt = el.options[el.selectedIndex];
            return opt ? opt.text : el.value;
        }
        if (tag === 'INPUT') {
            const type = (el.type || '').toLowerCase();
            if (type === 'checkbox') return el.checked ? 'checked' : 'unchecked';
            if (type === 'range' || type === 'number' || type === 'color') return el.value;
            if (type === 'text') return '"' + el.value.slice(0, 30) + '"';
        }
        if (tag === 'TEXTAREA') return '"' + el.value.slice(0, 30) + '"';
        return null;
    }
    function describeMouseLogTarget(el) {
        if (!el || el === document.documentElement || el === document.body) return { target: '(background)', triggered: false };
        const inPanel = el.closest && el.closest('.dev-panel');
        if (inPanel) {
            const row = el.closest('.dev-row');
            const label = row && row.querySelector('.dev-label');
            const btn = el.closest('button');
            const titleEl = el.closest('.dev-section-title');
            const name = label ? label.textContent.trim() : btn ? btn.textContent.trim() : titleEl ? '(group) ' + titleEl.textContent.replace(/^[▼▶]\s*/, '').trim() : (el.id || el.tagName.toLowerCase());
            const interactive = !!(btn || titleEl || el.matches('input, select, textarea, [onclick]'));
            // The actual form control a row's own value lives on isn't
            // always e.target itself (a slider's wheel/click can land on
            // its .dev-label instead) - fall back to the row's own
            // control when el itself isn't one.
            const control = el.matches('input, select, textarea') ? el : (row && row.querySelector('input, select, textarea'));
            const value = describeMouseLogControlValue(control);
            return { target: 'Dev Panel: ' + name + (value !== null ? ' = ' + value : ''), triggered: interactive };
        }
        const interactiveEl = el.closest && el.closest('button, a[href], input, select, textarea, [onclick], label');
        if (interactiveEl) {
            const id = interactiveEl.id ? '#' + interactiveEl.id : '';
            const text = (interactiveEl.textContent || '').trim().slice(0, 30);
            return { target: 'App: ' + interactiveEl.tagName.toLowerCase() + id + (text ? ' "' + text + '"' : ''), triggered: true };
        }
        const id = el.id ? '#' + el.id : '';
        const cls = el.className && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
        return { target: 'App: ' + el.tagName.toLowerCase() + id + cls, triggered: false };
    }
    function renderMouseLogEntry(entry) {
        if (!mouseLogEl) return;
        const empty = mouseLogEl.querySelector('.dev-mouse-log-empty');
        if (empty) empty.remove();
        const line = document.createElement('div');
        let text = entry.time + '  [' + entry.device + '/' + entry.pointerType + ']  ' + entry.type + '  (' + entry.x + ', ' + entry.y + ')';
        if (entry.target) text += '  -> ' + entry.target;
        if (entry.triggered === true) text += '  [OK]';
        else if (entry.triggered === false) text += '  [no-op]';
        if (entry.detail) text += '  ' + entry.detail;
        line.textContent = text;
        mouseLogEl.appendChild(line);
        while (mouseLogEl.children.length > MOUSE_LOG_MAX_ENTRIES) mouseLogEl.removeChild(mouseLogEl.firstChild);
        mouseLogEl.scrollTop = mouseLogEl.scrollHeight;
    }
    function pushMouseLogEntry(entry) {
        entry.time = formatMouseLogTime(new Date());
        mouseLog.push(entry);
        if (mouseLog.length > MOUSE_LOG_MAX_ENTRIES) mouseLog.shift();
        renderMouseLogEntry(entry);
    }
    // Context entries (device + viewport dims + pixel ratio) - logged once
    // when logging starts, and again whenever the viewport actually
    // changes size (resize/orientation change) while the log has content -
    // per direct request ("include information about whether its desktop
    // or mobile, as well as browser dimensions"), without repeating full
    // viewport info on every single move/click entry (each entry still
    // carries its own compact device tag - see renderMouseLogEntry above).
    function logMouseLogContext(reason) {
        const w = window.innerWidth, h = window.innerHeight;
        if (reason === 'resize' && mouseLogLastViewport && mouseLogLastViewport.w === w && mouseLogLastViewport.h === h) return;
        mouseLogLastViewport = { w, h };
        pushMouseLogEntry({
            type: 'context', x: '-', y: '-', device: mouseLogDeviceContext(), pointerType: '-',
            target: null, triggered: null,
            detail: reason + ': ' + w + 'x' + h + ' dpr:' + (window.devicePixelRatio || 1).toFixed(2),
        });
    }
    function clearMouseLog() {
        mouseLog = [];
        if (mouseLogEl) {
            mouseLogEl.innerHTML = '';
            const empty = document.createElement('div');
            empty.className = 'dev-mouse-log-empty';
            empty.textContent = '(no mouse activity logged yet)';
            mouseLogEl.appendChild(empty);
        }
        mouseLogLastViewport = null;
    }
    function mouseLogEntryToLine(e) {
        let text = e.time + '  [' + e.device + '/' + e.pointerType + ']  ' + e.type + '  (' + e.x + ', ' + e.y + ')';
        if (e.target) text += '  -> ' + e.target;
        if (e.triggered === true) text += '  [OK]';
        else if (e.triggered === false) text += '  [no-op]';
        if (e.detail) text += '  ' + e.detail;
        return text;
    }
    function copyMouseLog(btn) {
        const text = mouseLog.map(mouseLogEntryToLine).join('\n');
        const flash = (msg) => { const orig = btn.textContent; btn.textContent = msg; setTimeout(() => { btn.textContent = orig; }, 900); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => flash('Copied!')).catch(() => flash('Copy failed'));
        } else {
            flash('Copy failed');
        }
    }
    // Save as a .md file - neither reference implementation has a file
    // export (clipboard-only in both), added per direct request ("a Save
    // button (to save an exported text or md file)"). A plain in-page
    // Blob + <a download> - works fine for a real dev session in an
    // actual browser (this is NOT an Artifact/sandboxed context).
    function saveMouseLog() {
        const header = '# Mouse Log\n\n' + mouseLog.filter(e => e.type === 'context').map(mouseLogEntryToLine).join('\n') + '\n\n';
        const body = mouseLog.map(e => '- ' + mouseLogEntryToLine(e)).join('\n');
        const md = header + body + '\n';
        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = 'mouse-log-' + stamp + '.md';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }
    function restartMouseLogPositionTimer() {
        clearInterval(mouseLogPositionTimer);
        mouseLogPositionTimer = null;
        if (!mouseLogPositionEnabled) return;
        mouseLogPositionTimer = setInterval(() => {
            if (!mouseLogLastPointerPos) return;
            pushMouseLogEntry({
                type: 'position', x: mouseLogLastPointerPos.x, y: mouseLogLastPointerPos.y,
                device: mouseLogDeviceContext(), pointerType: mouseLogLastPointerPos.pointerType || '-',
                target: null, triggered: null,
            });
        }, mouseLogPositionIntervalMs);
    }
    function buildMouseLogWidget() {
        const debugContent = findGroupContent('desktop', 'Debug', 'buildMouseLogWidget', 'mouseLogWidget');
        if (!debugContent || mouseLogEl) return;
        const section = createDevGroupElement('Mouse Log', 'desktop');
        debugContent.appendChild(section);
        const content = section.querySelector(':scope > .dev-section-content');

        const posRow = document.createElement('div');
        posRow.className = 'dev-row';
        const posCheckbox = document.createElement('input');
        posCheckbox.type = 'checkbox';
        posCheckbox.id = 'checkboxMouseLogPosition';
        const posLabel = document.createElement('span');
        posLabel.className = 'dev-label';
        posLabel.textContent = 'Log Mouse Position (continuous)';
        posRow.append(posCheckbox, posLabel);
        content.appendChild(posRow);
        posCheckbox.addEventListener('change', (e) => {
            mouseLogPositionEnabled = e.target.checked;
            restartMouseLogPositionTimer();
        });

        // skipDeviceCheckbox: true - Mouse Log is Desktop-tab-only, no
        // Mobile/Landscape counterpart concept at all (explicitly excluded
        // from tab-mirroring by name - see this widget's own top comment)
        // - and has no `tab` field, which would otherwise make
        // buildUniformControlRow()'s `ctrl.tab === 'desktop'` check false
        // and wrongly append a Mobile/Landscape-style independence
        // checkbox to a control that isn't on either of those tabs.
        const intervalCtrl = { id: 'sliderMouseLogInterval', type: 'slider', label: 'Position Log Interval (Ms):', min: 100, max: 5000, step: 50, value: mouseLogPositionIntervalMs, skipDeviceCheckbox: true };
        const intervalRow = buildUniformControlRow(intervalCtrl);
        content.appendChild(intervalRow);
        document.getElementById('sliderMouseLogInterval').addEventListener('input', (e) => {
            mouseLogPositionIntervalMs = parseFloat(e.target.value);
            restartMouseLogPositionTimer();
        });

        const scrollRow = document.createElement('div');
        scrollRow.className = 'dev-row';
        const scrollCheckbox = document.createElement('input');
        scrollCheckbox.type = 'checkbox';
        scrollCheckbox.id = 'checkboxMouseLogScroll';
        const scrollLabel = document.createElement('span');
        scrollLabel.className = 'dev-label';
        scrollLabel.textContent = 'Log Scroll';
        scrollRow.append(scrollCheckbox, scrollLabel);
        content.appendChild(scrollRow);
        scrollCheckbox.addEventListener('change', (e) => { mouseLogScrollEnabled = e.target.checked; });

        const keyRow = document.createElement('div');
        keyRow.className = 'dev-row';
        const keyCheckbox = document.createElement('input');
        keyCheckbox.type = 'checkbox';
        keyCheckbox.id = 'checkboxMouseLogKeystrokes';
        const keyLabel = document.createElement('span');
        keyLabel.className = 'dev-label';
        keyLabel.textContent = 'Log Keystrokes';
        keyRow.append(keyCheckbox, keyLabel);
        content.appendChild(keyRow);
        keyCheckbox.addEventListener('change', (e) => { mouseLogKeystrokesEnabled = e.target.checked; });

        const btnRow = document.createElement('div');
        btnRow.className = 'dev-buttons';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.textContent = 'COPY';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'SAVE';
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.textContent = 'CLEAR';
        btnRow.append(copyBtn, saveBtn, clearBtn);
        content.appendChild(btnRow);
        copyBtn.addEventListener('click', () => copyMouseLog(copyBtn));
        saveBtn.addEventListener('click', saveMouseLog);
        clearBtn.addEventListener('click', clearMouseLog);

        mouseLogEl = document.createElement('div');
        mouseLogEl.className = 'dev-mouse-log';
        content.appendChild(mouseLogEl);
        clearMouseLog();
        logMouseLogContext('start');
    }
    function setupMouseLog() {
        window.addEventListener('pointermove', (e) => {
            mouseLogLastPointerPos = { x: Math.round(e.clientX), y: Math.round(e.clientY), pointerType: e.pointerType };
            const info = mouseLogActivePointers.get(e.pointerId);
            if (!info) return;
            info.curX = e.clientX; info.curY = e.clientY;
            if (!info.moved && Math.hypot(e.clientX - info.startX, e.clientY - info.startY) > MOUSE_LOG_MOVE_THRESHOLD_PX) info.moved = true;
        });
        window.addEventListener('pointerdown', (e) => {
            mouseLogActivePointers.set(e.pointerId, { startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY, startTime: performance.now(), moved: false, target: e.target });
            if (e.pointerType === 'touch' && mouseLogActivePointers.size === 2) {
                const pts = Array.from(mouseLogActivePointers.values());
                mouseLogPinchStartDist = Math.hypot(pts[0].curX - pts[1].curX, pts[0].curY - pts[1].curY);
                mouseLogPinchActive = true;
                clearTimeout(mouseLogHoldTimer);
                return;
            }
            if (e.button === 2 || mouseLogActivePointers.size > 1) return;
            clearTimeout(mouseLogHoldTimer);
            mouseLogHoldTimer = setTimeout(() => {
                const info2 = mouseLogActivePointers.get(e.pointerId);
                if (info2 && !info2.moved) {
                    const { target, triggered } = describeMouseLogTarget(e.target);
                    pushMouseLogEntry({ type: 'hold', x: Math.round(e.clientX), y: Math.round(e.clientY), device: mouseLogDeviceContext(), pointerType: e.pointerType, target, triggered });
                }
            }, MOUSE_LOG_HOLD_MS);
        });
        window.addEventListener('pointerup', (e) => {
            clearTimeout(mouseLogHoldTimer);
            const info = mouseLogActivePointers.get(e.pointerId);
            const wasPinching = mouseLogPinchActive && mouseLogActivePointers.size === 2;
            mouseLogActivePointers.delete(e.pointerId);
            if (!info) return;
            const x = Math.round(e.clientX), y = Math.round(e.clientY);
            const device = mouseLogDeviceContext();
            if (wasPinching) {
                mouseLogPinchActive = false;
                const remaining = Array.from(mouseLogActivePointers.values())[0];
                if (remaining && mouseLogPinchStartDist) {
                    const endDist = Math.hypot(x - remaining.curX, y - remaining.curY);
                    const scale = mouseLogPinchStartDist > 0 ? endDist / mouseLogPinchStartDist : 1;
                    pushMouseLogEntry({ type: 'pinch', x, y, device, pointerType: 'touch', target: null, triggered: null, detail: (scale > 1 ? 'out' : 'in') + ' scale:' + scale.toFixed(2) });
                }
                return;
            }
            const heldMs = performance.now() - info.startTime;
            // Deferred one macrotask (setTimeout 0), not called
            // synchronously here - per direct request (Clicko project,
            // 2026-09-14/15) for the log to include the actual value/
            // input a setting was changed to, not just its name. A
            // checkbox's own `checked` flip (and a native <select>'s
            // selection) happens as part of the browser's default click
            // handling, which runs AFTER 'pointerup' has already fired -
            // reading el.checked/value synchronously at this point would
            // still show the OLD, pre-click state. Range/color/text
            // inputs update .value live as you interact, so this costs
            // them nothing; it's what makes checkbox/select values come
            // out correct.
            setTimeout(() => {
            const { target, triggered } = describeMouseLogTarget(info.target);
            if (e.pointerType === 'touch') {
                if (info.moved) {
                    const dx = e.clientX - info.startX, dy = e.clientY - info.startY;
                    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
                    pushMouseLogEntry({ type: 'swipe', x, y, device, pointerType: 'touch', target, triggered, detail: 'dir:' + dir + ' dist:' + Math.round(Math.hypot(dx, dy)) });
                    return;
                }
                if (heldMs > MOUSE_LOG_HOLD_MS) return;
                mouseLogClickCount++;
                clearTimeout(mouseLogClickTimer);
                mouseLogClickTimer = setTimeout(() => {
                    pushMouseLogEntry({ type: mouseLogClickCount >= 2 ? 'doubletap' : 'tap', x, y, device, pointerType: 'touch', target, triggered });
                    mouseLogClickCount = 0;
                }, MOUSE_LOG_MULTICLICK_MS);
                return;
            }
            if (e.button === 2) {
                pushMouseLogEntry({ type: 'rightclick', x, y, device, pointerType: e.pointerType, target, triggered });
                return;
            }
            if (info.moved) {
                pushMouseLogEntry({ type: 'drag-release', x, y, device, pointerType: e.pointerType, target, triggered, detail: 'heldMs:' + Math.round(heldMs) });
                return;
            }
            if (heldMs > MOUSE_LOG_HOLD_MS) {
                pushMouseLogEntry({ type: 'release', x, y, device, pointerType: e.pointerType, target, triggered, detail: 'heldMs:' + Math.round(heldMs) });
                return;
            }
            mouseLogClickCount++;
            clearTimeout(mouseLogClickTimer);
            mouseLogClickTimer = setTimeout(() => {
                const kind = mouseLogClickCount >= 3 ? 'tripleclick' : mouseLogClickCount === 2 ? 'dblclick' : 'click';
                pushMouseLogEntry({ type: kind, x, y, device, pointerType: e.pointerType, target, triggered });
                mouseLogClickCount = 0;
            }, MOUSE_LOG_MULTICLICK_MS);
            }, 0);
        });
        window.addEventListener('pointercancel', (e) => {
            clearTimeout(mouseLogHoldTimer);
            mouseLogActivePointers.delete(e.pointerId);
            mouseLogPinchActive = false;
        });
        window.addEventListener('wheel', (e) => {
            if (!mouseLogScrollEnabled) return;
            const { target, triggered } = describeMouseLogTarget(e.target);
            pushMouseLogEntry({ type: 'scroll', x: Math.round(e.clientX), y: Math.round(e.clientY), device: mouseLogDeviceContext(), pointerType: 'wheel', target, triggered, detail: 'deltaY:' + Math.round(e.deltaY) });
        }, { passive: true });
        window.addEventListener('keydown', (e) => {
            if (!mouseLogKeystrokesEnabled) return;
            const { target, triggered } = describeMouseLogTarget(e.target);
            pushMouseLogEntry({ type: 'keydown', x: '-', y: '-', device: mouseLogDeviceContext(), pointerType: 'keyboard', target, triggered, detail: 'key:' + e.key });
        });
        window.addEventListener('resize', () => { if (mouseLogEl) logMouseLogContext('resize'); });
    }


    // ================================================================
    // [JS-14] INIT SEQUENCE  (LAZY-BUILD)
    // ================================================================
    // LAZY-BUILD: the panel's actual CONTROLS (every render*Controls()
    // call — this engine's own built-in Dev Panel group AND your own
    // project settings) are only ever built the FIRST time the panel is
    // actually needed — on first D-press, first DEV-button click, or
    // (see initDevPanelEngine() below) once, eagerly, for a dev-allowed
    // visitor, since the panel is visible-by-default for them with no
    // click needed (see the CSS html.dev-mode rules). A REAL PLAYER on
    // a real deployed site never triggers any of these three paths, so
    // their page never pays the cost of constructing however many
    // hundred DOM elements your project's own settings add up to.
    //
    // Ported from a real project's own dev panel (MAINTENANCE note at
    // the top of this file), which measured a genuine ~780-880ms
    // domInteractive delay from doing this unconditionally at the top
    // level for every visitor — 686 controls across 3 device tabs, none
    // of which a real player ever opens. After lazy-building, that gap
    // measured 63-79ms on a real player's load. The real project also
    // hit — and this template's own structure below already avoids —
    // 2 sharp edges worth knowing about if you ever restructure this
    // yourself: (1) devPanelBuilt has to be declared at the very TOP of
    // this script, not here, or an early click on a statically-parsed
    // button can read it before its own declaration line has executed
    // (a real temporal-dead-zone crash, reproduced and fixed this exact
    // way); (2) devPanelBuilt must be set true at the very END of this
    // function, not the start — setting it early means a mid-build
    // exception leaves the flag permanently true while the panel stays
    // genuinely half-built, with no way to recover short of a full
    // reload.
    // ----------------------------------------------------------------
    // ensureDevPanelBuilt() — ORDER MATTERS inside here, same as this
    // section always required, now just deferred behind a guard instead
    // of running unconditionally at load:
    //   1. Your own render*Controls() calls (create the DOM) — these
    //      now belong INSIDE this function too, not before it — see the
    //      PROJECT comment below.
    //   2. renderDevPanelStyleControls() (this engine's own built-in
    //      group).
    //   3. Your own event-wiring (each control's 'input'/'change'
    //      listener) — also moves inside this function, in your own code.
    //   4. setupDevPanelStyleControls(), makeDevValuesEditable(),
    //      setupDevPanelTextEdit(), assertDevControlsRendered(),
    //      validateDevControlMappings() — this engine's own generic
    //      wiring + safety nets, once every control genuinely exists.
    //   5. setupDragReorder() (x2 — groups, then settings).
    //   6. Load saved state (localStorage by default) and apply it.
    // ----------------------------------------------------------------
    function ensureDevPanelBuilt() {
        if (devPanelBuilt) return;

        renderDevPanelStyleControls();
        // Built-in "Debug" group's own Mouse Log feature ([JS-13c]) -
        // buildMouseLogWidget() finds the static "Debug" group and
        // appends its own nested "Mouse Log" subgroup; setupMouseLog()
        // wires the (global, only-ever-registered-once thanks to this
        // whole function's own devPanelBuilt guard) window-level pointer/
        // wheel listeners.
        buildMouseLogWidget();
        setupMouseLog();

        // PROJECT: call your own render*Controls() functions here too,
        // BEFORE the wiring below — see the worked example above
        // registerDevControlArray(). This is the one integration point
        // that moved as part of lazy-build: previously these were
        // called once, unconditionally, before initDevPanelEngine() —
        // now they belong HERE, inside the guarded function, so they
        // only ever run when the panel is actually being built.
        // FONT PATH LAB: the ONE line inserted into this otherwise-verbatim
        // copy of TEMPLATE_DEV_PANEL.html's <script> block, at the
        // template's own documented splice point. src/app.mjs defines this
        // global before this file executes (see index.html script order).
        if (window.renderFontLabDevGroups) window.renderFontLabDevGroups();

        setupDevPanelStyleControls();
        makeDevValuesEditable();
        setupDevPanelTextEdit();
        assertDevControlsRendered();
        validateDevControlMappings();
        // Dynamic Mobile/Landscape visibility/independence ([JS-4b0]) -
        // creates every control's own Mobile/Landscape row for the first
        // time (universal as of 2026-09-17; a fresh page load has none
        // yet), and gives every group's own cascade checkbox its correct
        // initial checked/indeterminate display (see refreshAllGroupCascadeCheckboxes()'s
        // own comment on why this can't just be left to react to a real
        // checkbox change). Order matters: AFTER every render*Controls()
        // call above (Desktop rows must exist first) and BEFORE
        // syncTabOrderToDesktop() would otherwise be the only thing
        // creating them, i.e. not until the user opens that tab.
        syncTabOrderToDesktop('mobile');
        syncTabOrderToDesktop('landscape');
        // Backfills checkboxes onto any hand-authored control OUTSIDE the
        // registerDevControlArray() system, and applies its correct
        // initial hide/show - see injectRowDeviceCheckboxes()'s own
        // comment ([JS-4b0] above) for the CLICKO-found bug this closes.
        // Must run before refreshAllGroupCascadeCheckboxes() just below,
        // same reasoning as syncDeviceCheckboxesFromState()'s own ordering.
        injectRowDeviceCheckboxes();
        refreshEmptyGroupVisibility('mobile');
        refreshEmptyGroupVisibility('landscape');
        refreshAllGroupCascadeCheckboxes();

        // Groups within groups, UNLIMITED depth (ported from a real
        // project's own dev panel - MAINTENANCE note at the top of this
        // file). Eligible drop targets: tabRoot itself (drag a nested
        // group back out to the top level) plus every group's own content
        // ANYWHERE in the tab, at any depth (nest a group INTO it, or
        // INTO an already-nested group). Excludes the dragged group's own
        // content AND every one of its descendants' content
        // (dragging.contains(content)) - can't nest a group inside itself
        // or inside its own child.
        //
        // devGroupNestingDepth() below sorts candidates DEEPEST-first,
        // with tabRoot always last - this is not optional. setupDragReorder's
        // own direct hit-test is `containers.find(c => pointerY is within
        // c's own rect)`, and an outer container's rect always
        // geometrically CONTAINS every one of its descendants' own
        // smaller rects (a group's content fully encloses any group
        // nested inside it, which fully encloses anything nested inside
        // THAT). With candidates in any other order, Array.prototype.
        // find() matches whichever shallower container happens to come
        // first - typically tabRoot itself - before a real, more specific
        // target ever gets a chance, making it structurally impossible to
        // ever hit-test into a nested group, 100% of the time, regardless
        // of pointer precision. Sorting deepest-first makes find() always
        // prefer the most specific match, falling through to a shallower
        // match (and eventually tabRoot) only when the pointer is
        // genuinely outside every deeper candidate - exactly the un-nest
        // case this ordering exists to support.
        function devGroupNestingDepth(contentEl, tabRoot) {
            let depth = 0;
            let cur = contentEl.parentElement;
            while (cur && cur !== tabRoot) {
                if (cur.classList.contains('dev-section')) depth++;
                cur = cur.parentElement;
            }
            return depth;
        }
        // Handle narrowed from the whole title bar ('.dev-section-title')
        // to the dedicated '.dev-group-drag-handle' icon - see its own
        // comment (§12n's far-left-icon-only convention). The title keeps
        // its own separate onclick="toggleSection(this)" (collapse/
        // expand), now completely unaffected by dragging since it's a
        // different element from the handle entirely.
        setupDragReorder('.dev-group-drag-handle', '.dev-section', () => {}, (tabRoot, dragging) => {
            const groupContents = Array.from(tabRoot.querySelectorAll('.dev-section > .dev-section-content'))
                .filter(content => !dragging.contains(content));
            groupContents.sort((a, b) => devGroupNestingDepth(b, tabRoot) - devGroupNestingDepth(a, tabRoot));
            return [...groupContents, tabRoot];
        });
        // Settings-row cross-group drag - same deepest-first ordering as
        // the group-drag call above (no cycle check needed here: a
        // setting row is never itself a container, so it can never
        // contain the group it's being dropped into). Handle likewise
        // narrowed from '.dev-label' to the dedicated '.dev-row-drag-
        // handle' icon - injectRowDragHandles() (see its own comment)
        // adds it uniformly to every .dev-row.
        setupDragReorder('.dev-row-drag-handle', '.dev-row', () => {}, (tabRoot, dragging) => {
            const groupContents = Array.from(tabRoot.querySelectorAll('.dev-section-content'));
            groupContents.sort((a, b) => devGroupNestingDepth(b, tabRoot) - devGroupNestingDepth(a, tabRoot));
            return groupContents;
        });
        // Must run before a user can actually drag anything, but ordering
        // relative to the setupDragReorder() calls above doesn't matter -
        // those only register a document-level listener that checks the
        // handle selector at CLICK time, not at registration time, and
        // everything here runs synchronously before the panel is
        // interactive either way.
        injectGroupDragHandles();
        injectRowDragHandles();
        // Runs BEFORE applyFullDevPanelState() below on purpose - gives a
        // fresh template (no saved settings yet) this nice default
        // structure immediately; a project with its OWN saved Dev Panel
        // order still wins, since applySectionOrder() (called from
        // applyFullDevPanelState() via the loaded state's sectionOrder)
        // relocates rows by their own stable key regardless of whatever
        // parent this default pass already put them in.
        DEV_PANEL_TABS.forEach(applyDefaultDevPanelSubgroupOrder);

        syncSlidersFromState();
        syncColorPickersFromState();

        applyFullDevPanelState(loadDevPanelSettings());

        // Set LAST, not first - see this section's own top comment
        // (sharp edge #2) for why.
        devPanelBuilt = true;
    }

    // Always runs on page load, regardless of dev status - this is
    // deliberately everything that DOESN'T depend on the panel's
    // generated controls existing: positioning/sizing the panel itself,
    // its own resize-handle chrome (8 static <div>s already in the HTML
    // above, not generated), and the D-key listener that's the whole
    // reason ensureDevPanelBuilt() needs to be callable before the
    // panel has ever been opened.
    function initDevPanelEngine() {
        applyDevPanelLayout();
        applyDevPanelOwnStyling('desktop');
        // Static/eager, same as the Copy/Sync/Reset row above it - not
        // gated behind ensureDevPanelBuilt()'s lazy build.
        renderSavedDevPanelStatesList();
        ensureStaticGroupCascadeCheckboxes();
        ensureStaticGroupUndockButtons();
        injectGroupLockIcons();

        setupPanelResizeHandle(devPanel, document.getElementById('devPanelResizeTop'), null, 'top');
        setupPanelResizeHandle(devPanel, document.getElementById('devPanelResizeBottom'), null, 'bottom');
        setupPanelResizeHandle(devPanel, document.getElementById('devPanelResizeLeft'), 'left', null);
        setupPanelResizeHandle(devPanel, document.getElementById('devPanelResizeRight'), 'right', null);
        setupPanelResizeHandle(devPanel, document.getElementById('devPanelResizeTL'), 'left', 'top');
        setupPanelResizeHandle(devPanel, document.getElementById('devPanelResizeTR'), 'right', 'top');
        setupPanelResizeHandle(devPanel, document.getElementById('devPanelResizeBL'), 'left', 'bottom');
        setupPanelResizeHandle(devPanel, document.getElementById('devPanelResizeBR'), 'right', 'bottom');
        new ResizeObserver((entries) => {
            for (const entry of entries) {
                const w = Math.round(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
                const h = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
                if (w > 0 && h > 0) { DEV_PANEL_LAYOUT.width = w; DEV_PANEL_LAYOUT.height = h; }
            }
        }).observe(devPanel);

        window.addEventListener('resize', clampDevPanelPosition);

        // 'D' key toggles the panel, matching CLAUDE.md Section 12c -
        // triggers the lazy build on its own first press, same as the
        // DEV button's onclick does (see the HTML above).
        document.addEventListener('keydown', (e) => {
            if (e.key === 'd' || e.key === 'D') {
                const activeTag = document.activeElement && document.activeElement.tagName;
                if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
                ensureDevPanelBuilt();
                devPanel.classList.toggle('hidden');
            }
        });

        // Shift+click multi-select - always on, same reasoning as the
        // D-key listener above (works even before the panel's own
        // controls are built, and doesn't need to be re-armed per tab).
        setupDevGroupSelection();
        // Text Edit Mode / Add Group / Collapse All header icon buttons -
        // always on, same reasoning (they live in the header, which is
        // static markup present from first paint, unlike the lazily-built
        // tab content).
        setupDevHeaderIconButtons();
        // Delete Group/Setting - same "always on" reasoning.
        setupDevDeleteGroup();
        // Undo - same "always on" reasoning (Ctrl+Z must work regardless
        // of whether the panel's own lazy controls are built yet).
        setupDevPanelUndo();
        // Search bar - same "always on" reasoning (static header markup).
        setupDevSearch();

        // The panel is visible-by-default for a dev-allowed visitor
        // (html.dev-mode CSS, no click needed) - build it eagerly for
        // them specifically, so they don't see an empty panel shell
        // with none of its rows until they happen to press D or click
        // DEV (a real gap, caught via a live screenshot showing exactly
        // this, in the real project this pattern was ported from).
        if (isDevAllowed) ensureDevPanelBuilt();
    }

    // PROJECT: call initDevPanelEngine() once, after your own
    // event-wiring for controls OTHER than your dev-panel settings
    // (initDevPanelEngine() itself doesn't need your render*Controls()
    // calls to have run yet - those now belong inside
    // ensureDevPanelBuilt() above, not before this call). Example:
    //
    //   /* ... your own non-dev-panel setup ... */
    //   initDevPanelEngine();
    //
    // For a quick standalone test of just this template (no project
    // settings yet), uncomment the line below:
    initDevPanelEngine();
