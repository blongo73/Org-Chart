/*
 * fake-data.js — synthetic org tree for the PORTFOLIO build and the test harness.
 *
 * 100% fictional. Contains NO real-company, product, or mascot references, no corporate
 * URLs, no real names, no real buildings, no PII. Company: "Northwind Logistics".
 *
 * Shape mirrors the production seed node exactly so the same engine runs over it:
 *   { id, children[], data{ badge_color, badge_url, direct_reports,
 *     direct_reports_with_null_login, is_direct_count_discrepancy_found, is_manager,
 *     full_name, job_title, department_name, building, phone, expanded } }
 *
 * Sites: NDC1, NDC2, WDC1, WDC2, HQ1. Building format mirrors prod:
 *   CODE-Descriptor(City,ST,US).
 *
 * Demoable convergence (mirrors a real-world split-site scenario): NDC1 people are split under
 * TWO managers — some NDC1 reports sit under the NDC1 GM (scrateman), and some NDC1
 * Senior/Ops managers sit under the WDC1 Site Leader (rdockson). So collectSiteMembers
 * ('NDC1') + computeLCA must resolve the top to the shared Director (dboxwell), not either
 * manager. A non-split site (NDC2) resolves to its own single manager (vloadman).
 */
(function (root, factory) {
  var result = factory();
  var data = result.tree;
  if (typeof window !== 'undefined') {
    window.FAKE_ORG = data;
    window.FAKE_ASSOCIATES = result.associates;
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = data; }
  if (typeof root !== 'undefined' && root && !root.FAKE_ORG) { root.FAKE_ORG = data; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BUILDINGS = {
    NDC1: 'NDC1-Central DC(Lincoln,NE,US)',
    NDC2: 'NDC2-North DC(Fargo,ND,US)',
    WDC1: 'WDC1-West DC(Reno,NV,US)',
    WDC2: 'WDC2-West DC Two(Boise,ID,US)',
    HQ1: 'HQ1-HQ(Denver,CO,US)'
  };

  // Build a prod-shaped node. is_manager is set truthfully from the child count so a
  // crawl over the derived seed map behaves exactly like production.
  function P(id, full_name, job_title, siteCode, children) {
    children = children || [];
    return {
      id: id,
      children: children,
      data: {
        badge_color: 'blue',
        badge_url: '', // portfolio avatars come from a generated SVG monogram, not a URL
        direct_reports: children.length,
        direct_reports_with_null_login: 0,
        is_direct_count_discrepancy_found: false,
        is_manager: children.length > 0,
        full_name: full_name,
        job_title: job_title,
        department_name: 'Operations-Fixed',
        building: BUILDINGS[siteCode],
        phone: null,
        expanded: true
      }
    };
  }

  // ---- Level 5 (bottom): Area Managers / Associates (leaves) --------------------------
  var trackman = P('trackman', 'Toby Rackman', 'Area Manager', 'NDC1');
  var epallet = P('epallet', 'Elliot Pallet', 'Area Manager', 'NDC1');
  var hdock = P('hdock', 'Harper Dock', 'Area Manager', 'NDC1');
  var mfreight = P('mfreight', 'Micah Freight', 'Area Manager', 'NDC1');
  var rcargo = P('rcargo', 'Rowan Cargo', 'Area Manager', 'NDC1');
  var bscanner = P('bscanner', 'Blair Scanner', 'Area Manager', 'WDC1');
  var ftote = P('ftote', 'Finley Tote', 'Area Manager', 'NDC2');
  var sbale = P('sbale', 'Skyler Bale', 'Area Manager', 'NDC2');
  var jchock = P('jchock', 'Jesse Chock', 'Area Manager', 'WDC2');

  // ---- Level 4: Operations Managers ---------------------------------------------------
  var rcrane = P('rcrane', 'Riley Crane', 'Operations Manager', 'NDC1', [trackman, epallet]);
  var dhoist = P('dhoist', 'Drew Hoist', 'Operations Manager', 'NDC1', [hdock]);
  var jloader = P('jloader', 'Jamie Loader', 'Operations Manager', 'NDC1', [mfreight]);
  var nbins = P('nbins', 'Noah Bins', 'Operations Manager', 'NDC1', [rcargo]);
  var kramp = P('kramp', 'Kelly Ramp', 'Operations Manager', 'WDC1', [bscanner]);
  var schute = P('schute', 'Sydney Chute', 'Operations Manager', 'NDC2', [ftote]);
  var rdolly = P('rdolly', 'Reese Dolly', 'Operations Manager', 'NDC2', [sbale]);
  var dskid = P('dskid', 'Devon Skid', 'Operations Manager', 'WDC2', [jchock]);

  // ---- Level 3: Senior Operations Managers (and HQ staff) -----------------------------
  // NDC1 Sr managers under the NDC1 GM:
  var ppalletti = P('ppalletti', 'Pat Palletti', 'Senior Operations Manager', 'NDC1', [rcrane]);
  var cforklift = P('cforklift', 'Casey Forklift', 'Senior Operations Manager', 'NDC1', [dhoist]);
  // NDC1 Sr managers that report into the WDC1 Site Leader (the split!):
  var aconveyer = P('aconveyer', 'Alex Conveyer', 'Senior Operations Manager', 'NDC1', [jloader]);
  var tpackman = P('tpackman', 'Taylor Packman', 'Senior Operations Manager', 'NDC1', [nbins]);
  // WDC1 Sr manager under the WDC1 Site Leader:
  var jbinns = P('jbinns', 'Jordan Binns', 'Senior Operations Manager', 'WDC1', [kramp]);
  // NDC2 Sr managers under the NDC2 GM:
  var lpallette = P('lpallette', 'Lee Pallette', 'Senior Operations Manager', 'NDC2', [schute]);
  var mshelves = P('mshelves', 'Morgan Shelves', 'Senior Operations Manager', 'NDC2', [rdolly]);
  // WDC2 Sr manager under the WDC2 Site Leader:
  var qhauler = P('qhauler', 'Quinn Hauler', 'Senior Operations Manager', 'WDC2', [dskid]);
  // HQ staff under the HQ ops lead:
  var adocket = P('adocket', 'Avery Docket', 'Program Manager', 'HQ1');

  // ---- Level 2: GMs / Site Leaders / HQ lead ------------------------------------------
  var scrateman = P('scrateman', 'Sam Crateman', 'General Manager, Operations', 'NDC1', [ppalletti, cforklift]);
  // WDC1 Site Leader also carries two NDC1 Sr managers -> this is the NDC1 split source.
  var rdockson = P('rdockson', 'Robin Dockson', 'Site Leader', 'WDC1', [jbinns, aconveyer, tpackman]);
  var vloadman = P('vloadman', 'Victor Loadman', 'General Manager, Operations', 'NDC2', [lpallette, mshelves]);
  var pshelton = P('pshelton', 'Priya Shelton', 'Site Leader', 'WDC2', [qhauler]);
  var mledger = P('mledger', 'Morgan Ledger', 'Senior Program Manager', 'HQ1', [adocket]);

  // ---- Level 1: Director (shared ancestor / convergence point for NDC1) ---------------
  var dboxwell = P('dboxwell', 'Dana Boxwell', 'Director, Regional Operations', 'HQ1',
    [scrateman, rdockson, vloadman, pshelton, mledger]);

  // ---- Synthetic "associates" for the Include-associates demo -------------------------
  // Mirrors the production roster graft WITHOUT any brand/URL/PII: a flat list of fictional
  // front-line associates handed to OrgChartCore.graftAssociates (the SAME generic helper
  // production uses). Each record is { login, full_name, job_title, building, badge_url,
  // managerLogin?, managerName? }. building = the BARE site code 'NDC1' (like the real
  // front-line roster, which hands over a bare warehouse code): graftAssociates resolves it
  // to the full "NDC1-Central DC(Lincoln,NE,US)" string via the site-code map built from the
  // NDC1 people already in the tree, keyed by the associate's OWN site code. So they land
  // under the demo's default NDC1 site and their detail card shows the full building name.
  // Avatars come from the SVG monogram, so badge_url stays empty. The three cases exercise
  // the matching cascade:
  //   - awilkie: managerLogin 'trackman' resolves directly (login match).
  //   - bcarton: no login, managerName "Pallet,Elliot" name-matches node epallet.
  //   - cdrayton: managerName "Noone,Here" matches nobody -> DROPPED (demonstrates a drop).
  var ASSOCIATES = [
    {
      login: 'awilkie', full_name: 'Avery Wilkie', job_title: 'Associate',
      building: 'NDC1', badge_url: '',
      managerLogin: 'trackman', managerName: 'Rackman,Toby'
    },
    {
      login: 'bcarton', full_name: 'Bailey Carton', job_title: 'Associate',
      building: 'NDC1', badge_url: '',
      managerName: 'Pallet,Elliot'
    },
    {
      login: 'cdrayton', full_name: 'Casey Drayton', job_title: 'Associate',
      building: 'NDC1', badge_url: '',
      managerName: 'Noone,Here'
    }
  ];

  return { tree: dboxwell, associates: ASSOCIATES };
});
