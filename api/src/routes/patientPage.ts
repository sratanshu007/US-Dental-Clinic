// Markup + script for the public patient link page. Kept as strings so the API stays one service.
// The HTML holds no patient data; the script fetches it after the patient passes the check.

export function patientHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Your appointment</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f3f6fb;color:#0f1b2d;min-height:100vh;display:flex;justify-content:center;padding:28px 16px}
main{width:100%;max-width:440px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#0ea5e9,#2563eb);color:#fff;display:grid;place-items:center;font-weight:800;font-size:18px}
.brand b{font-size:18px}.brand small{display:block;color:#5b6b82;font-size:13px}
.card{background:#fff;border-radius:20px;padding:24px;box-shadow:0 10px 30px rgba(15,27,45,.08);border:1px solid #e5ebf3}
h1{font-size:22px;line-height:1.25;margin-bottom:8px}
p{color:#4a5a72;line-height:1.55;font-size:15px}
label{display:block;font-weight:600;font-size:14px;margin:18px 0 6px}
input{width:100%;font-size:17px;padding:14px;border-radius:12px;border:1.5px solid #cdd7e4;outline:none}
input:focus{border-color:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.12)}
button,.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;font-size:16px;font-weight:700;padding:14px;border-radius:12px;border:0;cursor:pointer;margin-top:12px;text-decoration:none}
.primary{background:#2563eb;color:#fff}.primary:disabled{opacity:.6}
.ghost{background:#eef3fb;color:#1d3a6b}
.call{background:#16a34a;color:#fff}
.err{color:#b42318;font-size:14px;margin-top:10px;min-height:1em}
.row{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #edf1f6;font-size:15px}
.row:last-child{border-bottom:0}.row span{color:#5b6b82}.row b{text-align:right}
.big{font-size:20px;font-weight:800;margin:10px 0 6px}
.badge{display:inline-block;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700;background:#fff4d6;color:#8a5a00}
.badge.ok{background:#dcfce7;color:#166534}.badge.no{background:#fee2e2;color:#991b1b}
.note{background:#f0f7ff;border:1px solid #d6e6ff;border-radius:12px;padding:12px;margin-top:14px;font-size:14px;color:#1d3a6b}
.foot{text-align:center;color:#7a889c;font-size:12px;margin-top:18px;line-height:1.5}
.hide{display:none}
</style>
</head>
<body>
<main>
  <div class="brand"><div class="logo" id="logo">+</div><div><b id="clinic">Loading…</b><small>Appointment details</small></div></div>
  <div class="card" id="view-loading"><p>Loading…</p></div>

  <div class="card hide" id="view-check">
    <h1>Confirm it's you</h1>
    <p>For your privacy, please answer one question before we show your appointment.</p>
    <form id="check-form" autocomplete="off">
      <label for="answer" id="q-label">Your last name</label>
      <input id="answer" name="answer" required maxlength="100" autocapitalize="words" spellcheck="false">
      <div class="err" id="check-err" role="alert"></div>
      <button class="primary" id="check-btn" type="submit">Continue</button>
    </form>
  </div>

  <div class="card hide" id="view-details">
    <span class="badge" id="status">Booked</span>
    <div class="big" id="when"></div>
    <div id="rows"></div>
    <div class="note hide" id="done-note" role="status"></div>
    <button class="primary hide" id="confirm-btn" type="button">Confirm my appointment</button>
    <button class="ghost hide" id="resched-btn" type="button">I need a new time</button>
    <div class="hide" id="resched-ask">
      <p style="margin-top:14px">We'll call you to find a new time. Your current appointment stays booked until then.</p>
      <button class="primary" id="resched-yes" type="button">Yes, please call me</button>
      <button class="ghost" id="resched-no" type="button">Keep my appointment</button>
    </div>
    <a class="btn call" id="call-btn" href="#">Call the office</a>
    <div class="err" id="act-err" role="alert"></div>
  </div>

  <div class="card hide" id="view-stop">
    <h1 id="stop-title">This link can't be used</h1>
    <p id="stop-text">Please call the office for help with your appointment.</p>
    <a class="btn call hide" id="stop-call" href="#">Call the office</a>
  </div>

  <p class="foot">This page is private to you. Don't share this link.<br>For emergencies call 911.</p>
</main>
<script src="/p/assets/patient.js"></script>
</body>
</html>`;
}

export const PATIENT_JS = String.raw`(function () {
  var token = location.pathname.split("/")[2] || "";
  var base = "/p/" + encodeURIComponent(token);
  var session = null, phone = null;
  function $(id) { return document.getElementById(id); }
  function show(id) {
    ["view-loading", "view-check", "view-details", "view-stop"].forEach(function (v) { $(v).classList.toggle("hide", v !== id); });
  }
  function fmtPhone(e164) {
    var d = (e164 || "").replace(/\D/g, "").slice(-10);
    return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : e164;
  }
  function setCall(a) { if (phone) { a.href = "tel:" + phone; a.textContent = "Call the office · " + fmtPhone(phone); a.classList.remove("hide"); } }
  function stop(title, text) { $("stop-title").textContent = title; $("stop-text").textContent = text; setCall($("stop-call")); show("view-stop"); }
  function api(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    if (session) headers.Authorization = "Bearer " + session;
    return fetch(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; }); });
  }
  var STATUS = { BOOKED: ["Booked", ""], CONFIRMED: ["Confirmed", "ok"], CANCELLED: ["Cancelled", "no"], NO_SHOW: ["Missed", "no"], SHOWED: ["Completed", "ok"], RESCHEDULED: ["Rescheduled", "no"] };

  function render(d) {
    var a = d.appointment;
    if (!a) { stop("Appointment not found", "This appointment may have changed. Please call the office."); return; }
    var s = STATUS[a.status] || [a.status, ""];
    $("status").textContent = s[0]; $("status").className = "badge " + s[1];
    $("when").textContent = a.when;
    var rows = $("rows"); rows.innerHTML = "";
    [["Patient", d.firstName], ["Visit", a.service], ["Dentist", a.provider], ["Office", d.clinic.name], ["Address", d.clinic.address]].forEach(function (r) {
      if (!r[1]) return;
      var div = document.createElement("div"); div.className = "row";
      var sp = document.createElement("span"); sp.textContent = r[0];
      var b = document.createElement("b"); b.textContent = r[1];
      div.appendChild(sp); div.appendChild(b); rows.appendChild(div);
    });
    $("confirm-btn").classList.toggle("hide", !a.canConfirm);
    $("resched-btn").classList.toggle("hide", !a.canReschedule);
    setCall($("call-btn"));
    show("view-details");
  }
  function note(text) { var n = $("done-note"); n.textContent = text; n.classList.remove("hide"); }
  function handleErr(r, el) {
    if (r.status === 401) { session = null; show("view-check"); $("check-err").textContent = "For your privacy, please answer again."; return; }
    if (r.status === 410) return stop("This link has expired", "Links work for a limited time. Please call the office.");
    if (r.status === 423) return stop("This link is locked", "Too many wrong answers. Please call the office.");
    el.textContent = (r.json && r.json.error) || "Something went wrong. Please try again or call the office.";
  }

  api("GET", "/info").then(function (r) {
    if (r.status !== 200) return stop("This link is not valid", "Please check the link in your text, or call the office.");
    var j = r.json; phone = j.clinicPhone;
    $("clinic").textContent = j.clinicName; document.title = j.clinicName + " · Your appointment";
    $("logo").textContent = (j.clinicName || "+").trim().charAt(0).toUpperCase();
    if (j.state === "expired") return stop("This link has expired", "Links work for a limited time. Please call the office.");
    if (j.state === "locked") return stop("This link is locked", "Too many wrong answers. Please call the office.");
    $("q-label").textContent = j.question.label;
    if (j.question.kind === "phone4") { $("answer").setAttribute("inputmode", "numeric"); $("answer").setAttribute("maxlength", "4"); }
    show("view-check"); $("answer").focus();
  }).catch(function () { stop("Can't load this page", "Please check your connection and try again."); });

  $("check-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("check-err").textContent = ""; $("check-btn").disabled = true;
    api("POST", "/verify", { answer: $("answer").value }).then(function (r) {
      $("check-btn").disabled = false;
      if (r.status === 200) { session = r.json.session; $("answer").value = ""; render(r.json.details); return; }
      handleErr(r, $("check-err"));
    }).catch(function () { $("check-btn").disabled = false; $("check-err").textContent = "Connection problem. Please try again."; });
  });

  $("confirm-btn").addEventListener("click", function () {
    $("act-err").textContent = ""; this.disabled = true; var btn = this;
    api("POST", "/confirm").then(function (r) {
      btn.disabled = false;
      if (r.status === 200) { render(r.json); note("Thank you! Your appointment is confirmed."); return; }
      handleErr(r, $("act-err"));
    });
  });
  $("resched-btn").addEventListener("click", function () { this.classList.add("hide"); $("resched-ask").classList.remove("hide"); });
  $("resched-no").addEventListener("click", function () { $("resched-ask").classList.add("hide"); $("resched-btn").classList.remove("hide"); });
  $("resched-yes").addEventListener("click", function () {
    $("act-err").textContent = ""; this.disabled = true; var btn = this;
    api("POST", "/reschedule").then(function (r) {
      btn.disabled = false;
      if (r.status === 200) { $("resched-ask").classList.add("hide"); $("confirm-btn").classList.add("hide"); note("Got it. The office will call you soon to find a new time. You can also call now."); return; }
      handleErr(r, $("act-err"));
    });
  });
})();`;
