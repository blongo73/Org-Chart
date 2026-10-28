/*
 * orgchart.core.js — authoritative shared engine for the org-chart viewer.
 *
 * This file is the single source of truth for ALL pure logic (extract / parse / crawl /
 * LCA / prune / layout). The production Tampermonkey userscript inlines a SYNCED COPY of
 * these same functions (see production/orgchart.user.js header). Keep them in sync.
 *
 * Hard rules:
 *   - Every pure-logic function (everything except renderChart / renderSiteChart) must be
 *     free of any `document` / `window` reference so Node can `require()` this file for the
 *     headless test harness. The two DOM functions reference the DOM only INSIDE their body,
 *     so `node --check` and `require()` stay safe (nothing runs at load time).
 *   - No build step, no dependencies. Attaches to a global `OrgChartCore` and also exports
 *     via CommonJS when running under Node.
 *
 * Node shape (matches the org JSON seed embedded in each rendered page):
 *   { id:<login>, children:[...], data:{ badge_color, badge_url, direct_reports,
 *     direct_reports_with_null_login, is_direct_count_discrepancy_found, is_manager,
 *     full_name, job_title, department_name, building, phone, expanded, manager? } }
 * On any single rendered page only the ROOT carries populated children; every direct report
 * comes back children:[] / direct_reports:0 even when it manages people. The ONLY reliable
 * "has reports to crawl" signal is child.data.is_manager === true.
 */
