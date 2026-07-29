/* eslint-env browser */
/**
 * Dashboard client. Polls /api/jobs and re-renders only the list, so filters,
 * scroll position, and expanded rows survive a refresh. The previous build
 * meta-refreshed the whole document every 15s, which reset the selected tab
 * mid-browse and forced a sessionStorage hack to paper over it.
 *
 * COLORS is injected by the server so the palette has one source of truth.
 */
(function () {
  "use strict";

  var state = { source: "all", status: "all", role: "all", sort: "fresh", q: "" };
  var rows = [];
  var open = Object.create(null); // url -> true, so expansion survives re-render

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  function ageOf(r) {
    var h = r.age_hours;
    if (h === null) return { text: "no date", color: COLORS.theme.faint, title: "This source publishes no posting date" };

    var mins = Math.floor(h * 60), hours = Math.floor(h), days = Math.floor(h / 24), text;
    if (!r.precise_age) {
      text = days <= 0 ? "today" : days < 30 ? days + "d" : Math.floor(days / 30) + "mo";
    } else if (mins < 1) text = "just now";
    else if (mins < 60) text = mins + "m";
    else if (hours < 24) text = hours + "h";
    else if (days < 7) { var rem = hours - days * 24; text = rem ? days + "d " + rem + "h" : days + "d"; }
    else if (days < 30) text = days + "d";
    else text = Math.floor(days / 30) + "mo";

    return {
      text: text,
      color: hours < 24 ? COLORS.theme.fresh : days <= 7 ? COLORS.theme.muted : COLORS.theme.faint,
      title: r.precise_age
        ? new Date(r.posted_at).toLocaleString()
        : new Date(r.posted_at).toDateString() + " — source gives the date only, no time of day",
    };
  }

  /** Rail opacity is the freshness channel; hue is the source channel. */
  function rail(r) {
    var hue = COLORS.source[r.source] || COLORS.theme.faint;
    var h = r.age_hours;
    var o = h === null ? 28 : h < 24 ? 100 : h < 72 ? 80 : h < 168 ? 60 : h < 720 ? 42 : 28;
    return "--rail:color-mix(in srgb, " + hue + " " + o + "%, " + COLORS.theme.ink + ")";
  }

  function pill(text, color) {
    return '<span class="pill" style="color:' + color + ';border-color:' + color + '44">' + esc(text) + "</span>";
  }

  function matches(r) {
    if (state.source !== "all" && r.source !== state.source) return false;
    if (state.status !== "all" && r.status !== state.status) return false;
    if (state.role !== "all" && r.role_category !== state.role) return false;
    if (state.q) {
      var hay = (r.title + " " + r.company + " " + r.location).toLowerCase();
      if (hay.indexOf(state.q) === -1) return false;
    }
    return true;
  }

  var SORTS = {
    // Undated jobs sink rather than pretending to be brand new.
    fresh: function (a, b) {
      var av = a.age_hours === null ? Infinity : a.age_hours;
      var bv = b.age_hours === null ? Infinity : b.age_hours;
      return av - bv;
    },
    fit: function (a, b) { return (parseFloat(b.fit_score) || 0) - (parseFloat(a.fit_score) || 0); },
    company: function (a, b) { return a.company.localeCompare(b.company); },
  };

  function renderRow(r) {
    var a = ageOf(r);
    var railCss = rail(r);
    var expanded = !!open[r.url];

    var bits = [];
    bits.push('<span class="co">' + esc(r.company) + "</span>");
    if (r.location) bits.push('<span class="sep">/</span>' + esc(r.location));
    if (r.apply_type === "easy_apply") bits.push(pill("easy apply", COLORS.theme.accent));
    if (r.verdict) {
      bits.push(
        '<span class="fit" style="color:' + (COLORS.verdict[r.verdict] || COLORS.theme.muted) + '">' +
          (r.fit_score ? esc(r.fit_score) + "/5 " : "") + esc(r.verdict.replace("_", " ")) + "</span>"
      );
    }
    if (r.red_flags.length) {
      bits.push('<span class="flag" title="' + esc(r.red_flags.join(" • ")) + '">⚑ ' + r.red_flags.length + "</span>");
    }
    bits.push('<span class="st" style="color:' + (COLORS.status[r.status] || COLORS.theme.faint) + '">' + esc(r.status) + "</span>");

    var head =
      '<button class="row" style="' + railCss + '" aria-expanded="' + expanded + '" data-url="' + esc(r.url) + '">' +
        '<span class="l1">' +
          '<span class="t">' + esc(r.title) + "</span>" +
          '<span class="age" style="color:' + a.color + '" title="' + esc(a.title) + '">' + esc(a.text) + "</span>" +
        "</span>" +
        '<span class="l2">' + bits.join("") + "</span>" +
      "</button>";

    if (!expanded) return head;

    var d = "";
    if (r.reason) d += '<div class="blk"><h4>Why this score</h4><p>' + esc(r.reason) + "</p></div>";
    if (r.red_flags.length) {
      d += '<div class="blk"><h4>Red flags</h4><ul>' +
        r.red_flags.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul></div>";
    }
    d += '<div class="blk"><h4>Details</h4><div class="dims">' +
      "<span><i>source</i> " + esc(r.source) + "</span>" +
      (r.role_category ? "<span><i>matched</i> " + esc(r.role_category) + "</span>" : "") +
      (r.score ? "<span><i>triage</i> " + esc(r.score) + "/10</span>" : "") +
      (r.updated_at ? "<span><i>updated</i> " + new Date(r.updated_at).toLocaleString() + "</span>" : "") +
      "</div></div>";
    if (r.description) {
      d += '<div class="blk"><h4>Description</h4><div class="desc">' + esc(r.description.slice(0, 1600)) + "</div></div>";
    }
    d += '<div class="acts"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">Open posting</a></div>';

    return head + '<div class="detail" style="' + railCss + '">' + d + "</div>";
  }

  function render() {
    var shown = rows.filter(matches).sort(SORTS[state.sort] || SORTS.fresh);
    $("list").innerHTML = shown.map(renderRow).join("");
    $("count").textContent = shown.length + " of " + rows.length;
    $("empty").hidden = shown.length > 0;
  }

  function bind() {
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (t) { t.setAttribute("aria-selected", "false"); });
        tab.setAttribute("aria-selected", "true");
        state.source = tab.dataset.source;
        render();
      });
    });

    ["status", "role", "sort"].forEach(function (id) {
      $(id).addEventListener("change", function () { state[id] = this.value; render(); });
    });

    var t;
    $("q").addEventListener("input", function () {
      var v = this.value.trim().toLowerCase();
      clearTimeout(t);
      t = setTimeout(function () { state.q = v; render(); }, 120);
    });

    // Delegated so rows re-rendered by a poll keep working.
    $("list").addEventListener("click", function (e) {
      var btn = e.target.closest(".row");
      if (!btn) return;
      var url = btn.dataset.url;
      if (open[url]) delete open[url];
      else open[url] = true;
      render();
    });
  }

  function poll() {
    fetch("/api/jobs", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        rows = data.rows;
        $("stamp").textContent = new Date().toLocaleTimeString();
        $("live").textContent = "live";
        $("live").style.color = COLORS.theme.fresh;
        render();
      })
      .catch(function () {
        $("live").textContent = "offline";
        $("live").style.color = COLORS.theme.danger;
      });
  }

  bind();
  poll();
  setInterval(poll, 15000);
})();
