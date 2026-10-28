// ==UserScript==
// @name         Org Chart Viewer — Portfolio Demo Transform
// @namespace    https://example.com/orgchart-viewer-demo
// @version      1.2.1
// @description  Portfolio demo: transforms the synthetic before/after demo page into the compact, site-scoped, fit-to-viewport org chart. 100% synthetic data, no proprietary content.
// @author       Brian Longo
// @match        file:///*/portfolio/index.html
// @match        http://localhost/*/portfolio/index.html
// @match        http://127.0.0.1/*/portfolio/index.html
// @grant        none
// ==/UserScript==

/*
 * orgchart.portfolio.user.js
 * --------------------------------------------------------------------------------------
 * This userscript demonstrates the SAME transform the demo page performs, but driven from
 * Tampermonkey instead of the page's own button. It reuses the authoritative engine in
 * portfolio/orgchart.core.js: it reads the globals that index.html already loads
 * (window.OrgChartCore + window.FAKE_ORG) and calls OrgChartCore.renderSiteChart() — the
 * exact pipeline (root at the anchor -> prune to the selected site -> fit-to-viewport
 * layout -> render) used elsewhere in this project. If you change the transform,
 * change it in orgchart.core.js and this script stays in sync automatically because it
 * delegates to that engine rather than re-implementing it.
 *
 * All data is the fictional "Northwind Logistics" set in fake-data.js. Nothing here is
 * proprietary, and the script makes no network calls (avatars are inline SVG monograms).
 *
 * ---- How to run -----------------------------------------------------------------------
 * 1. Install Tampermonkey (or a compatible userscript manager) in your browser.
 * 2. Add this file as a new userscript.
 * 3. Point @match at wherever you serve the demo:
 *      - Opening the file directly:   file:///C:/path/to/portfolio/index.html
 *        (the default file-URL rule in the metadata block usually covers this)
 *      - Serving over localhost:       http://localhost:8080/portfolio/index.html
 *        then add/adjust an @match such as  http://localhost:8080/portfolio/index.html
 *    For file:// matches you must also enable Tampermonkey's "Allow access to file URLs"
 *    on the extension's details page.
 * 4. Open portfolio/index.html. The script auto-runs the compact AFTER view on load.
 *    You can also trigger it manually from Tampermonkey's menu entry "Enhance org chart".
 * --------------------------------------------------------------------------------------
 */