(function (root, factory) {
  var api = factory();
  // Browser / Tampermonkey global.
  if (typeof window !== 'undefined') { window.OrgChartCore = api; }
  // Node / test harness.
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  // Fallback for other global contexts.
  if (typeof root !== 'undefined' && root && !root.OrgChartCore) { root.OrgChartCore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // extractOrgJson — pull the AC.org_json seed object out of a rendered page.
  // ---------------------------------------------------------------------------
  // A regex over this blob is unsafe: the JSON contains braces inside string
  // values (e.g. "building":"NDC1-Central DC(Lincoln,NE,US)") and escaped quotes.
  // We do a string-aware, escape-aware balanced-brace scan starting at the first
  // `{` after the literal text `AC.org_json`.
  function extractOrgJson(html) {
    if (typeof html !== 'string') { return null; }
    var marker = 'AC.org_json';
    var mi = html.indexOf(marker);
    if (mi === -1) { return null; }
    var start = html.indexOf('{', mi + marker.length);
    if (start === -1) { return null; }

    var depth = 0;
    var inStr = false;
    var strCh = '';
    var esc = false;
    for (var i = start; i < html.length; i++) {
      var c = html.charAt(i);
      if (inStr) {
        if (esc) { esc = false; }           // previous char was a backslash
        else if (c === '\\') { esc = true; } // start of an escape sequence
        else if (c === strCh) { inStr = false; } // closing quote
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
      if (c === '{') { depth++; }
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          var jsonText = html.slice(start, i + 1);
          try { return JSON.parse(jsonText); } catch (e) { return null; }
        }
      }
    }
    return null; // unbalanced — no complete object found
  }

  // ---------------------------------------------------------------------------
  // Site helpers. Site code = substring before the first '-' in building, exact match.
  //   "NDC1-Central DC(Lincoln,NE,US)" -> "NDC1"
  // ---------------------------------------------------------------------------
  function parseSiteCode(building) {
    if (!building) { return null; }
    var s = String(building);
    var idx = s.indexOf('-');
    var code = (idx === -1 ? s : s.slice(0, idx)).trim();
    return code || null;
  }

  function siteOf(node) {
    if (!node || !node.data) { return null; }
    return parseSiteCode(node.data.building);
  }

  // ---------------------------------------------------------------------------
  // normalizeSeed — guarantee a `children` array and a `data` object on every node.
  // Non-mutating-safe: operates in place but tolerant of partial seeds.
  // ---------------------------------------------------------------------------
  function normalizeSeed(seed) {
    if (!seed || typeof seed !== 'object') { return seed; }
    if (!Array.isArray(seed.children)) { seed.children = []; }
    if (!seed.data || typeof seed.data !== 'object') { seed.data = {}; }
    for (var i = 0; i < seed.children.length; i++) {
      normalizeSeed(seed.children[i]);
    }
    return seed;
  }

  // ---------------------------------------------------------------------------
  // buildParentMap — Map<login, parentNode|null>. Root maps to null.
  // ---------------------------------------------------------------------------
  function buildParentMap(root) {
    var map = new Map();
    if (!root) { return map; }
    map.set(root.id, null);
    (function walk(node) {
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        map.set(kids[i].id, node);
        walk(kids[i]);
      }
    })(root);
    return map;
  }

  // ---------------------------------------------------------------------------
  // buildTree — crawl adapter. fetchSeed(login) -> Promise<seedObject> is injected
  // (production feeds `fetch`; tests feed a static map). The anchor's children are its
  // direct reports; for each child with data.is_manager===true we fetch THAT child's own
  // page to discover ITS reports, recursing.
  //
  // opts: { concurrency=10, onProgress(done,total), memo=Map, maxDepth=26, signal }
  //   - memoize by login so a person is fetched once (no refetch, no cycles)
  //   - ONE global semaphore caps total in-flight fetches at `concurrency` across the
  //     WHOLE recursion (no per-level pool, so no concurrency^depth fan-out / throttling)
  //   - on a failed fetch: child.children=[] + child.data._fetchError=true, keep going
  // ---------------------------------------------------------------------------
  function buildTree(anchorLogin, fetchSeed, opts) {
    opts = opts || {};
    var concurrency = opts.concurrency || 10;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var memo = opts.memo instanceof Map ? opts.memo : new Map();
    var maxDepth = opts.maxDepth != null ? opts.maxDepth : 26;
    var signal = opts.signal || null;

    var done = 0;
    var total = 1;

    function aborted() { return signal && signal.aborted; }

    // ONE global concurrency limiter shared across the ENTIRE recursive crawl, so the
    // total number of in-flight fetchSeed calls never exceeds `concurrency` regardless
    // of recursion depth. (The old per-level pool spawned a fresh pool per expand()
    // level, so in-flight work grew ~concurrency^depth and tripped server-side throttling.)
    function makeSemaphore(max) {
      var active = 0, waiters = [];
      function acquire() {
        return new Promise(function (res) {
          if (active < max) { active++; res(); }
          else { waiters.push(res); }
        });
      }
      function release() {
        active--;
        if (waiters.length) { active++; waiters.shift()(); }
      }
      return { acquire: acquire, release: release };
    }
    var sem = makeSemaphore(concurrency);

    // Fetch-once wrapper (memoized by login). Only the NETWORK call is gated by the
    // semaphore; release runs exactly once on both success and failure. Returns a Promise
    // of the normalized seed (or null on error — the injected fetchSeed owns retrying).
    function fetchOnce(login) {
      if (memo.has(login)) { return memo.get(login); }
      var p = sem.acquire()
        .then(function () { return Promise.resolve().then(function () { return fetchSeed(login); }); })
        .then(function (seed) { return normalizeSeed(seed); })
        .catch(function () { return null; })
        .then(function (result) { sem.release(); return result; });
      memo.set(login, p);
      return p;
    }

    // Expand one node: for each is_manager child, fetch its reports and recurse. Every
    // fetch funnels through the one semaphore above, so total in-flight stays bounded and
    // recursion depth never multiplies the load.
    function expand(node, depth) {
      if (aborted() || depth >= maxDepth) { return Promise.resolve(); }
      var kids = node.children || [];
      var managerKids = [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i] && kids[i].data && kids[i].data.is_manager === true) {
          managerKids.push(kids[i]);
        }
      }
      total += managerKids.length;
      return Promise.all(managerKids.map(function (child) {
        return fetchOnce(child.id).then(function (childSeed) {
          if (aborted()) { return; }
          if (!childSeed) {
            child.children = [];
            child.data._fetchError = true;
          } else {
            child.children = childSeed.children || [];
          }
          done++;
          if (onProgress) { onProgress(done, total); }
          return expand(child, depth + 1);
        });
      }));
    }

    return fetchOnce(anchorLogin).then(function (rootSeed) {
      if (!rootSeed) {
        // Anchor itself failed — return a minimal stub so callers can degrade gracefully.
        return normalizeSeed({ id: anchorLogin, children: [], data: { _fetchError: true } });
      }
      done++;
      if (onProgress) { onProgress(done, total); }
      return expand(rootSeed, 0).then(function () { return rootSeed; });
    });
  }

  // ---------------------------------------------------------------------------
  // collectSiteMembers — every node whose site code equals siteCode (exact).
  // ---------------------------------------------------------------------------
  function collectSiteMembers(root, siteCode) {
    var out = [];
    if (!root) { return out; }
    (function walk(node) {
      if (siteOf(node) === siteCode) { out.push(node); }
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) { walk(kids[i]); }
    })(root);
    return out;
  }

  // ---------------------------------------------------------------------------
  // computeLCA — lowest common ancestor of a set of nodes via parent-map paths.
  //   one node   -> returns that node
  //   zero nodes -> null
  // A site split under two different managers resolves up to their shared ancestor
  // (a site reporting under two GMs resolves to their shared regional director).
  // ---------------------------------------------------------------------------
  function computeLCA(root, nodes) {
    if (!nodes || nodes.length === 0) { return null; }
    var parentMap = buildParentMap(root);

    function pathToRoot(node) {
      var path = [];
      var cur = node;
      while (cur) { path.push(cur); cur = parentMap.get(cur.id); }
      return path.reverse(); // [root, ..., node]
    }

    var paths = nodes.map(pathToRoot);
    var minLen = paths[0].length;
    for (var i = 1; i < paths.length; i++) {
      if (paths[i].length < minLen) { minLen = paths[i].length; }
    }

    var lca = null;
    for (var d = 0; d < minLen; d++) {
      var candidate = paths[0][d];
      var allSame = true;
      for (var j = 1; j < paths.length; j++) {
        if (paths[j][d] !== candidate) { allSame = false; break; }
      }
      if (allSame) { lca = candidate; } else { break; }
    }
    return lca;
  }

  // ---------------------------------------------------------------------------
  // distinctSites — sorted unique site codes present in the tree.
  // ---------------------------------------------------------------------------
  function distinctSites(root) {
    var set = {};
    (function walk(node) {
      if (!node) { return; }
      var code = siteOf(node);
      if (code) { set[code] = true; }
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) { walk(kids[i]); }
    })(root);
    return Object.keys(set).sort();
  }

  // ---------------------------------------------------------------------------
  // deriveTitleTiers — group the DISTINCT job titles present in a tree into tiers by
  // their REPORTING RELATIONSHIPS (not raw tree depth), then order the tiers from the
  // MOST SENIOR (top) down to the deepest/most-junior (bottom). Pure (no DOM); used by
  // the hide-levels panel.
  //
  // Algorithm (relationship-based, grouped, outlier-robust):
  //   1. Walk the tree once. For every parent node with a non-empty data.job_title P that
  //      has a direct child with a non-empty title C, increment edge[C][P] (child-title ->
  //      parent-title counts). Track each title's total occurrence count[] and first-seen
  //      order seq[].
  //   2. Each title's DOMINANT parent = the parent title it most frequently reports to
  //      (max edge count). Ties: higher parent occurrence count, then lower parent seq. A
  //      title with no incoming parent-title edge (the anchor/root title) has no dominant
  //      parent.
  //   3. layer(t) = 0 if the dominant parent is absent/null; otherwise layer(dominant)+1,
  //      memoized with an in-progress guard that breaks any cycle by treating the current
  //      title's dominant parent as null. Because only the DOMINANT edge is followed, a
  //      single outlier edge never changes a title's layer — e.g. a plain 'Area Manager'
  //      that USUALLY reports to an Operations Manager but has ONE instance under the
  //      General Manager still layers with the other Area Managers (dominant parent = OM).
  //   4. Group titles by layer; titles sharing a layer form ONE tier. Compact the layer
  //      numbers to a contiguous 0..n and set tierIndex = compacted position.
  //
  // CONVENTION: tierIndex 0 = the MOST SENIOR (top) tier; tierIndex increases DOWNWARD to
  // the deepest/most-junior tier. The returned array is ordered senior -> junior so
  // tiers[i].tierIndex === i and the panel can render in array order (senior at top,
  // Process Assistant/deepest at the bottom). Returns [{ tierIndex, titles:[...] }].
  // Within a tier, titles are ordered by first-seen seq (deterministic; the whole tier
  // shares one checkbox so intra-tier order is cosmetic). Empty/missing titles are ignored.
  // ---------------------------------------------------------------------------
  function deriveTitleTiers(root) {
    var edge = {};   // childTitle -> { parentTitle: count }
    var count = {};  // title -> total occurrences
    var seq = {};    // title -> first-seen order
    var assocTitle = {}; // title -> true if any node carrying it is flagged isAssociate
    var seqN = 0;
    (function walk(node) {
      if (!node) { return; }
      var title = node.data && node.data.job_title;
      if (title) {
        if (!Object.prototype.hasOwnProperty.call(count, title)) { count[title] = 0; seq[title] = seqN++; }
        count[title] += 1;
        if (node.data.isAssociate) { assocTitle[title] = true; }
      }
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        var ctitle = child && child.data && child.data.job_title;
        if (title && ctitle) {
          if (!edge[ctitle]) { edge[ctitle] = {}; }
          edge[ctitle][title] = (edge[ctitle][title] || 0) + 1;
        }
        walk(child);
      }
    })(root);

    var titles = Object.keys(count);

    // (2) dominant parent per title (null when it never reports to a present title).
    var dom = {};
    titles.forEach(function (t) {
      var parents = edge[t];
      if (!parents) { dom[t] = null; return; }
      var best = null, bestCount = -1;
      Object.keys(parents).forEach(function (p) {
        var c = parents[p];
        if (c > bestCount) { best = p; bestCount = c; return; }
        if (c === bestCount && best !== null) {
          // tie-break: higher parent occurrence count, then lower parent first-seen seq.
          if (count[p] > count[best] || (count[p] === count[best] && seq[p] < seq[best])) {
            best = p;
          }
        }
      });
      dom[t] = best;
    });

    // (3) layer via the dominant-parent chain (memoized, cycle-guarded).
    var layer = {};
    var inProgress = {};
    function computeLayer(t) {
      if (Object.prototype.hasOwnProperty.call(layer, t)) { return layer[t]; }
      var p = dom[t];
      if (p === null || !Object.prototype.hasOwnProperty.call(count, p)) { layer[t] = 0; return 0; }
      if (inProgress[t]) { layer[t] = 0; return 0; } // cycle -> treat dominant parent as null
      inProgress[t] = true;
      var l = computeLayer(p) + 1;
      inProgress[t] = false;
      layer[t] = l;
      return l;
    }
    titles.forEach(function (t) { computeLayer(t); });

    // (4) group by layer, then PARTITION on the associate flag: non-associate tiers
    //     emit first (senior->junior, unchanged) and associate tier(s) are appended at
    //     the BOTTOM (most junior). tierIndex stays a contiguous 0..n from a single
    //     counter (0 = most senior). Associates are leaves and never a dominant parent,
    //     so non-associate layering is unchanged; when nothing is flagged isAssociate the
    //     associate bucket is empty and the output is byte-for-byte identical to before.
    function groupByLayer(list) {
      var byLayer = {};
      list.forEach(function (t) {
        var l = layer[t];
        if (!byLayer[l]) { byLayer[l] = []; }
        byLayer[l].push(t);
      });
      var layerNums = Object.keys(byLayer).map(Number).sort(function (a, b) { return a - b; });
      var groups = [];
      for (var i = 0; i < layerNums.length; i++) {
        var ts = byLayer[layerNums[i]];
        ts.sort(function (a, b) { return seq[a] - seq[b]; });
        groups.push(ts);
      }
      return groups;
    }
    var nonAssoc = [], assoc = [];
    titles.forEach(function (t) { (assocTitle[t] ? assoc : nonAssoc).push(t); });
    var out = [];
    var tierIndex = 0;
    groupByLayer(nonAssoc).forEach(function (ts) { out.push({ tierIndex: tierIndex++, titles: ts }); });
    groupByLayer(assoc).forEach(function (ts) { out.push({ tierIndex: tierIndex++, titles: ts }); });
    return out;
  }

  // ---------------------------------------------------------------------------
  // pruneToSite — deep-clone the subtree rooted at `lca`, KEEPING a node iff it is a
  // site member OR has a member anywhere in its subtree. `lca` is always kept and
  // becomes the displayed TOP. Drops branches with no members (irrelevant people).
  // ---------------------------------------------------------------------------
  function pruneToSite(lca, siteCode) {
    if (!lca) { return null; }
    function clone(node) {
      var kids = node.children || [];
      var keptChildren = [];
      for (var i = 0; i < kids.length; i++) {
        var c = clone(kids[i]);
        if (c) { keptChildren.push(c); }
      }
      var isMember = siteOf(node) === siteCode;
      if (isMember || keptChildren.length > 0) {
        return { id: node.id, children: keptChildren, data: node.data };
      }
      return null;
    }
    var result = clone(lca);
    // lca is always kept even if (defensively) it had no members below.
    if (!result) { result = { id: lca.id, children: [], data: lca.data }; }
    return result;
  }

  // ---------------------------------------------------------------------------
  // normalizeName — canonical comparison form for a person name. A
  // "Last,First[,Middle]" form is rebuilt as "First[ Middle] Last"; a plain
  // "First [Middle] Last" is left as-is. The result is lowercased with internal
  // whitespace collapsed, so comparison is case/space-insensitive and order-agnostic
  // across the two orderings. Used only for name-based manager matching. Pure.
  // ---------------------------------------------------------------------------
  function normalizeName(name) {
    if (!name) { return ''; }
    var s = String(name).trim();
    if (s.indexOf(',') !== -1) {
      var parts = s.split(',');
      var last = (parts.shift() || '').trim();
      var given = parts.join(' ').replace(/\s+/g, ' ').trim();
      s = (given ? given + ' ' : '') + last;
    }
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------------
  // graftAssociates — append "associate" leaf nodes under their matched manager
  // node, mutating treeRoot in place. Generic and host-agnostic: no DOM, no network,
  // no external/product strings. Each associate is { login, full_name, job_title,
  // building, badge_url, managerLogin?, managerName? }. For each associate, in order:
  //   DEDUP:  skip when login is missing or already present anywhere in treeRoot
  //           (so people already in the tree are never duplicated).
  //   (1)     managerLogin set AND a node with that login exists -> graft under it.
  //   (2)     else normalizeName(managerName) matches EXACTLY ONE tree node's
  //           full_name -> graft under it (zero matches, or 2+ ambiguous matches,
  //           is NOT a unique match).
  //   (3)     otherwise DROP the associate.
  // Each grafted node is registered in all three indexes so later associates can
  // dedup and match against it. Returns { added, dropped } (deduped/skipped
  // associates are counted as neither). Pure aside from mutating manager.children.
  // ---------------------------------------------------------------------------
  function graftAssociates(treeRoot, associates) {
    var result = { added: 0, dropped: 0 };
    if (!treeRoot || !Array.isArray(associates)) { return result; }

    var logins = new Set();   // every login present in the tree
    var byLogin = new Map();  // login -> node
    var byName = new Map();   // normalized full_name -> [node, ...]
    var siteMap = {};         // site code -> full building display string (first full one wins)
    (function index(node) {
      if (!node) { return; }
      if (node.id) { logins.add(node.id); byLogin.set(node.id, node); }
      var key = normalizeName(node.data && node.data.full_name);
      if (key) {
        if (!byName.has(key)) { byName.set(key, []); }
        byName.get(key).push(node);
      }
      // Site-code -> full building-name map, built from the people already in the tree. Only
      // a FULL building string (the "CODE-Descriptor" form, i.e. it contains a '-') is
      // map-worthy; a bare site code is skipped. The first full building seen for a code wins.
      var b = node.data && node.data.building;
      if (b && String(b).indexOf('-') !== -1) {
        var code = parseSiteCode(b);
        if (code && !Object.prototype.hasOwnProperty.call(siteMap, code)) { siteMap[code] = b; }
      }
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) { index(kids[i]); }
    })(treeRoot);

    for (var a = 0; a < associates.length; a++) {
      var assoc = associates[a];
      if (!assoc || !assoc.login) { continue; }
      if (logins.has(assoc.login)) { continue; } // dedup — already in the tree

      var manager = null;
      if (assoc.managerLogin && byLogin.has(assoc.managerLogin)) {
        manager = byLogin.get(assoc.managerLogin);
      } else {
        var mkey = normalizeName(assoc.managerName);
        if (mkey && byName.has(mkey)) {
          var matches = byName.get(mkey);
          if (matches.length === 1) { manager = matches[0]; }
        }
      }
      if (!manager) { result.dropped++; continue; }

      // Resolve the associate's building from the site-code map keyed by the associate's OWN
      // site code (not the manager's), so a cross-site manager never contributes a wrong
      // building. Fallbacks, in order: (a) a site-code map hit upgrades a bare "NDC1" to the
      // full "NDC1-...(City,ST)"; (b) otherwise the building the record already carries (a
      // full string the roster/host supplied, if any); (c) otherwise the bare value as-is.
      var assocBuilding = assoc.building;
      var assocCode = parseSiteCode(assocBuilding);
      if (assocCode && Object.prototype.hasOwnProperty.call(siteMap, assocCode)) {
        assocBuilding = siteMap[assocCode];
      }

      var newNode = {
        id: assoc.login,
        children: [],
        data: {
          full_name: assoc.full_name,
          job_title: assoc.job_title,
          building: assocBuilding,
          badge_url: assoc.badge_url,
          login: assoc.login,
          isAssociate: true
        }
      };
      if (!Array.isArray(manager.children)) { manager.children = []; }
      manager.children.push(newNode);
      logins.add(newNode.id);
      byLogin.set(newNode.id, newNode);
      var nkey = normalizeName(assoc.full_name);
      if (nkey) {
        if (!byName.has(nkey)) { byName.set(nkey, []); }
        byName.get(nkey).push(newNode);
      }
      result.added++;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // layout — pure, no DOM. Fit-to-viewport tidy tree that is FLAT by default: exactly
  // ONE row per depth. Every node at a given depth shares the same baseline y, so
  // siblings always sit side-by-side on the same aligned row and never offset onto
  // different rows (no vertical stagger, so a parent's children never read like a
  // chain). Width-fit is achieved by uniformly SCALING the whole chart down, not by
  // staggering: a tree wider than the viewport is drawn flat and scaled to fit, so it
  // never scrolls horizontally at 1080p/4K. When the flat content is NARROWER than the
  // viewport the horizontal gap is spread to FILL the width (capped so a 2-3 node chart
  // doesn't stretch absurdly). Parents stay centered over their children.
  //
  // Returns { nodes:[{node,x,y,w,h,depth}], edges:[{from,to}], bounds:{w,h},
  //           scale, offsetX, offsetY, tiers, spread }. (`tiers`/`spread` are additive;
  //           existing callers read only the pre-existing fields.)
  //
  // Math (see inline comments):
  //  1. tiers: FLAT by default (tiers=1). opts.tiers overrides, but nothing in the app
  //     passes >1 (only tests request a deterministic multi-row baseline for comparison).
  //  2. Pass 1 (post-order) places x via a left-to-right leaf cursor whose per-leaf
  //     advance is (chipW+hGap)/tiers; internal nodes center over their children. Each
  //     node's descendant-leaf span is a disjoint ordered interval, so x stays strictly
  //     ordered within a depth.
  //  3. Pass 2 groups nodes by depth, sorts each band by x, assigns tier = rank % tiers
  //     with y = depth*rowH + tier*tierStep. With the default tiers=1 this collapses to
  //     y = depth*rowH, i.e. every node at a depth shares ONE baseline y (flat aligned
  //     rows). Adjacent leaves stay exactly chipW+hGap apart, so no chips overlap.
  //  4. FILL width: if the raw content is narrower than availableWidth, multiply every x
  //     by spread = min(availableWidth/rawBoundsW, maxSlot/leafStep) (>= 1), so the chart
  //     spans most of the viewport. maxSlot = maxSlotFactor*chipW caps the effective
  //     per-leaf slot so 2-3 nodes don't stretch absurdly. Scaling x around 0 preserves
  //     parent-over-children centering and strict x-order, so gaps only grow => no new
  //     overlap.
  //  5. scale = min(viewportW/bounds.w, viewportH/bounds.h, maxScale). A wide flat tree
  //     scales DOWN here so bounds.w*scale <= viewportW (no horizontal scroll). Content
  //     is centered via offsetX/offsetY.
  // ---------------------------------------------------------------------------
  function layout(root, viewportW, viewportH, opts) {
    opts = opts || {};
    var chipW = opts.chipW != null ? opts.chipW : 190;
    var chipH = opts.chipH != null ? opts.chipH : 104;
    var hGap = opts.hGap != null ? opts.hGap : 26;
    var vGap = opts.vGap != null ? opts.vGap : 74;
    var tierGap = opts.tierGap != null ? opts.tierGap : 20;
    var maxScale = opts.maxScale != null ? opts.maxScale : 1;
    var maxTiers = opts.maxTiers != null ? opts.maxTiers : 6;
    var margin = opts.margin != null ? opts.margin : 40;
    var maxSlotFactor = opts.maxSlotFactor != null ? opts.maxSlotFactor : 2.2;

    // leafCount — nodes with no children; the horizontal slot demand at tiers=1.
    var leafCount = 0;
    (function countLeaves(node) {
      if (!node) { return; }
      var kids = node.children || [];
      if (kids.length === 0) { leafCount++; return; }
      for (var ci = 0; ci < kids.length; ci++) { countLeaves(kids[ci]); }
    })(root);

    var availableWidth = Math.max(1, viewportW - 2 * margin);

    // =======================================================================
    // LEGACY BRANCH — opts.tiers != null runs the original uniform-tier body
    // VERBATIM (the test harness passes {tiers:3}/{tiers:1} as flat/multi-row
    // comparison baselines). The compact packer below runs only when tiers==null.
    // =======================================================================
    if (opts.tiers != null) {
      var tiers = opts.tiers;
      if (tiers < 1) { tiers = 1; }

      var tierStep = chipH + tierGap;
      var rowH = (tiers - 1) * tierStep + chipH + vGap;
      var leafStep = (chipW + hGap) / tiers;

      var nodes = [];
      var edges = [];
      var cursor = 0; // left edge (px) of the next leaf slot

      // Pass 1 — post-order placement. Leaves consume one (reduced) slot; internal
      // nodes center over their first..last child and push their parent->child edges.
      function place(node, depth) {
        var kids = node.children || [];
        var x;
        if (kids.length === 0) {
          x = cursor;
          cursor += leafStep;
        } else {
          var firstX = null, lastX = null;
          for (var i = 0; i < kids.length; i++) {
            var cx = place(kids[i], depth + 1);
            if (firstX === null) { firstX = cx; }
            lastX = cx;
            edges.push({ from: node.id, to: kids[i].id });
          }
          // Center the parent over the span of its children.
          x = (firstX + lastX) / 2;
        }
        nodes.push({ node: node, x: x, y: 0, w: chipW, h: chipH, depth: depth });
        return x;
      }
      if (root) { place(root, 0); }

      // Pass 2 — tier assignment. Group by depth, sort each band by x, then cycle
      // through `tiers` vertical tiers by horizontal rank.
      var byDepth = {};
      for (var n = 0; n < nodes.length; n++) {
        var dkey = nodes[n].depth;
        if (!byDepth[dkey]) { byDepth[dkey] = []; }
        byDepth[dkey].push(nodes[n]);
      }
      for (var gk in byDepth) {
        if (!byDepth.hasOwnProperty(gk)) { continue; }
        var group = byDepth[gk];
        group.sort(function (a, b) { return a.x - b.x; });
        for (var r = 0; r < group.length; r++) {
          var tier = r % tiers;
          group[r].y = group[r].depth * rowH + tier * tierStep;
        }
      }

      // Raw horizontal extent (pre-spread) — rightmost chip edge.
      var rawMaxX = 0;
      for (var p = 0; p < nodes.length; p++) {
        if (nodes[p].x > rawMaxX) { rawMaxX = nodes[p].x; }
      }
      var rawBoundsW = rawMaxX + chipW;

      // FILL width — spread nodes horizontally when the content is narrower than the
      // available width. Cap the per-leaf slot at maxSlot so a 2-3-node chart doesn't
      // stretch absurdly on a big screen. spread >= 1 (never compress).
      var spread = 1;
      if (rawBoundsW > 0 && rawBoundsW < availableWidth) {
        var maxSlot = maxSlotFactor * chipW;
        spread = Math.min(availableWidth / rawBoundsW, maxSlot / leafStep);
        if (!isFinite(spread) || spread < 1) { spread = 1; }
      }
      if (spread > 1) {
        for (var s = 0; s < nodes.length; s++) { nodes[s].x *= spread; }
      }

      // Bounds: rightmost chip edge and lowest chip edge (after spread).
      var maxX = 0, maxBottom = 0;
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k].x > maxX) { maxX = nodes[k].x; }
        var bottom = nodes[k].y + chipH;
        if (bottom > maxBottom) { maxBottom = bottom; }
      }
      var bounds = { w: maxX + chipW, h: maxBottom };
      if (bounds.w <= 0) { bounds.w = chipW; }
      if (bounds.h <= 0) { bounds.h = chipH; }

      var scale = Math.min(viewportW / bounds.w, viewportH / bounds.h, maxScale);
      if (!isFinite(scale) || scale <= 0) { scale = maxScale; }
      var offsetX = (viewportW - bounds.w * scale) / 2;
      var offsetY = (viewportH - bounds.h * scale) / 2;

      return {
        nodes: nodes, edges: edges, bounds: bounds,
        scale: scale, offsetX: offsetX, offsetY: offsetY,
        tiers: tiers, spread: spread
      };
    }

    // =======================================================================
    // COMPACT "BRICK-LAY" PACKER — opts.tiers == null (the default/app path).
    // Wide sibling groups stack into k vertically-disjoint LANES (sub-rows) with
    // odd lanes shifted right by a brick offset, chosen per group by a whole-tree
    // fit-scale hill-climb so the chart fills BOTH viewport dimensions with bigger
    // chips. Narrow/deep groups stay FLAT (one row per depth). When the winning
    // assignment is fully flat the output is node-for-node identical to the legacy
    // tiers=1 layout (flat-equivalence), so the untouched tests stay green.
    // =======================================================================
    var slot = chipW + hGap;                 // 216 — flat per-leaf pitch
    var brickShift = slot / 2;               // 108 — odd-lane horizontal offset

    // Compact opts (clamped). maxLanes default 8 (pinned decision), [1,8].
    var maxLanes = opts.maxLanes != null ? Math.round(opts.maxLanes) : 8;
    if (!isFinite(maxLanes)) { maxLanes = 8; }
    if (maxLanes < 1) { maxLanes = 1; }
    if (maxLanes > 8) { maxLanes = 8; }
    var laneGap = opts.laneGap != null ? opts.laneGap : tierGap; // default 20
    if (!isFinite(laneGap) || laneGap < 0) { laneGap = 0; }
    var minStaggerGroup = opts.minStaggerGroup != null ? Math.round(opts.minStaggerGroup) : 4;
    if (!isFinite(minStaggerGroup) || minStaggerGroup < 1) { minStaggerGroup = 1; }
    var gutterW = opts.gutterW != null ? opts.gutterW : hGap; // default 26
    if (!isFinite(gutterW) || gutterW < 0) { gutterW = 0; }
    var staggerStepBudget = opts.staggerStepBudget != null ? Math.round(opts.staggerStepBudget) : 64;
    if (!isFinite(staggerStepBudget) || staggerStepBudget < 0) { staggerStepBudget = 0; }
    if (staggerStepBudget > 4096) { staggerStepBudget = 4096; }

    // Finite-viewport guard for the scale math (DOM caller already defaults sizes).
    var vW = (isFinite(viewportW) && viewportW > 0) ? viewportW : 1920;
    var vH = (isFinite(viewportH) && viewportH > 0) ? viewportH : 1080;
    var availW = Math.max(1, vW - 2 * margin);

    // Empty tree — same drawable empty result as before.
    if (!root) {
      return {
        nodes: [], edges: [], bounds: { w: chipW, h: chipH },
        scale: maxScale, offsetX: 0, offsetY: 0, tiers: 1, spread: 1,
        lanes: [], routingFailures: 0
      };
    }

    // Coarse guard for pathological trees: cap lanes/budget so layout time stays bounded.
    var totalNodes = 0;
    (function countAll(node) {
      if (!node) { return; }
      totalNodes++;
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) { countAll(kids[i]); }
    })(root);
    if (totalNodes > 1500) {
      if (maxLanes > 2) { maxLanes = 2; }
      if (staggerStepBudget > 16) { staggerStepBudget = 16; }
    }

    // --- packGroup: pack one node's child group into k lanes (design §6.2). Pure.
    // Returns a block with w/h/k/rootCx, this node's chip left (selfLeft), and the
    // relative placements of each child block (dx/dy/lane) plus laneTopY for routing.
    function packGroup(node, childBlocks, k) {
      var m = childBlocks.length;
      if (m === 0) {
        return {
          node: node, w: chipW, h: chipH, k: 1, rootCx: chipW / 2,
          selfLeft: 0, childPlacements: [], laneTopY: [0]
        };
      }
      if (k > m) { k = m; }
      if (k < 1) { k = 1; }
      var gutterOffset = (k > 1) ? gutterW : 0;

      // (1) round-robin lane assignment; (2) brick offset on odd lanes.
      var laneCursor = [], laneHeight = [];
      for (var j = 0; j < k; j++) {
        laneCursor[j] = gutterOffset + (j % 2) * brickShift;
        laneHeight[j] = 0;
      }
      var laneOf = [], childLaneX = [];
      for (var i = 0; i < m; i++) {
        var lane = i % k;
        laneOf[i] = lane;
        childLaneX[i] = laneCursor[lane];
        laneCursor[lane] = childLaneX[i] + childBlocks[i].w + hGap;
        if (childBlocks[i].h > laneHeight[lane]) { laneHeight[lane] = childBlocks[i].h; }
      }

      // (3) vertical lane bands (strict, non-overlapping).
      var laneTopY = [];
      laneTopY[0] = chipH + vGap;
      for (var jj = 0; jj < k - 1; jj++) {
        laneTopY[jj + 1] = laneTopY[jj] + laneHeight[jj] + laneGap;
      }
      var groupBottom = laneTopY[k - 1] + laneHeight[k - 1];

      // (4) tidy-tree parent centering over leftmost/rightmost child chip-centers.
      var minChildCx = Infinity, maxChildCx = -Infinity;
      for (var c = 0; c < m; c++) {
        var ccx = childLaneX[c] + childBlocks[c].rootCx;
        if (ccx < minChildCx) { minChildCx = ccx; }
        if (ccx > maxChildCx) { maxChildCx = ccx; }
      }
      var parentCx = (minChildCx + maxChildCx) / 2;

      // (5)(6) normalize: only a left-overhanging parent chip shifts the block right;
      // minLeft = min(parentCx - chipW/2, 0) KEEPS the gutter corridor at local x>=0.
      var minLeft = Math.min(parentCx - chipW / 2, 0);
      var selfLeft = parentCx - chipW / 2 - minLeft;
      var maxRight = selfLeft + chipW;
      var childPlacements = [];
      for (var d = 0; d < m; d++) {
        var dx = childLaneX[d] - minLeft;
        var dy = laneTopY[laneOf[d]];
        childPlacements.push({ block: childBlocks[d], dx: dx, dy: dy, lane: laneOf[d] });
        var right = dx + childBlocks[d].w;
        if (right > maxRight) { maxRight = right; }
      }

      return {
        node: node, w: maxRight, h: groupBottom, k: k, rootCx: parentCx - minLeft,
        selfLeft: selfLeft, childPlacements: childPlacements, laneTopY: laneTopY
      };
    }

    // --- buildBlocks: pure post-order build of the root block for an assignment map.
    function buildBlocks(assign) {
      function rec(node) {
        var kids = node.children || [];
        var childBlocks = [];
        for (var i = 0; i < kids.length; i++) { childBlocks.push(rec(kids[i])); }
        return packGroup(node, childBlocks, (assign.get(node) || 1));
      }
      return rec(root);
    }

    // --- scoreOf: whole-tree fit-scale on RAW (pre-spread) bounds (design §6.4).
    function scoreOf(assign) {
      var rb = buildBlocks(assign);
      var bw = rb.w, bh = rb.h;
      if (bw <= 0) { bw = chipW; }
      if (bh <= 0) { bh = chipH; }
      return Math.min(vW / bw, vH / bh, maxScale);
    }

    // --- fit-scale hill-climb: start flat, add one lane at a time only while it
    // strictly raises the whole-tree fit-scale (design §6.4). Deterministic (fixed
    // pre-order scan + strict > tie-break). scale >= scoreOf(flat) always.
    var internal = [];
    (function pre(node) {
      var kids = node.children || [];
      if (kids.length > 0) { internal.push(node); }
      for (var i = 0; i < kids.length; i++) { pre(kids[i]); }
    })(root);

    var assign = new Map();
    var best = scoreOf(assign);
    for (var step = 0; step < staggerStepBudget; step++) {
      var pickNode = null, pickScore = best;
      for (var ii = 0; ii < internal.length; ii++) {
        var N = internal[ii];
        var cc = (N.children || []).length;
        if (cc < minStaggerGroup) { continue; }
        var curK = assign.get(N) || 1;
        var capK = Math.min(maxLanes, cc);
        if (curK >= capK) { continue; }
        assign.set(N, curK + 1);
        var sc = scoreOf(assign);
        assign.set(N, curK);
        if (sc > pickScore + 1e-6) { pickScore = sc; pickNode = N; }
      }
      if (!pickNode) { break; }
      assign.set(pickNode, (assign.get(pickNode) || 1) + 1);
      best = pickScore;
    }

    // tiers (redefined) = max lane count chosen by any group (1 when fully flat).
    var maxK = 1;
    assign.forEach(function (v) { if (v > maxK) { maxK = v; } });

    // --- absolute placement (design §6.5). Emit nodes + raw edge records with the
    // lane/group geometry each child needs for routing.
    var nodes = [];
    var rawEdges = [];
    var rootBlock = buildBlocks(assign);
    (function emit(block, ox, oy, depth) {
      nodes.push({ node: block.node, x: ox + block.selfLeft, y: oy, w: chipW, h: chipH, depth: depth });
      for (var i = 0; i < block.childPlacements.length; i++) {
        var cp = block.childPlacements[i];
        rawEdges.push({
          from: block.node.id, to: cp.block.node.id, lane: cp.lane, k: block.k,
          groupLeftX: ox, laneTopYAbs: oy + block.laneTopY[cp.lane]
        });
        emit(cp.block, ox + cp.dx, oy + cp.dy, depth + 1);
      }
    })(rootBlock, 0, 0, 0);

    // --- spread-to-fill, then bounds/scale/offsets (design §6.6). Identical math to
    // the legacy path; flat output therefore matches legacy node-for-node.
    var rawMaxX = 0;
    for (var p = 0; p < nodes.length; p++) {
      if (nodes[p].x > rawMaxX) { rawMaxX = nodes[p].x; }
    }
    var rawBoundsW = rawMaxX + chipW;
    var spread = 1;
    if (rawBoundsW > 0 && rawBoundsW < availW) {
      var maxSlot = maxSlotFactor * chipW;
      spread = Math.min(availW / rawBoundsW, maxSlot / slot);
      if (!isFinite(spread) || spread < 1) { spread = 1; }
    }
    if (spread > 1) {
      for (var s = 0; s < nodes.length; s++) { nodes[s].x *= spread; }
      for (var re = 0; re < rawEdges.length; re++) { rawEdges[re].groupLeftX *= spread; }
    }

    var maxX = 0, maxBottom = 0;
    for (var kk = 0; kk < nodes.length; kk++) {
      if (nodes[kk].x > maxX) { maxX = nodes[kk].x; }
      var bottom = nodes[kk].y + chipH;
      if (bottom > maxBottom) { maxBottom = bottom; }
    }
    var bounds = { w: maxX + chipW, h: maxBottom };
    if (bounds.w <= 0) { bounds.w = chipW; }
    if (bounds.h <= 0) { bounds.h = chipH; }

    var scale = Math.min(vW / bounds.w, vH / bounds.h, maxScale);
    if (!isFinite(scale) || scale <= 0) { scale = maxScale; }
    var offsetX = (vW - bounds.w * scale) / 2;
    var offsetY = (vH - bounds.h * scale) / 2;

    // --- edge routing (design §6.7). Build each edge's orthogonal `points` polyline
    // in post-spread, pre-scale coordinates: flat elbow for lane-0 children, gutter
    // spine for lane j>=1. A safety-net intersection check reroutes any clip.
    var posMap = {};
    var chipRects = [];
    for (var pm = 0; pm < nodes.length; pm++) {
      var nn = nodes[pm];
      posMap[nn.node.id] = nn;
      chipRects.push({ id: nn.node.id, left: nn.x, top: nn.y, right: nn.x + chipW, bottom: nn.y + chipH });
    }
    // leftmost child chip x per parent (for the safety-net reroute widening).
    var minChildLeft = {};
    for (var mc = 0; mc < rawEdges.length; mc++) {
      var pe = rawEdges[mc];
      var chx = posMap[pe.to].x;
      if (minChildLeft[pe.from] == null || chx < minChildLeft[pe.from]) { minChildLeft[pe.from] = chx; }
    }

    var EPS = 1e-6;
    function segHitsRect(x1, y1, x2, y2, rect) {
      var xlo = x1 < x2 ? x1 : x2, xhi = x1 < x2 ? x2 : x1;
      var ylo = y1 < y2 ? y1 : y2, yhi = y1 < y2 ? y2 : y1;
      return xlo < rect.right - EPS && xhi > rect.left + EPS &&
        ylo < rect.bottom - EPS && yhi > rect.top + EPS;
    }
    function pointsClip(points, fromId, toId) {
      for (var si = 0; si < points.length - 1; si++) {
        var a = points[si], b = points[si + 1];
        for (var ri = 0; ri < chipRects.length; ri++) {
          var rect = chipRects[ri];
          if (rect.id === fromId || rect.id === toId) { continue; }
          if (segHitsRect(a[0], a[1], b[0], b[1], rect)) { return true; }
        }
      }
      return false;
    }

    var edges = [];
    var routingFailures = 0;
    for (var ei = 0; ei < rawEdges.length; ei++) {
      var ed = rawEdges[ei];
      var parent = posMap[ed.from], child = posMap[ed.to];
      var xp = parent.x + chipW / 2, yPb = parent.y + chipH;
      var xc = child.x + chipW / 2, yC = child.y;
      var busY = yPb + vGap / 2;
      var points;
      if (ed.lane === 0) {
        points = [[xp, yPb], [xp, busY], [xc, busY], [xc, yC]];
      } else {
        var gx = ed.groupLeftX + gutterW / 2;
        var chTopY = ed.laneTopYAbs - laneGap / 2;
        points = [[xp, yPb], [xp, busY], [gx, busY], [gx, chTopY], [xc, chTopY], [xc, yC]];
      }
      // Safety net: reroute any clip; last resort suppress the stroke (never drawn
      // through a chip). The §6.2.1 proof makes routingFailures===0 the only outcome.
      var clipped = false;
      if (pointsClip(points, ed.from, ed.to)) {
        var gx2 = ed.groupLeftX + gutterW / 2;
        var chTopY2 = (ed.lane === 0 ? (ed.laneTopYAbs != null ? ed.laneTopYAbs : yC) : ed.laneTopYAbs) - laneGap / 2;
        points = [[xp, yPb], [xp, busY], [gx2, busY], [gx2, chTopY2], [xc, chTopY2], [xc, yC]];
        if (pointsClip(points, ed.from, ed.to)) {
          var clearLeft = minChildLeft[ed.from];
          var gx3 = ed.groupLeftX + (clearLeft - ed.groupLeftX) / 2;
          points = [[xp, yPb], [xp, busY], [gx3, busY], [gx3, chTopY2], [xc, chTopY2], [xc, yC]];
          if (pointsClip(points, ed.from, ed.to)) { clipped = true; routingFailures++; }
        }
      }
      var edge = { from: ed.from, to: ed.to, points: points };
      if (clipped) { edge.clipped = true; }
      edges.push(edge);
    }

    // Additive per-node lane summary (debug/tests only; ignored by callers).
    var lanes = [];
    assign.forEach(function (v, node) { if (v > 1) { lanes.push({ id: node.id, k: v }); } });

    return {
      nodes: nodes, edges: edges, bounds: bounds,
      scale: scale, offsetX: offsetX, offsetY: offsetY,
      tiers: maxK, spread: spread,
      lanes: lanes, routingFailures: routingFailures
    };
  }

  // ---------------------------------------------------------------------------
  // createLoadGate — tiny load-state machine + single-flight concurrency guard shared by
  // BOTH hosts' toolbars (production + portfolio). Pure logic: it owns NO DOM, driving the
  // toolbar's dimmed/disabled appearance only through the host-supplied onState callback and
  // kicking off the one host-specific load through runLoad. States:
  //   'not-loaded' — nothing built yet; the toolbar is dimmed and every control disabled, and
  //                  the toolbar itself acts as the "click to load" affordance.
  //   'loading'    — a load is in flight; the toolbar stays dimmed and NON-interactive so no
  //                  second concurrent load can start (the reported bug's fix).
  //   'loaded'     — a chart is shown; the toolbar is enabled and fully active.
  // The single-flight guard is the core guarantee: any load request (site change, reload,
  // re-root, enhance, or a stray toolbar click) that arrives while a load is already in flight
  // is IGNORED (a no-op), never queued, so exactly one load path runs at a time. A failed load
  // never leaves the toolbar stuck — it returns to 'loaded' when a prior chart is still shown,
  // else to 'not-loaded' so the user can retry.
  //
  // opts:
  //   runLoad(trigger, done) — REQUIRED. Kick off ONE load (host-specific: production crawls,
  //     the portfolio "enhances"). Call done(true) on success / done(false) on failure exactly
  //     once; a thrown runLoad is treated as a failure. The trigger value is passed through
  //     verbatim (e.g. a 'reload' / site code) for the host's own use.
  //   onState(state, loading) — OPTIONAL. Invoked with the new state string (and the in-flight
  //     boolean) on every transition, including once at creation with the initial 'not-loaded'.
  // Returns { requestLoad, markLoaded, getState, isLoading, STATES }.
  //   requestLoad(trigger) -> true when THIS call started a load, false when ignored (guard).
  //   markLoaded()         -> force 'loaded' without a load (a chart is already shown); no-op
  //                           while a load is in flight.
  // ---------------------------------------------------------------------------
  function createLoadGate(opts) {
    opts = opts || {};
    var NOT_LOADED = 'not-loaded', LOADING = 'loading', LOADED = 'loaded';
    var runLoad = typeof opts.runLoad === 'function' ? opts.runLoad : null;
    var onState = typeof opts.onState === 'function' ? opts.onState : function () { };
    var state = NOT_LOADED;
    var inFlight = false;
    function emit() { onState(state, inFlight); }
    function requestLoad(trigger) {
      // Single-flight: a request arriving while a load is already running is ignored, so a
      // stray click / dropdown change / reload during LOADING can never start a second load.
      if (inFlight) { return false; }
      if (!runLoad) { return false; }
      var hadChart = (state === LOADED);
      inFlight = true;
      state = LOADING;
      emit();
      var settled = false;
      function done(ok) {
        if (settled) { return; } // tolerate a host that calls done() more than once
        settled = true;
        inFlight = false;
        // Never leave the toolbar permanently stuck/dimmed: success -> LOADED; failure falls
        // back to LOADED when a prior chart is still shown, else NOT_LOADED so the user retries.
        state = ok ? LOADED : (hadChart ? LOADED : NOT_LOADED);
        emit();
      }
      try {
        runLoad(trigger, done);
      } catch (e) {
        done(false);
      }
      return true;
    }
    function markLoaded() {
      if (inFlight) { return; }
      state = LOADED;
      emit();
    }
    function getState() { return state; }
    function isLoading() { return inFlight; }
    emit();
    return {
      requestLoad: requestLoad,
      markLoaded: markLoaded,
      getState: getState,
      isLoading: isLoading,
      STATES: { NOT_LOADED: NOT_LOADED, LOADING: LOADING, LOADED: LOADED }
    };
  }

  // ---------------------------------------------------------------------------
  // roleBorderColors — pure palette generator for the "Color by role" feature. Given the
  // number of title tiers (as returned by deriveTitleTiers, senior -> junior), return an
  // array of CSS border colors indexed by tierIndex: index 0 = the TOP/most-senior tier,
  // the last index = the deepest/most-junior tier. A FIXED hand-tuned palette is assigned
  // straight DOWN by tier index (NOT stretched to the tier count): slot 0 red (the root tier
  // is ALWAYS red), 1 orange, 2 yellow, 3 green, 4 cyan, 5 indigo-blue, 6 purple/pink, and
  // slot 7 is a deliberate "no role color" (null => keep the card's DEFAULT border, same as
  // Color by role OFF). Assignment cycles every 8 (i mod 8), so a rare 9th tier (index 8)
  // wraps back to red. Fewer tiers than slots simply leave later colors unused. Pure (no DOM).
  // ---------------------------------------------------------------------------
  function roleBorderColors(tierCount) {
    var n = (typeof tierCount === 'number' && tierCount > 0) ? Math.floor(tierCount) : 0;
    var PALETTE = [
      '#D11A2A', // 0 red (root)
      '#F57C00', // 1 orange
      '#FFD60A', // 2 yellow
      '#43A047', // 3 green
      '#4DD0E1', // 4 cyan
      '#3F51B5', // 5 indigo-blue
      '#DD3CDD', // 6 purple/pink
      null       // 7 no role color (default border)
    ];
    var out = [];
    for (var i = 0; i < n; i++) { out.push(PALETTE[i % 8]); }
    return out;
  }

  // ===========================================================================
  // DOM functions below. These touch document/window ONLY inside the body, so the
  // module stays Node-requireable. They are never invoked by the headless harness.
  // ===========================================================================

  // renderChart — the ONLY low-level DOM function. Paints absolutely-positioned
  // compact chips onto an inner "stage" that is transform-scaled/translated to fit,
  // and draws edges in an SVG <path> layer underneath.
  //   opts.resolveAvatar(node) -> image src (production: badge_url; portfolio: SVG monogram)
  //   opts.onToggle(node)      -> expand/collapse callback
  //   opts.collapsed           -> Set of collapsed logins (chips drawn with a +)
  function renderChart(container, layoutResult, opts) {
    opts = opts || {};
    var resolveAvatar = typeof opts.resolveAvatar === 'function' ? opts.resolveAvatar : function () { return ''; };
    var onToggle = typeof opts.onToggle === 'function' ? opts.onToggle : null;
    var collapsed = opts.collapsed instanceof Set ? opts.collapsed : new Set();
    // "Compact People" view: when true every chip renders in a photo-dominant compact form
    // (big avatar, name beneath, nothing else on the face). "Color by role": roleColor(node)
    // returns an hsl() border color for the node's tier (or falsy to keep the default border).
    var compact = !!opts.compact;
    var roleColor = typeof opts.roleColor === 'function' ? opts.roleColor : null;
    // Optional per-manager +N local-reveal adapter supplied by renderSiteChart:
    //   reveal.getCount(nodeId)   -> count of this manager's title-hidden DIRECT reports
    //   reveal.isRevealed(nodeId) -> whether that manager's hidden directs are shown
    //   reveal.onReveal(nodeId)   -> toggle the manager in/out of the revealed set
    var reveal = (opts.reveal && typeof opts.reveal === 'object') ? opts.reveal : null;

    container.innerHTML = '';
    // Only promote a STATIC container to relative. An already-positioned container
    // (e.g. #after { position:absolute; inset:0 }) must keep its position so its
    // inset-driven height survives — forcing position:relative here cancels inset:0
    // and collapses the container to height 0 (the blank-chart bug).
    var _curPos = (typeof window !== 'undefined' && window.getComputedStyle)
      ? window.getComputedStyle(container).position
      : (container.style.position || 'static');
    if (_curPos === 'static' || _curPos === '') {
      container.style.position = 'relative';
    }
    container.style.overflow = 'hidden';

    var stage = document.createElement('div');
    stage.className = 'oc-stage';
    stage.style.position = 'absolute';
    stage.style.left = '0';
    stage.style.top = '0';
    stage.style.transformOrigin = '0 0';
    stage.style.transform = 'translate(' + layoutResult.offsetX + 'px,' + layoutResult.offsetY + 'px) scale(' + layoutResult.scale + ')';
    stage.style.width = layoutResult.bounds.w + 'px';
    stage.style.height = layoutResult.bounds.h + 'px';

    // Edge layer (SVG) under the chips.
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'oc-edges');
    svg.setAttribute('width', String(layoutResult.bounds.w));
    svg.setAttribute('height', String(layoutResult.bounds.h));
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    svg.style.pointerEvents = 'none';

    var pos = {};
    for (var i = 0; i < layoutResult.nodes.length; i++) {
      var ni = layoutResult.nodes[i];
      pos[ni.node.id] = ni;
    }
    for (var e = 0; e < layoutResult.edges.length; e++) {
      var edge = layoutResult.edges[e];
      // The compact packer tags an edge `clipped` only in the proof-unreachable case
      // where routing could not keep every segment off a chip — never stroke it.
      if (edge.clipped) { continue; }
      var from = pos[edge.from];
      var to = pos[edge.to];
      if (!from || !to) { continue; }
      var d;
      if (edge.points && edge.points.length) {
        // Orthogonal route computed in layout(): a flat elbow for aligned (lane-0)
        // children, or a left gutter-spine for staggered (lane j>=1) children. Every
        // segment lies in a chip-free band, so lines run AROUND chips, never behind them.
        d = 'M' + edge.points[0][0] + ',' + edge.points[0][1];
        for (var pi = 1; pi < edge.points.length; pi++) {
          d += ' L' + edge.points[pi][0] + ',' + edge.points[pi][1];
        }
      } else {
        // Fallback elbow from node coordinates (legacy/compat; the compact path always
        // supplies points). Drop into the inter-row gap at midY, cross, drop into child.
        var x1 = from.x + from.w / 2;
        var y1 = from.y + from.h;
        var x2 = to.x + to.w / 2;
        var y2 = to.y;
        var midY = (y1 + y2) / 2;
        d = 'M' + x1 + ',' + y1 + ' L' + x1 + ',' + midY + ' L' + x2 + ',' + midY + ' L' + x2 + ',' + y2;
      }
      var path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('class', 'oc-edge');
      path.setAttribute('shape-rendering', 'crispEdges');
      svg.appendChild(path);
    }
    stage.appendChild(svg);

    // Chips.
    for (var n = 0; n < layoutResult.nodes.length; n++) {
      var item = layoutResult.nodes[n];
      var node = item.node;
      var chip = document.createElement('div');
      chip.className = compact ? 'oc-chip oc-compact' : 'oc-chip';
      chip.setAttribute('data-login', node.id);
      chip.style.position = 'absolute';
      chip.style.left = item.x + 'px';
      chip.style.top = item.y + 'px';
      chip.style.width = item.w + 'px';
      chip.style.height = item.h + 'px';
      // Color by role: tint the chip border for this node's tier. Falsy keeps the host's
      // default border color; a redraw with coloring off never sets it, so it reverts.
      if (roleColor) {
        var rc = roleColor(node);
        if (rc) { chip.style.borderColor = rc; chip.classList.add('oc-role-colored'); }
      }

      var data = node.data || {};
      var avatar = document.createElement('img');
      avatar.className = 'oc-avatar';
      avatar.alt = '';
      avatar.src = resolveAvatar(node);
      // Suppress native image ghost-drag so a pan that starts on a photo pans the chart
      // (belt-and-suspenders with the CSS -webkit-user-drag:none and pointerdown.preventDefault).
      avatar.draggable = false;

      var info = document.createElement('div');
      info.className = 'oc-info';
      var nameEl = document.createElement('div');
      nameEl.className = 'oc-name';
      nameEl.textContent = data.full_name || node.id;
      info.appendChild(nameEl);
      // Compact chips show ONLY the photo + name on the face; title/building live in the
      // click popup. The default (non-compact) chip keeps the title + building rows.
      if (!compact) {
        var titleEl = document.createElement('div');
        titleEl.className = 'oc-title';
        titleEl.textContent = data.job_title || '';
        var siteEl = document.createElement('div');
        siteEl.className = 'oc-site';
        siteEl.textContent = data.building || '';
        info.appendChild(titleEl);
        info.appendChild(siteEl);
      }

      chip.appendChild(avatar);
      chip.appendChild(info);

      // Expand/collapse affordance when the node has children.
      if ((node.children && node.children.length) || collapsed.has(node.id)) {
        var toggle = document.createElement('button');
        toggle.className = 'oc-toggle';
        toggle.type = 'button';
        toggle.textContent = collapsed.has(node.id) ? '+' : '\u2212';
        (function (capturedNode) {
          toggle.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (onToggle) { onToggle(capturedNode); }
          });
        })(node);
        chip.appendChild(toggle);
      }

      // Per-manager +N LOCAL REVEAL affordance — SEPARATE from the +/- toggle. When this
      // manager has >=1 DIRECT report currently hidden by the title filter, draw a small
      // distinct control: '+N' to pop that manager's hidden directs into view (adds it to
      // revealedParents), flipping to '\u2212N' (filled `revealed` state) to re-hide them.
      // It affects ONLY this manager's own direct reports; everyone else's stay hidden. N is
      // recomputed each draw, so un-hiding a title globally makes this control disappear.
      if (reveal && typeof reveal.getCount === 'function') {
        var revN = reveal.getCount(node.id);
        if (revN > 0) {
          var isRevealed = typeof reveal.isRevealed === 'function' && reveal.isRevealed(node.id);
          var revealBtn = document.createElement('button');
          revealBtn.className = 'oc-reveal' + (isRevealed ? ' revealed' : '');
          revealBtn.type = 'button';
          revealBtn.textContent = (isRevealed ? '\u2212' : '+') + revN;
          if (isRevealed) { revealBtn.setAttribute('data-revealed', '1'); }
          (function (capturedNode) {
            revealBtn.addEventListener('click', function (ev) {
              ev.stopPropagation();
              if (reveal && typeof reveal.onReveal === 'function') { reveal.onReveal(capturedNode.id); }
            });
          })(node);
          chip.appendChild(revealBtn);
        }
      }

      stage.appendChild(chip);
    }

    container.appendChild(stage);
  }

  // renderSiteChart — high-level pipeline: pruneToSite(anchor) -> layout ->
  // renderChart. Wires debounced resize re-layout and expand/collapse toggles.
  // Defaults to FULLY EXPANDED. The chart is rooted at the ANCHOR (treeRoot, the
  // root of the crawled tree) and pruned to the selected building — there is no
  // automatic climb to a shared ancestor. The anchor (URL login or a manual
  // override) is the single manual control for how wide the chart goes.
  function renderSiteChart(container, treeRoot, siteCode, viewport, opts) {
    opts = opts || {};

    // View toggles (controller-scoped so a live toggle re-renders in place preserving the
    // viewport). "Compact People" defaults OFF; "Color by role" defaults ON (pass
    // opts.colorByRole === false to disable). setCompact/setColorByRole flip these and redraw.
    var compactView = !!opts.compact;
    var colorByRole = opts.colorByRole !== false;

    // Root at the anchor and prune to the selected site: keep every path from the
    // anchor down to the site's members and drop memberless branches.
    var pruned = pruneToSite(treeRoot, siteCode);

    // Does any node under the anchor actually belong to the selected site? When not,
    // we render a non-blocking notice instead of a blank/single-node chart.
    var hasSiteMember = false;
    (function scanMembers(node) {
      if (!node || hasSiteMember) { return; }
      if (siteOf(node) === siteCode) { hasSiteMember = true; return; }
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) { scanMembers(kids[i]); }
    })(pruned);

    // Index every pruned node by id so a collapse can walk the FULL subtree (the visible
    // copy only carries children for currently-expanded nodes).
    var prunedById = {};
    (function index(node) {
      if (!node) { return; }
      prunedById[node.id] = node;
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) { index(kids[i]); }
    })(pruned);

    // Explicit expanded-set model. A node's children are included in the layout pass ONLY
    // when its id is in `expanded`. Seed with EVERY node that has children (so AFTER stays
    // fully expanded on first render) unless the caller supplies an override set.
    var expanded;
    if (opts.expanded instanceof Set) {
      expanded = opts.expanded;
    } else {
      expanded = new Set();
      (function seed(node) {
        if (!node) { return; }
        var kids = node.children || [];
        if (kids.length) { expanded.add(node.id); }
        for (var i = 0; i < kids.length; i++) { seed(kids[i]); }
      })(pruned);
    }

    // Hide-by-TITLE render filter. `hiddenTitles` is a Set of job titles whose nodes are
    // omitted from the render tree (and therefore their subtrees), REGARDLESS of who manages
    // them. It is a reversible, non-destructive RENDER FILTER: nothing is removed from
    // `pruned`/data, so clearing the set restores everyone. It composes with the manual
    // `expanded` collapse — both filters apply when building the render tree.
    var hiddenTitles = (opts.hiddenTitles instanceof Set) ? opts.hiddenTitles : new Set();
    function isTitleHidden(node) {
      return !!(node && node.data && hiddenTitles.has(node.data.job_title));
    }

    // Per-manager LOCAL-REVEAL set. Node ids whose OWN title-hidden DIRECT reports are
    // locally popped back into view (via the +N control), overriding the title filter for
    // that one manager's direct children only. Controller-scoped like `expanded` /
    // `hiddenTitles`, so it persists across every draw()/redraw and manual collapse for the
    // life of this render and resets naturally on a new renderSiteChart (site change).
    var revealedParents = (opts.revealedParents instanceof Set) ? opts.revealedParents : new Set();

    // Include a node's children in the layout pass only when it is expanded, and OMIT any
    // child whose job title is hidden (which drops that child's whole subtree too) — UNLESS
    // this node is in `revealedParents`, in which case its OWN title-hidden direct children
    // are kept (local reveal). Deeper descendants are still governed by the same rules.
    function withExpand(node) {
      var copy = { id: node.id, data: node.data, children: [] };
      if (expanded.has(node.id)) {
        var kids = node.children || [];
        for (var i = 0; i < kids.length; i++) {
          if (isTitleHidden(kids[i]) && !revealedParents.has(node.id)) { continue; }
          copy.children.push(withExpand(kids[i]));
        }
      }
      return copy;
    }

    // RESET rule: collapsing a node removes it AND its whole subtree from `expanded`, so a
    // later re-expand reveals only its immediate children (each itself collapsed). Expanding
    // adds only the node (never its descendants).
    function collapseSubtree(node) {
      if (!node) { return; }
      expanded.delete(node.id);
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) { collapseSubtree(kids[i]); }
    }

    // Nodes that have at least one VISIBLE (non-title-hidden) child but are NOT expanded —
    // renderChart draws these with a '+' affordance. A node whose only children are
    // title-hidden has nothing to expand to, so it gets no toggle; hidden subtrees are not
    // walked.
    function computeCollapsedDisplay() {
      var set = new Set();
      (function walk(node) {
        if (!node) { return; }
        var kids = node.children || [];
        // A revealed manager counts its title-hidden directs as visible children, and we
        // recurse into them, so a locally-revealed sub-manager still gets its own +/-.
        var revealedHere = revealedParents.has(node.id);
        var hasVisibleChild = false;
        for (var i = 0; i < kids.length; i++) {
          if (!isTitleHidden(kids[i]) || revealedHere) { hasVisibleChild = true; break; }
        }
        if (hasVisibleChild && !expanded.has(node.id)) { set.add(node.id); }
        for (var j = 0; j < kids.length; j++) {
          if (isTitleHidden(kids[j]) && !revealedHere) { continue; }
          walk(kids[j]);
        }
      })(pruned);
      return set;
    }

    // ----- Hide-levels support ------------------------------------------------
    // getTitleTiers returns the relationship-grouped tier ordering of the distinct job
    // titles in the pruned tree, senior -> junior (tierIndex 0 = top/most senior). The
    // host builds its checkbox list from this (one row per tier) without re-pruning.
    function getTitleTiers() { return deriveTitleTiers(pruned); }

    // applyTitleHide(hiddenTitleSet) hides people by JOB-TITLE MATCH, not by tree level:
    // every node whose job_title is in the set is omitted from the render tree wherever it
    // sits (and so is its subtree), regardless of who manages it. This fixes off-pattern
    // reports that the old collapse-by-tier logic missed (e.g. a Process Assistant reporting
    // to an Operations Manager, or a plain "Area Manager" reporting to the General Manager).
    // It is a reversible, non-destructive RENDER FILTER: nothing is removed from
    // `pruned`/data, so clearing the set (unchecking) restores everyone. It is independent of
    // and composable with the manual +/- collapse (`expanded`) — both filters apply when
    // building the render tree, and manual toggles still work on visible branches afterward.
    function applyTitleHide(hiddenTitleSet) {
      hiddenTitles = (hiddenTitleSet instanceof Set) ? hiddenTitleSet : new Set();
      // A hide-checkbox change re-lays out in place: preserve the current pan/zoom (no refit),
      // exactly like the manual +/- collapse. Anchor on the center-most node so the viewport
      // stays put. Only Fit/Reload/site-change/initial render refit.
      draw({ preserveView: true, anchorId: centerAnchorId() });
    }

    // hiddenDirectCount(nodeId) — how many of a RENDERED manager's DIRECT reports are
    // currently hidden by the title filter. Computed PURELY from the data (the pruned index
    // + `hiddenTitles`), independent of the node's own collapse/expand state, so every
    // rendered manager with >=1 title-hidden direct report shows its +N regardless of its
    // own expand state or any sibling interaction. Returns 0 only when the node is absent
    // from the pruned index. Recomputed live from `hiddenTitles` so un-hiding a title
    // globally drops the matching +N control on the next draw. Note a locally-revealed
    // manager still reports its full hidden-direct count (its directs are shown, so the
    // control reads as the re-hide state) — the count itself does not change.
    function hiddenDirectCount(nodeId) {
      var node = prunedById[nodeId];
      if (!node) { return 0; }
      var kids = node.children || [];
      var n = 0;
      for (var i = 0; i < kids.length; i++) {
        if (isTitleHidden(kids[i])) { n++; }
      }
      return n;
    }

    // toggleReveal(nodeId) — flip ONE manager into/out of `revealedParents` (local reveal of
    // just that manager's title-hidden direct reports) and redraw. Independent of
    // `hiddenTitles` (checkboxes) and of the manual +/- collapse (`expanded`).
    function toggleReveal(nodeId) {
      if (revealedParents.has(nodeId)) { revealedParents.delete(nodeId); }
      // Reveal in ONE click: also expand the node so `withExpand` walks its children and
      // keeps this manager's title-hidden directs visible even if it was collapsed. On
      // un-reveal, leave `expanded` untouched (preserve the manual collapse state).
      else { revealedParents.add(nodeId); expanded.add(nodeId); }
      // A +N reveal re-lays out in place: preserve the current pan/zoom (no refit) and anchor
      // on the revealed manager so it stays fixed on screen, exactly like the manual +/- toggle.
      draw({ preserveView: true, anchorId: nodeId });
    }

    // expandAll — clear every manual per-node collapse so the WHOLE tree is shown again (the
    // inverse of manual collapsing). Re-seeds `expanded` with every node that has children,
    // exactly like the initial fully-expanded render. It does NOT touch the hide-by-title
    // filter (`hiddenTitles`) or local reveals, so any tiers hidden via "Hide levels" stay
    // hidden. Re-lays out preserving the view, anchored on the center-most node; the existing
    // auto-fit rule still applies.
    function expandAll() {
      (function seed(node) {
        if (!node) { return; }
        var kids = node.children || [];
        if (kids.length) { expanded.add(node.id); }
        for (var i = 0; i < kids.length; i++) { seed(kids[i]); }
      })(pruned);
      draw({ preserveView: true, anchorId: centerAnchorId() });
    }

    // setCompact / setColorByRole — flip a view toggle and re-lay out in place, preserving the
    // current pan/zoom (anchored on the center-most node) exactly like a hide/show redraw. Only
    // Fit/Reload/site-change/initial render refit, so toggling keeps the user where they are.
    function setCompact(on) {
      compactView = !!on;
      draw({ preserveView: true, anchorId: centerAnchorId() });
    }
    function setColorByRole(on) {
      colorByRole = !!on;
      draw({ preserveView: true, anchorId: centerAnchorId() });
    }

    function getViewport() {
      if (typeof viewport === 'function') { return viewport(); }
      if (viewport && viewport.w && viewport.h) { return viewport; }
      return { w: container.clientWidth || 1920, h: container.clientHeight || 1080 };
    }

    // --- interactive view transform (pan + zoom on top of the fit transform) -----
    // The live pan/zoom transform and the live stage node are CONTAINER-scoped
    // (container._ocView / container._ocStage) so the once-installed pointer/wheel
    // handlers always drive the CURRENT render after repeated renderSiteChart calls.
    // Per-draw temporaries for the freshly computed fit transform. They are mirrored into
    // the CONTAINER-scoped container._ocFit each draw() so the once-installed handlers and
    // the current render share ONE source of truth (see below).
    var fitScale = 1, fitX = 0, fitY = 0;
    if (!container._ocView) { container._ocView = { k: 1, x: 0, y: 0 }; }
    // The fit transform is CONTAINER-scoped (container._ocFit = { k, x, y }) and refreshed by
    // every draw() from the local fitScale/fitX/fitY, so the once-installed pan/zoom handlers
    // and the CURRENT render always read the same fit — not a stale per-render closure.
    if (!container._ocFit) { container._ocFit = { k: 1, x: 0, y: 0 }; }
    // container._ocFitView tracks whether the view is currently "following the Fit" (true) or
    // has been manually moved by the user (false). It is CONTAINER-scoped (not a per-render
    // closure) so a toolbar Reload / Show / Reset-to-login / Set-as-anchor / site-change
    // re-render shares the same flag the installed handlers write to — otherwise a fresh
    // render's flag would stay true while the handlers only cleared the old closure's copy,
    // snapping a zoomed-in +/- or hide/show back to Fit. It starts true on every
    // render/site-change/Reload, is set true again by the Fit button (resetView), and is
    // cleared the moment the user pans/wheel-zooms/pinches or hits a toolbar zoom button.
    // Hide/unhide/collapse redraws do NOT flip it themselves — only maybeAutoFit() may set it
    // back true when it auto-fits.
    if (container._ocFitView === undefined) { container._ocFitView = true; }
    // Auto-Fit tuning threshold (named so it is easy to tune). After a hide/show redraw while
    // the user has manually moved the view (container._ocFitView===false), the decision is a
    // pure SCALE-vs-fit rule: auto-Fit only when the user is ZOOMED OUT relative to the Fit, i.e.
    // the current scale is below container._ocFit.k * AUTOFIT_ZOOMOUT_RATIO. Being zoomed out means the
    // user is looking at the chart plus empty margin, and a hide/unhide tends to add more empty
    // space, so re-framing to the Fit helps. When zoomed in (at or above the Fit) we never
    // auto-Fit, no matter how much content is off-screen — the user is studying a subsection.
    // The ratio sits just under 1 so a genuine zoom-out triggers while exact-at-fit / float
    // jitter does not.
    var AUTOFIT_ZOOMOUT_RATIO = 0.99;
    // Absolute zoom clamp (not fit-relative): zoom stays within [0.1x, 5x] regardless of
    // how large or small the fitted scale is.
    var MIN_K = 0.1, MAX_K = 5;
    function clampK(v) {
      return v < MIN_K ? MIN_K : (v > MAX_K ? MAX_K : v);
    }
    // maybeAutoFit — called from the preserve-view (hide/unhide/collapse) path when the user
    // has manually moved the view (container._ocFitView===false). The rule is purely SCALE-vs-fit:
    // if the user is ZOOMED OUT relative to the Fit (current scale < container._ocFit.k * AUTOFIT_ZOOMOUT_RATIO),
    // snap back to the Fit and resume following it — a zoom-out means the chart sits in empty
    // margin and a hide/unhide tends to add more, so re-framing helps. If the user is ZOOMED IN
    // (at or above the Fit) do NOTHING — leave their (anchor-adjusted) view untouched, no matter
    // how much content is off-screen. The bounds/vp params are unused now but kept so the call
    // site stays stable.
    function maybeAutoFit(bounds, vp) {
      var v = container._ocView;
      if (!v) { return; }
      var fit = container._ocFit;
      if (v.k < fit.k * AUTOFIT_ZOOMOUT_RATIO) {
        container._ocView = { k: fit.k, x: fit.x, y: fit.y };
        container._ocFitView = true;
      }
    }
    function applyView() {
      var st = container._ocStage, v = container._ocView;
      if (st) {
        st.style.transform =
          'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.k + ')';
      }
    }
    function resetView() { var fit = container._ocFit; container._ocView = { k: fit.k, x: fit.x, y: fit.y }; container._ocFitView = true; applyView(); }
    // Toolbar zoom: zoom toward the viewport CENTER (buttons have no cursor point). Reuses
    // the wheel-zoom math with the focal point fixed at (clientWidth/2, clientHeight/2),
    // mutates the SAME container-scoped view and clamps with clampK, so it composes with
    // pan/pinch/wheel and the hardened gesture state. No-ops before a chart is rendered.
    function zoomBy(factor) {
      if (!container._ocStage) { return; }
      var cx = container.clientWidth / 2, cy = container.clientHeight / 2;
      var v = container._ocView;
      var nk = clampK(v.k * factor);
      v.x = cx - (cx - v.x) * (nk / v.k);
      v.y = cy - (cy - v.y) * (nk / v.k);
      v.k = nk;
      // A toolbar zoom is an explicit viewport change: stop following the Fit.
      container._ocFitView = false;
      applyView();
    }

    // --- click-a-chip detail popup ------------------------------------------
    // A genuine click (not a drag, not the +/- toggle) opens a larger popup with the FULL
    // untruncated person details. The name links to a profile in a NEW TAB when the host
    // supplies opts.resolveProfileUrl(node) (falsy -> plain-text name). The popup is a child
    // of the container (so the pan handler can bail on it) but position:fixed via CSS so the
    // container's overflow:hidden never clips it. Dismiss: outside click, Esc, or the x.
    function closeDetailPopup() {
      if (!container._ocPopup) { return; }
      if (container._ocPopupKey) {
        document.removeEventListener('keydown', container._ocPopupKey, true);
        container._ocPopupKey = null;
      }
      if (container._ocPopupOutside) {
        document.removeEventListener('pointerdown', container._ocPopupOutside, true);
        container._ocPopupOutside = null;
      }
      if (container._ocPopup.parentNode) {
        container._ocPopup.parentNode.removeChild(container._ocPopup);
      }
      container._ocPopup = null;
    }

    // positionPopup — place the already-rendered bubble relative to the clicked chip's
    // on-screen rectangle. Default ABOVE the chip (caret pointing DOWN); flip BELOW (caret
    // UP) when there is no room above; shift horizontally so the bubble never leaves the
    // viewport, keeping the caret aimed at the chip's horizontal center.
    function positionPopup(popup, caret, chipEl) {
      if (typeof window === 'undefined') { return; }
      var vw = window.innerWidth || 1920;
      var vh = window.innerHeight || 1080;
      var GAP = 12;      // space between the chip and the bubble (room for the caret)
      var MARGIN = 8;    // min distance from any viewport edge
      var CARET_H = 11;  // caret height (matches the CSS triangle)
      var EDGE = 16;     // keep the caret off the bubble's rounded corners

      // Measure the bubble (size is independent of its final left/top).
      var pr = popup.getBoundingClientRect();
      var pw = pr.width;
      var ph = pr.height;

      var chipCenterX, chipTop, chipBottom;
      if (chipEl && chipEl.getBoundingClientRect) {
        var cr = chipEl.getBoundingClientRect();
        chipCenterX = cr.left + cr.width / 2;
        chipTop = cr.top;
        chipBottom = cr.bottom;
      } else {
        chipCenterX = vw / 2;
        chipTop = vh / 2;
        chipBottom = vh / 2;
      }

      // Horizontal: center on the chip, then clamp fully on-screen.
      var left = chipCenterX - pw / 2;
      if (left + pw > vw - MARGIN) { left = vw - MARGIN - pw; }
      if (left < MARGIN) { left = MARGIN; }

      // Vertical: prefer above the chip; flip below if it would clip the top.
      var below = false;
      var top = chipTop - GAP - CARET_H - ph;
      if (top < MARGIN) {
        below = true;
        top = chipBottom + GAP + CARET_H;
      }
      // If a flipped-below bubble would clip the bottom, clamp it back on-screen.
      if (top + ph > vh - MARGIN) { top = Math.max(MARGIN, vh - MARGIN - ph); }

      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
      popup.style.right = 'auto';
      popup.style.bottom = 'auto';
      popup.style.margin = '0';
      popup.style.transform = 'none';

      // Caret aims at the chip center, clamped to the bubble's body (off the corners).
      var caretLeft = chipCenterX - left;
      if (caretLeft < EDGE) { caretLeft = EDGE; }
      if (caretLeft > pw - EDGE) { caretLeft = pw - EDGE; }
      caret.style.left = caretLeft + 'px';
      caret.className = 'oc-popup-caret ' + (below ? 'oc-popup-caret-up' : 'oc-popup-caret-down');
    }

    function openDetailPopup(login) {
      if (typeof document === 'undefined') { return; }
      var node = prunedById[login];
      if (!node) { return; }
      closeDetailPopup();
      var data = node.data || {};

      var popup = document.createElement('div');
      popup.className = 'oc-popup';

      var closeBtn = document.createElement('button');
      closeBtn.className = 'oc-popup-close';
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', function () { closeDetailPopup(); });
      popup.appendChild(closeBtn);

      // Avatar photo (same source the chips use) at the top of the bubble.
      var popupAvatar = document.createElement('img');
      popupAvatar.className = 'oc-popup-avatar';
      popupAvatar.alt = '';
      popupAvatar.draggable = false;
      popupAvatar.src = (typeof opts.resolveAvatar === 'function') ? (opts.resolveAvatar(node) || '') : '';
      popup.appendChild(popupAvatar);

      var nameText = data.full_name || node.id;
      var nameWrap = document.createElement('div');
      nameWrap.className = 'oc-popup-name';
      var url = (typeof opts.resolveProfileUrl === 'function') ? opts.resolveProfileUrl(node) : null;
      if (url) {
        var a = document.createElement('a');
        a.className = 'oc-popup-link';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = nameText;
        nameWrap.appendChild(a);
      } else {
        nameWrap.textContent = nameText;
      }
      popup.appendChild(nameWrap);

      // One row per PRESENT field, in a fixed order, plus the login (always present).
      var rows = [
        ['Title', data.job_title],
        ['Department', data.department_name],
        ['Building', data.building],
        ['Phone', data.phone],
        ['Login', node.id]
      ];
      for (var ri = 0; ri < rows.length; ri++) {
        var value = rows[ri][1];
        if (!value) { continue; }
        var row = document.createElement('div');
        row.className = 'oc-popup-row';
        var lab = document.createElement('span');
        lab.className = 'oc-popup-label';
        lab.textContent = rows[ri][0] + ': ';
        var val = document.createElement('span');
        val.className = 'oc-popup-value';
        val.textContent = value;
        row.appendChild(lab);
        row.appendChild(val);
        popup.appendChild(row);
      }

      // Optional "Set as anchor" control: re-roots the DISPLAYED chart at this node (a pure
      // in-memory view change in the host — no re-crawl). Rendered only when the host supplies
      // opts.onSetAnchor AND this node is not already the current display root (pruned.id).
      // Styled inline (like renderEmptyNotice) so it looks right in every host without host CSS.
      var onSetAnchor = (typeof opts.onSetAnchor === 'function') ? opts.onSetAnchor : null;
      if (onSetAnchor && pruned && login !== pruned.id && node.children && node.children.length) {
        var anchorBtn = document.createElement('button');
        anchorBtn.type = 'button';
        anchorBtn.className = 'oc-popup-anchor';
        anchorBtn.textContent = 'Make top of chart';
        anchorBtn.style.cssText = 'display:block;margin:8px 0 2px;padding:4px 10px;cursor:pointer;' +
          'background:transparent;border:1px solid var(--accent,#4f9dff);color:var(--accent,#4f9dff);' +
          'border-radius:6px;font:inherit;line-height:1.3;text-align:left;';
        anchorBtn.addEventListener('click', function () {
          closeDetailPopup();
          onSetAnchor(node);
        });
        popup.appendChild(anchorBtn);
      }

      // Caret/tail — a CSS triangle that points at the node like a comic speech bubble.
      // Its direction (down/up) and horizontal offset are set by positionPopup below.
      var caret = document.createElement('div');
      caret.className = 'oc-popup-caret oc-popup-caret-down';
      popup.appendChild(caret);

      container.appendChild(popup);
      container._ocPopup = popup;

      // Anchor the bubble to the clicked chip's ON-SCREEN rectangle (getBoundingClientRect
      // already accounts for pan/zoom/scale) instead of centering it in the chart. Default:
      // directly above the node, horizontally centered, caret pointing DOWN. Flip BELOW when
      // too near the top; shift horizontally to stay fully on-screen; keep the caret on the
      // node's center.
      var chipEl = null;
      var chipEls = container.querySelectorAll('.oc-chip');
      for (var ce = 0; ce < chipEls.length; ce++) {
        if (chipEls[ce].getAttribute('data-login') === login) { chipEl = chipEls[ce]; break; }
      }
      positionPopup(popup, caret, chipEl);

      container._ocPopupKey = function (ev) {
        if (ev.key === 'Escape' || ev.keyCode === 27) { closeDetailPopup(); }
      };
      document.addEventListener('keydown', container._ocPopupKey, true);

      // Defer the outside-click listener a tick so the opening pointerup doesn't self-close.
      container._ocPopupOutside = function (ev) {
        if (!(ev.target && ev.target.closest && ev.target.closest('.oc-popup'))) {
          closeDetailPopup();
        }
      };
      setTimeout(function () {
        if (container._ocPopupOutside) {
          document.addEventListener('pointerdown', container._ocPopupOutside, true);
        }
      }, 0);
    }

    // Non-blocking notice shown when the anchor's tree contains no one from the
    // selected site. Data-driven label (treeRoot.id) keeps it generic/brand-free.
    function renderEmptyNotice() {
      if (typeof document === 'undefined') { return; }
      var anchorLabel = (treeRoot && treeRoot.id) ? treeRoot.id : 'this anchor';
      var notice = document.createElement('div');
      notice.className = 'oc-empty-notice';
      notice.style.cssText =
        'display:flex;align-items:center;justify-content:center;width:100%;height:100%;' +
        'padding:24px;box-sizing:border-box;text-align:center;font-size:16px;' +
        'line-height:1.5;color:#c9d1d9;opacity:0.85;';
      notice.textContent = 'No one from ' + siteCode + ' under ' + anchorLabel;
      container.innerHTML = '';
      container.appendChild(notice);
    }

    // The previous draw's fresh (pre-pan/zoom) layout positions, keyed by login. A toggle
    // redraw uses this to keep the clicked node fixed on screen. Seeded from the CONTAINER-
    // scoped snapshot of the PREVIOUS renderSiteChart so a fresh re-render (e.g. toggling
    // associates, which rebuilds `pruned`) can still anchor on a node it shared with the
    // prior render. Null until the very first draw on a brand-new container.
    var lastLayoutPos = container._ocLayoutPos || null;

    // centerAnchorId — the id of the node whose CURRENT on-screen position is closest to the
    // viewport center, computed from the last layout positions and the live pan/zoom. Used to
    // anchor a preserve-view re-render (toggle associates / hide-show / Expand All) on the
    // center-most node so the viewport stays put. Null when there is nothing to anchor on.
    function centerAnchorId() {
      var v = container._ocView;
      if (!v || !lastLayoutPos) { return null; }
      var vpc = getViewport();
      var cx = (container.clientWidth || vpc.w) / 2;
      var cy = (container.clientHeight || vpc.h) / 2;
      var best = null, bestD = Infinity;
      for (var id in lastLayoutPos) {
        if (!Object.prototype.hasOwnProperty.call(lastLayoutPos, id)) { continue; }
        var p = lastLayoutPos[id];
        var sx = v.x + p.x * v.k, sy = v.y + p.y * v.k;
        var dx = sx - cx, dy = sy - cy;
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = id; }
      }
      return best;
    }

    function draw(drawOpts) {
      var preserveView = !!(drawOpts && drawOpts.preserveView);
      var anchorId = drawOpts && drawOpts.anchorId;
      // A redraw rebuilds container.innerHTML, so tear down any open popup + its listeners.
      closeDetailPopup();
      // A redraw also replaces the chips a press/drag was working on, so clear any
      // in-progress pan gesture + its cursor classes. Without this, a toggle/expand/collapse
      // (or resize) that fires mid-gesture would strand `dragging`/pointers and wedge every
      // later click so the detail popup stops opening until a reload.
      if (container._ocResetPan) { container._ocResetPan(); }
      // No one from the selected site lives under the anchor — show a notice instead of a
      // blank or single-node chart.
      if (!pruned || !hasSiteMember) { renderEmptyNotice(); return; }
      var vp = getViewport();
      var visibleRoot = withExpand(pruned);
      if (!visibleRoot) { container.innerHTML = ''; return; }
      // Compact People shrinks the per-person footprint (photo-dominant), so the flat packer
      // fits more side-by-side and auto-fit naturally zooms in. Override only the chip size,
      // layering on top of any host-supplied layout opts.
      var layoutOpts = opts.layout;
      if (compactView) {
        layoutOpts = {};
        if (opts.layout) {
          for (var lk in opts.layout) {
            if (Object.prototype.hasOwnProperty.call(opts.layout, lk)) { layoutOpts[lk] = opts.layout[lk]; }
          }
        }
        layoutOpts.chipW = 112;
        layoutOpts.chipH = 120;
      }
      var layoutResult = layout(visibleRoot, vp.w, vp.h, layoutOpts);
      fitScale = layoutResult.scale; fitX = layoutResult.offsetX; fitY = layoutResult.offsetY;
      // Mirror the freshly computed fit into container scope so the once-installed handlers,
      // maybeAutoFit, resetView and the view branch below all read the CURRENT render's fit.
      container._ocFit = { k: fitScale, x: fitX, y: fitY };
      // Snapshot each node's fresh layout position so a toggle redraw can anchor the relayout
      // on the clicked node (keep it fixed on screen).
      var newLayoutPos = {};
      for (var li = 0; li < layoutResult.nodes.length; li++) {
        var lnode = layoutResult.nodes[li];
        newLayoutPos[lnode.node.id] = { x: lnode.x, y: lnode.y };
      }
      // Color by role: map each distinct job title to its tier's fixed-palette border color
      // (top tier = red, assigned top-down by tier index) from the SAME tiers the hide-levels
      // panel uses, so people in one role share a border. A null palette entry (slot 7) keeps
      // the default border. roleColorFn is null entirely when coloring is off.
      var roleColorFn = null;
      if (colorByRole) {
        var colorTiers = deriveTitleTiers(pruned);
        var palette = roleBorderColors(colorTiers.length);
        var colorByTitle = {};
        for (var cti = 0; cti < colorTiers.length; cti++) {
          var ctTitles = colorTiers[cti].titles;
          for (var ctj = 0; ctj < ctTitles.length; ctj++) { colorByTitle[ctTitles[ctj]] = palette[colorTiers[cti].tierIndex]; }
        }
        roleColorFn = function (node) {
          var t = node && node.data && node.data.job_title;
          return (t && Object.prototype.hasOwnProperty.call(colorByTitle, t)) ? colorByTitle[t] : null;
        };
      }
      renderChart(container, layoutResult, {
        resolveAvatar: opts.resolveAvatar,
        compact: compactView,
        roleColor: roleColorFn,
        collapsed: computeCollapsedDisplay(),
        reveal: {
          getCount: hiddenDirectCount,
          isRevealed: function (id) { return revealedParents.has(id); },
          onReveal: toggleReveal
        },
        onToggle: function (node) {
          if (expanded.has(node.id)) { collapseSubtree(prunedById[node.id] || node); }
          else { expanded.add(node.id); }
          // Expand/collapse re-lays out in place: preserve the current pan/zoom (no refit) and
          // anchor on the toggled node so the chart doesn't jump out from under the cursor.
          draw({ preserveView: true, anchorId: node.id });
          if (typeof opts.onToggle === 'function') { opts.onToggle(node); }
        }
      });
      // renderChart rebuilds container.innerHTML each draw, so re-grab the stage. Reset the
      // container-scoped view to the fresh fit transform on every path EXCEPT a preserve-view
      // redraw (expand/collapse), which keeps the current pan/zoom. Fit/Reload/site-change go
      // through resetView()/fresh renderSiteChart, so they still refit.
      container._ocStage = container.querySelector('.oc-stage');
      if (!(preserveView && container._ocView)) {
        // Initial render / resize / explicit refit: snap to the fresh fit and follow it.
        container._ocView = { k: container._ocFit.k, x: container._ocFit.x, y: container._ocFit.y };
        container._ocFitView = true;
      } else if (container._ocFitView) {
        // The user hasn't moved the view since the last Fit, so a hide/unhide/collapse redraw
        // keeps following the Fit: re-fit to frame the freshly computed content.
        container._ocView = { k: container._ocFit.k, x: container._ocFit.x, y: container._ocFit.y };
      } else {
        if (anchorId && lastLayoutPos && lastLayoutPos[anchorId] && newLayoutPos[anchorId]) {
          // Keep the toggled node fixed on screen: a node at layout (nx,ny) renders at
          // (view.x + nx*k, view.y + ny*k), so shifting the preserved view by the node's layout
          // delta times the current zoom cancels the re-pack for that node. Distant nodes may
          // still move; the clicked node stays put.
          var oldAP = lastLayoutPos[anchorId], newAP = newLayoutPos[anchorId];
          container._ocView.x += (oldAP.x - newAP.x) * container._ocView.k;
          container._ocView.y += (oldAP.y - newAP.y) * container._ocView.k;
        }
        // User has manually moved the view: keep it when zoomed in, but auto-Fit (and resume
        // following the Fit) when zoomed out relative to the Fit.
        maybeAutoFit(layoutResult.bounds, vp);
      }
      lastLayoutPos = newLayoutPos;
      // Also stash the fresh positions on the CONTAINER so the NEXT renderSiteChart (a full
      // re-render, e.g. toggle associates) can seed its own lastLayoutPos and anchor across
      // the rebuild on a node shared with this render.
      container._ocLayoutPos = newLayoutPos;
      applyView();
    }

    container._ocDraw = draw;
    // Re-published every renderSiteChart call so the once-installed click handler always opens
    // the CURRENT render's popup (with the current prunedById). Without this, a chip created by
    // a later re-render (site change, grafted associates, anchor change) is absent from the
    // first render's stale index and its detail popup never opens.
    container._ocOpenPopup = openDetailPopup;
    // A caller can request that this fresh re-render PRESERVE the current viewport instead of
    // refitting (used when toggling associates on/off, which must rebuild `pruned` yet keep
    // the user where they were). Only honored when a prior render left a view + layout
    // snapshot on the container; the anchor defaults to the center-most shared node.
    if (opts.preserveView && container._ocView && container._ocLayoutPos) {
      draw({ preserveView: true, anchorId: opts.anchorId || centerAnchorId() });
    } else {
      draw();
    }

    // Pan + zoom via Pointer Events (mouse + touch). Installed ONCE on the container
    // (guarded) so repeated draws/resizes never stack listeners. The container keeps
    // overflow:hidden (set by renderChart) so there are never scrollbars.
    (function setupPanZoom() {
      if (typeof document === 'undefined' || container._ocPanZoom) { return; }
      container._ocPanZoom = true;
      container.style.touchAction = 'none';
      // Class-based cursor model: the container shows grab over empty area, chips show the
      // pointer hand (clickable), and press/drag states (added below) override to grab/grabbing
      // even over a chip. The host CSS defines .oc-pan-container/.oc-pressing/.oc-dragging.
      container.classList.add('oc-pan-container');
      var pointers = new Map();
      var dragging = false;
      var startX = 0, startY = 0, startVX = 0, startVY = 0;
      var pinchDist = 0, pinchK = 1, pinchMidX = 0, pinchMidY = 0;
      var THRESH = 4;
      var downChipLogin = null;
      var gesturePointerId = null;
      function local(ev) {
        var r = container.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      }
      // clearGestureState — hard-reset EVERY piece of interaction state (the pointer map, the
      // drag flag, the current-gesture pointer id, the pressed chip, pinch tracking, and the
      // press/drag cursor classes). It never relies on HOW a gesture ended, so a missed
      // pointerup, a cancel, a lost capture, or a mid-gesture redraw can't leave `dragging`
      // stuck true or a stale pointer in the map — the exact leak that used to wedge every
      // later click so the detail popup stopped opening until the page was reloaded.
      function clearGestureState() {
        pointers.clear();
        dragging = false;
        gesturePointerId = null;
        downChipLogin = null;
        pinchDist = 0;
        container.classList.remove('oc-pressing');
        container.classList.remove('oc-dragging');
      }
      // Expose the reset so draw() can clear an in-progress gesture when a toggle/redraw
      // rebuilds the stage out from under a press/drag.
      container._ocResetPan = clearGestureState;
      container.addEventListener('pointerdown', function (ev) {
        // Toolbar / toggle / popup controls handle their own events and never pan.
        if (ev.target && ev.target.closest && ev.target.closest('.oc-toolbar, .oc-toggle, .oc-reveal, .oc-popup')) { return; }
        // Suppress native image-drag and text selection for every drag that starts on the
        // chart (the controls above already bailed, so they keep working).
        ev.preventDefault();
        // Defensive re-init: drop any stale state left by a prior gesture that never delivered
        // a clean pointerup (mid-gesture redraw, missed up/cancel, lost capture). A mouse/pen is
        // inherently single-pointer, so any lingering pointers are stale and safe to drop; for
        // touch we only clear when nothing is actively down so a genuine second finger (pinch)
        // is preserved.
        if (ev.pointerType !== 'touch' || pointers.size === 0) { clearGestureState(); }
        // Press-and-hold shows grab (even over a node) to signal a possible pan; a real drag
        // swaps to grabbing, and release reverts to the hover default (pointer over a chip).
        container.classList.add('oc-pressing');
        downChipLogin = (ev.target && ev.target.closest && ev.target.closest('.oc-chip'))
          ? ev.target.closest('.oc-chip').getAttribute('data-login') : null;
        pointers.set(ev.pointerId, local(ev));
        if (pointers.size === 1) {
          var p = pointers.get(ev.pointerId);
          startX = p.x; startY = p.y; startVX = container._ocView.x; startVY = container._ocView.y;
          dragging = false; gesturePointerId = ev.pointerId;
          try { container.setPointerCapture(ev.pointerId); } catch (e) { }
        } else if (pointers.size === 2) {
          var a = Array.from(pointers.values());
          pinchDist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
          pinchK = container._ocView.k;
          pinchMidX = (a[0].x + a[1].x) / 2; pinchMidY = (a[0].y + a[1].y) / 2;
        }
      });
      container.addEventListener('pointermove', function (ev) {
        if (!pointers.has(ev.pointerId)) { return; }
        pointers.set(ev.pointerId, local(ev));
        if (pointers.size >= 2) {
          var a = Array.from(pointers.values());
          var dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
          var nk = clampK(pinchK * (dist / pinchDist));
          container._ocView.x = pinchMidX - (pinchMidX - container._ocView.x) * (nk / container._ocView.k);
          container._ocView.y = pinchMidY - (pinchMidY - container._ocView.y) * (nk / container._ocView.k);
          container._ocView.k = nk;
          // A pinch zoom is an explicit viewport change: stop following the Fit.
          container._ocFitView = false;
          applyView();
          return;
        }
        var p = local(ev);
        var dx = p.x - startX, dy = p.y - startY;
        if (!dragging && (Math.abs(dx) > THRESH || Math.abs(dy) > THRESH)) {
          dragging = true; container.classList.remove('oc-pressing'); container.classList.add('oc-dragging');
          // A pan drag past the threshold is an explicit viewport change: stop following the Fit.
          container._ocFitView = false;
        }
        if (dragging) { container._ocView.x = startVX + dx; container._ocView.y = startVY + dy; applyView(); }
      });
      // Fully reset on EVERY gesture terminator (up / cancel / lost-capture). Release the
      // capture first, then clear ALL state, so the next interaction always starts clean
      // regardless of HOW this one ended. `lostpointercapture` is the key addition: when a
      // redraw detaches the captured target (or capture is otherwise lost) the browser never
      // fires a matching pointerup, so without this listener the gesture state would leak.
      function endGesture(ev) {
        try { container.releasePointerCapture(ev.pointerId); } catch (e) { }
        clearGestureState();
      }
      container.addEventListener('pointerup', function (ev) {
        // CLICK vs DRAG is decided ONLY from movement WITHIN THIS gesture: the released
        // pointer must be the one that started the current single-pointer gesture and must not
        // have crossed the drag threshold (dragging===false). This never consults state that
        // could survive a redraw, so a stranded flag can't suppress the popup — a plain,
        // movement-free press on a chip ALWAYS opens its detail popup. (A cancel never routes
        // here, so it never opens one.)
        var isClick = !dragging && ev.pointerId === gesturePointerId &&
          pointers.has(ev.pointerId) && pointers.size === 1;
        var clickLogin = isClick ? downChipLogin : null;
        endGesture(ev);
        if (clickLogin) { (container._ocOpenPopup || openDetailPopup)(clickLogin); }
      });
      container.addEventListener('pointercancel', endGesture);
      container.addEventListener('lostpointercapture', endGesture);
      container.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        var p = local(ev);
        var factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
        var nk = clampK(container._ocView.k * factor);
        container._ocView.x = p.x - (p.x - container._ocView.x) * (nk / container._ocView.k);
        container._ocView.y = p.y - (p.y - container._ocView.y) * (nk / container._ocView.k);
        container._ocView.k = nk;
        // A wheel zoom is an explicit viewport change: stop following the Fit.
        container._ocFitView = false;
        applyView();
      }, { passive: false });
    })();

    // Debounced resize re-layout (scale/offset recompute via a full redraw, which
    // re-fits the view to the new viewport). Installed ONCE per container (guarded by
    // container._ocResize) and routed through container._ocDraw so repeated
    // renderSiteChart calls neither stack listeners nor redraw a stale site.
    if (typeof window !== 'undefined' && !opts.noResize && !container._ocResize) {
      container._ocResize = true;
      var t = null;
      window.addEventListener('resize', function () {
        if (t) { clearTimeout(t); }
        t = setTimeout(function () { if (container._ocDraw) { container._ocDraw(); } }, 150);
      });
    }

    return {
      redraw: draw, expanded: expanded, resetView: resetView, zoomBy: zoomBy,
      getTitleTiers: getTitleTiers, applyTitleHide: applyTitleHide,
      toggleReveal: toggleReveal, expandAll: expandAll,
      setCompact: setCompact, setColorByRole: setColorByRole
    };
  }

  // Public API surface.
  return {
    extractOrgJson: extractOrgJson,
    parseSiteCode: parseSiteCode,
    siteOf: siteOf,
    normalizeSeed: normalizeSeed,
    buildParentMap: buildParentMap,
    buildTree: buildTree,
    collectSiteMembers: collectSiteMembers,
    computeLCA: computeLCA,
    distinctSites: distinctSites,
    deriveTitleTiers: deriveTitleTiers,
    pruneToSite: pruneToSite,
    graftAssociates: graftAssociates,
    layout: layout,
    createLoadGate: createLoadGate,
    roleBorderColors: roleBorderColors,
    renderChart: renderChart,
    renderSiteChart: renderSiteChart
  };
});