(function () {
  'use strict';

  // Persisted view settings (localStorage; same spirit as the production host). Remembers
  // the selected Site, "Compact People" (default OFF) and "Color by role" (default ON) across
  // visits. Wrapped in try/catch so a restricted context degrades silently to the defaults.
  var SETTINGS = { SITE: 'oc-demo-us-site', COMPACT: 'oc-demo-us-compact-people', COLOR: 'oc-demo-us-color-by-role' };
  function readBoolSetting(key, dflt) {
    try { var v = window.localStorage.getItem(key); if (v === null || v === undefined) { return dflt; } return v === '1' || v === 'true'; } catch (e) { return dflt; }
  }
  function writeBoolSetting(key, on) { try { window.localStorage.setItem(key, on ? '1' : '0'); } catch (e) { } }
  function readSiteSetting() { try { return window.localStorage.getItem(SETTINGS.SITE) || null; } catch (e) { return null; } }
  function writeSiteSetting(v) { try { if (v) { window.localStorage.setItem(SETTINGS.SITE, String(v)); } } catch (e) { } }

  // Deterministic inline SVG monogram avatar (same approach as the demo page): a
  // self-contained data-URI so there are no external image requests.
  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    var a = parts[0] ? parts[0].charAt(0) : '';
    var b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (a + b).toUpperCase() || '?';
  }
  function hueFor(name) {
    var h = 0; name = String(name || '');
    for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) >>> 0; }
    return h % 360;
  }
  function monogram(node) {
    var name = (node.data && node.data.full_name) || node.id;
    var bg = 'hsl(' + hueFor(name) + ',52%,42%)';
    var txt = initials(name);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">' +
      '<rect width="80" height="80" rx="12" fill="' + bg + '"/>' +
      '<text x="40" y="44" font-family="Segoe UI,Arial,sans-serif" font-size="32" ' +
      'font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">' +
      txt + '</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // Build a full-viewport overlay container for the compact AFTER view.
  function makeOverlay() {
    var existing = document.getElementById('oc-portfolio-overlay');
    if (existing) { return existing; }
    var overlay = document.createElement('div');
    overlay.id = 'oc-portfolio-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '2147483000';
    overlay.style.background = '#0f1420';
    overlay.style.color = '#eef2f8';
    overlay.style.font = '14px "Segoe UI", Roboto, Arial, sans-serif';

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 16px;' +
      'background:#19202e;border-bottom:1px solid #38475f;';
    var title = document.createElement('span');
    title.textContent = 'Org Chart Viewer — compact view (userscript)';
    title.style.fontWeight = '600';

    var label = document.createElement('label');
    label.textContent = 'Site';
    label.style.color = '#9fb0c7';
    var select = document.createElement('select');
    select.id = 'oc-portfolio-site';
    select.style.cssText = 'font:inherit;background:#212a3b;color:#eef2f8;' +
      'border:1px solid #38475f;border-radius:8px;padding:6px 10px;';

    // Compact People / Color by role toggles (persisted; defaults Compact OFF, Color ON).
    var compactLabel = document.createElement('label');
    compactLabel.style.color = '#9fb0c7';
    var compactToggle = document.createElement('input');
    compactToggle.type = 'checkbox';
    compactToggle.id = 'oc-portfolio-compact';
    compactToggle.checked = readBoolSetting(SETTINGS.COMPACT, false);
    compactLabel.appendChild(compactToggle);
    compactLabel.appendChild(document.createTextNode(' Compact People'));

    var colorLabel = document.createElement('label');
    colorLabel.style.color = '#9fb0c7';
    var colorToggle = document.createElement('input');
    colorToggle.type = 'checkbox';
    colorToggle.id = 'oc-portfolio-color';
    colorToggle.checked = readBoolSetting(SETTINGS.COLOR, true);
    colorLabel.appendChild(colorToggle);
    colorLabel.appendChild(document.createTextNode(' Color by role'));

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'font:inherit;background:#212a3b;color:#eef2f8;' +
      'border:1px solid #38475f;border-radius:8px;padding:6px 12px;cursor:pointer;margin-left:auto;';
    closeBtn.addEventListener('click', function () { overlay.remove(); });

    bar.appendChild(title);
    bar.appendChild(label);
    bar.appendChild(select);
    bar.appendChild(compactLabel);
    bar.appendChild(colorLabel);
    bar.appendChild(closeBtn);

    var stage = document.createElement('div');
    stage.id = 'oc-portfolio-stage';
    stage.style.cssText = 'position:absolute;left:0;right:0;top:49px;bottom:0;';

    overlay.appendChild(bar);
    overlay.appendChild(stage);
    document.body.appendChild(overlay);
    return overlay;
  }

  // Inject the chip/edge CSS the engine's renderChart() expects. Kept in sync with the
  // classes documented in orgchart.core.js (.oc-stage/.oc-edges/.oc-chip/...).
  function injectStyles() {
    if (document.getElementById('oc-portfolio-style')) { return; }
    var css =
      '.oc-stage{will-change:transform;}' +
      // Dragging anywhere on the chart pans it: never select text or ghost-drag a photo.
      '.oc-stage,.oc-chip{-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;}' +
      '.oc-chip,.oc-chip *{cursor:inherit;}' +
      '.oc-edges path.oc-edge{stroke:#4f9dff;stroke-width:1.5;opacity:.6;fill:none;}' +
      '.oc-chip{position:absolute;background:#1d2636;border:1px solid #3a4a65;border-radius:12px;' +
      'display:flex;align-items:center;gap:10px;padding:10px 12px;box-shadow:0 2px 10px rgba(0,0,0,.35);}' +
      // Color by role: thicker tier border, kept inside the fixed w/h via border-box so geometry is unchanged.
      '.oc-chip.oc-role-colored{border-width:3px;box-sizing:border-box;}' +
      '.oc-chip .oc-avatar{width:56px;height:56px;border-radius:10px;flex:0 0 auto;' +
      '-webkit-user-drag:none;-khtml-user-drag:none;-moz-user-drag:none;-o-user-drag:none;user-drag:none;}' +
      '.oc-chip .oc-name{font-size:15px;font-weight:700;line-height:1.15;}' +
      '.oc-chip .oc-title{font-size:12px;color:#9fb0c7;line-height:1.2;}' +
      '.oc-chip .oc-site{font-size:11px;color:#9fb0c7;line-height:1.2;}' +
      // Compact People: photo-dominant chip (big avatar + name only; details stay in the popup).
      '.oc-chip.oc-compact{flex-direction:column-reverse;gap:5px;padding:7px 6px 9px;justify-content:center;}' +
      '.oc-chip.oc-compact .oc-avatar{width:76px;height:76px;border-radius:12px;}' +
      '.oc-chip.oc-compact .oc-name{font-size:12px;line-height:1.1;width:100%;text-align:center;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.oc-chip.oc-compact .oc-toggle{right:4px;bottom:4px;width:20px;height:20px;line-height:18px;font-size:13px;}' +
      '.oc-chip .oc-toggle{position:absolute;right:6px;bottom:6px;width:22px;height:22px;' +
      'line-height:20px;text-align:center;border-radius:50%;border:1px solid #3a4a65;' +
      'background:#212a3b;color:#eef2f8;cursor:pointer;font-size:14px;padding:0;}' +
      // Node-anchored speech-bubble detail popup (dark theme, larger readable text). overflow
      // is visible so the caret isn't clipped; the whole bubble uses the default cursor.
      '.oc-popup{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483600;' +
      'background:#1d2636;border:1px solid #3a4a65;border-radius:14px;padding:22px 26px;' +
      'min-width:280px;max-width:min(90vw,460px);max-height:80vh;overflow:visible;cursor:default;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.55);color:#eef2f8;line-height:1.4;' +
      '-webkit-user-select:text;-moz-user-select:text;-ms-user-select:text;user-select:text;}' +
      '.oc-popup .oc-popup-avatar{display:block;width:72px;height:72px;border-radius:12px;' +
      'object-fit:cover;margin:0 0 12px;-webkit-user-drag:none;user-drag:none;}' +
      '.oc-popup .oc-popup-name{font-size:20px;font-weight:700;margin:0 28px 12px 0;}' +
      // Over selectable text: the I-beam cursor; text stays selectable.
      '.oc-popup .oc-popup-name,.oc-popup .oc-popup-row,.oc-popup .oc-popup-label,.oc-popup .oc-popup-value{' +
      'cursor:text;-webkit-user-select:text;-moz-user-select:text;-ms-user-select:text;user-select:text;}' +
      '.oc-popup a,.oc-popup .oc-popup-link{color:#4f9dff;text-decoration:none;}' +
      // Link and × keep the pointer hand.
      '.oc-popup a,.oc-popup .oc-popup-link,.oc-popup .oc-popup-close{cursor:pointer;}' +
      '.oc-popup a:hover,.oc-popup .oc-popup-link:hover{text-decoration:underline;}' +
      '.oc-popup .oc-popup-row{margin:6px 0;white-space:normal;word-break:break-word;}' +
      '.oc-popup .oc-popup-label{color:#9fb0c7;}' +
      '.oc-popup .oc-popup-close{position:absolute;top:10px;right:12px;width:28px;height:28px;' +
      'line-height:24px;text-align:center;border-radius:50%;border:1px solid #3a4a65;' +
      'background:#212a3b;color:#eef2f8;font-size:18px;padding:0;}' +
      '.oc-popup .oc-popup-close:hover{background:#2a3650;}' +
      // Speech-bubble caret pointing at the clicked node (two triangles: border + fill).
      '.oc-popup .oc-popup-caret{position:absolute;width:0;height:0;}' +
      '.oc-popup .oc-popup-caret::before,.oc-popup .oc-popup-caret::after{content:\'\';position:absolute;' +
      'width:0;height:0;border:solid transparent;}' +
      '.oc-popup .oc-popup-caret-down{bottom:0;}' +
      '.oc-popup .oc-popup-caret-down::before{top:0;margin-left:-11px;border-width:11px;border-top-color:#3a4a65;}' +
      '.oc-popup .oc-popup-caret-down::after{top:0;margin-left:-10px;border-width:10px;border-top-color:#1d2636;}' +
      '.oc-popup .oc-popup-caret-up{top:0;}' +
      '.oc-popup .oc-popup-caret-up::before{bottom:0;margin-left:-11px;border-width:11px;border-bottom-color:#3a4a65;}' +
      '.oc-popup .oc-popup-caret-up::after{bottom:0;margin-left:-10px;border-width:10px;border-bottom-color:#1d2636;}';
    var style = document.createElement('style');
    style.id = 'oc-portfolio-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function enhance() {
    var OC = window.OrgChartCore;
    var ROOT = window.FAKE_ORG;
    if (!OC || !ROOT) {
      console.warn('[orgchart demo] OrgChartCore / FAKE_ORG not found — open portfolio/index.html.');
      return;
    }
    injectStyles();
    var overlay = makeOverlay();
    var stage = overlay.querySelector('#oc-portfolio-stage');
    var select = overlay.querySelector('#oc-portfolio-site');
    var compactToggle = overlay.querySelector('#oc-portfolio-compact');
    var colorToggle = overlay.querySelector('#oc-portfolio-color');
    var controller = null;

    if (!select.options.length) {
      var sites = OC.distinctSites(ROOT);
      sites.forEach(function (code) {
        var opt = document.createElement('option');
        opt.value = code; opt.textContent = code;
        select.appendChild(opt);
      });
      // Restore the remembered site when still valid, else default to the demoable split site.
      var saved = readSiteSetting();
      if (saved && sites.indexOf(saved) !== -1) { select.value = saved; }
      else { select.value = sites.indexOf('NDC1') !== -1 ? 'NDC1' : (sites[0] || ''); }
      select.addEventListener('change', function () { writeSiteSetting(select.value); draw(); });
    }

    // Live toggles persist and re-render in place (preserving zoom/pan) via the controller.
    compactToggle.addEventListener('change', function () {
      writeBoolSetting(SETTINGS.COMPACT, compactToggle.checked);
      if (controller && controller.setCompact) { controller.setCompact(compactToggle.checked); }
    });
    colorToggle.addEventListener('change', function () {
      writeBoolSetting(SETTINGS.COLOR, colorToggle.checked);
      if (controller && controller.setColorByRole) { controller.setColorByRole(colorToggle.checked); }
    });

    function draw() {
      controller = OC.renderSiteChart(stage, ROOT, select.value, function () {
        return { w: stage.clientWidth || 1920, h: stage.clientHeight || 1080 };
      }, {
        resolveAvatar: monogram,
        resolveProfileUrl: function (node) {
          return node.data && node.data.isAssociate
            ? 'https://example.com/e/' + encodeURIComponent(node.id)
            : 'https://example.com/u/' + encodeURIComponent(node.id);
        },
        compact: compactToggle.checked,
        colorByRole: colorToggle.checked
      });
    }
    draw();
  }

  // Tampermonkey menu entry for manual runs (ignored if the API is unavailable).
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Enhance org chart', enhance);
  }

  // Auto-run once the page's globals are ready.
  function whenReady() {
    if (window.OrgChartCore && window.FAKE_ORG) { enhance(); return; }
    setTimeout(whenReady, 100);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    whenReady();
  } else {
    window.addEventListener('DOMContentLoaded', whenReady);
  }
})();
