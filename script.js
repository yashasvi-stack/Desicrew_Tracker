'use strict';

/* ═══════════════════════════════════════════════════════════
   CONFIG — update these values
═══════════════════════════════════════════════════════════ */
const CONFIG = {
  // Paste your deployed Google Apps Script Web App URL here:
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxf6T1NXUlbHvs3dRgdizEzDyGncWl1bRkTsDEAL9xA6V3H2YWFD8yEEZ6c9cbbiHCEUA/exec',

  // EmailJS — sign up at https://emailjs.com (free)
  EMAILJS_SERVICE_ID:  'service_a2gw4aw',
  EMAILJS_TEMPLATE_ID: 'template_aqp7ojj',
  EMAILJS_OTP_TEMPLATE_ID: 'template_ul1rts8', // OTP-only template (separate!)
  EMAILJS_PUBLIC_KEY:  'ogon2tHgn2U3SEedB',

  IDLE_MS: 8 * 1000,   // 8 seconds idle threshold
};

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
const LS = 'pt_state';

let U = null;   // logged-in user object from backend

let S = {
  shiftActive:    false,
  clockInTime:    null,   // ISO
  onBreak:        false,
  breakStartTime: null,   // ISO
  breaks:         [],     // [{start,end,durSecs}]
  tasks:          [],     // [{slot,text,dur,ts}]
  idles:          [],     // [{start,end,durSecs}]
  idleStart:      null,
  currentDurSecs: 0,      // for Dhisha: seconds; for Zomato: count (stored as-is)
  finalTarget:    '',
  lateMinutes:    0,
  earlyClockOut:  false,
  process:        'dhisha',  // 'dhisha' | 'zomato'
  currentCount:   0,         // Zomato: numeric count
};

// ── Process helpers ────────────────────────────────────────
function isZomato() { return S.process === 'zomato'; }

function setProcess(proc) {
  S.process = proc;
  saveS();

  // Sync dropdown
  const sel = document.getElementById('proc-select');
  if (sel) sel.value = proc;

  if (proc === 'zomato') {
    document.getElementById('final-target-label').textContent = '⚠ Final Target (number) — required before clock-out';
    document.getElementById('task-dur-label').textContent    = 'Count this hour (number)';
    document.getElementById('dur-hint-text').textContent     = 'Enter a number — e.g. 25 IDs uploaded this hour';
    document.getElementById('final-target').placeholder = 'e.g. 100';
    document.getElementById('task-dur').placeholder   = 'e.g. 25';
  } else {
    document.getElementById('final-target-label').textContent = '⚠ Final Target (MM:SS) — required before clock-out';
    document.getElementById('task-dur-label').textContent    = 'Duration this hour (MM:SS)';
    document.getElementById('dur-hint-text').textContent     = 'Format: MM:SS — e.g. 02:30 = 2 mins 30 secs, 90:00 = 90 minutes';
    document.getElementById('final-target').placeholder = '02:30';
    document.getElementById('task-dur').placeholder   = '02:30';
  }

  // Recalculate progress from task log (no manual input)
  recalcProgressFromTasks();
}

// Required shift: 7.5h enforced, 8h displayed
const REQUIRED_SHIFT_SECS = 7.5 * 3600;   // 27000s — backend enforcement
const DISPLAY_SHIFT_HRS   = 8;             // shown in UI

function loadS() { try { const d=localStorage.getItem(LS); if(d) S={...S,...JSON.parse(d)}; } catch(_){} }
function saveS() { try { localStorage.setItem(LS,JSON.stringify(S)); } catch(_){} }
function loadU() { try { const d=localStorage.getItem('pt_user'); if(d) U=JSON.parse(d); } catch(_){} }
function saveU() { try { localStorage.setItem('pt_user',JSON.stringify(U)); } catch(_){} }
function clearSession() { localStorage.removeItem(LS); localStorage.removeItem('pt_user'); localStorage.removeItem('pt_draft'); }

/* ═══════════════════════════════════════════════════════════
   DURATION UTILS
═══════════════════════════════════════════════════════════ */
function secsToHMS(s) {
  s = Math.max(0, Math.floor(s||0));
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return [h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');
}

function hmsToSecs(str) {
  if (!str) return null;
  // Accept MM:SS (e.g. 02:59) OR HH:MM:SS (e.g. 00:15:00)
  const mmss = str.match(/^(\d{1,2}):(\d{2})$/);
  if (mmss) return +mmss[1]*60 + +mmss[2];
  const hhmmss = str.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hhmmss) return +hhmmss[1]*3600 + +hhmmss[2]*60 + +hhmmss[3];
  return null;
}

function isValidHMS(str) { return hmsToSecs(str) !== null; }

// Format seconds as MM:SS (used for user-facing duration inputs/display)
function secsToMMSS(s) {
  s = Math.max(0, Math.floor(s||0));
  const m = Math.floor(s/60), sec = s%60;
  return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

/* ═══════════════════════════════════════════════════════════
   HOUR SLOTS
═══════════════════════════════════════════════════════════ */
const SHIFT_SLOTS = {
  // Day shift: 8 AM – 5 PM (9 one-hour slots)
  day: [
    '8:00 AM – 9:00 AM',
    '9:00 AM – 10:00 AM',
    '10:00 AM – 11:00 AM',
    '11:00 AM – 12:00 PM',
    '12:00 PM – 1:00 PM',
    '1:00 PM – 2:00 PM',
    '2:00 PM – 3:00 PM',
    '3:00 PM – 4:00 PM',
    '4:00 PM – 5:00 PM',
  ],
  // Night shift: 8:30 PM – 5:30 AM (9 one-hour slots, crosses midnight)
  night: [
    '8:00 PM – 9:00 PM',
    '9:00 PM – 10:00 PM',
    '10:00 PM – 11:00 PM',
    '11:00 PM – 12:00 AM',
    '12:00 AM – 1:00 AM',
    '1:00 AM – 2:00 AM',
    '2:00 AM – 3:00 AM',
    '3:00 AM – 4:00 AM',
    '4:00 AM – 5:00 AM',
  ],
};

function populateSlots() {
  const sel = document.getElementById('hour-slot');
  sel.innerHTML = '<option value="">— select hour slot —</option>';
  const slots = SHIFT_SLOTS[U?.shiftType] || SHIFT_SLOTS.day;
  slots.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    sel.appendChild(o);
  });
}

/* ═══════════════════════════════════════════════════════════
   API CALLS
═══════════════════════════════════════════════════════════ */
async function api(payload) {
  try {
    const r = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // avoid CORS preflight
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch(e) {
    // Offline — queue to localStorage
    queueOffline(payload);
    return { ok: false, offline: true, error: e.message };
  }
}

function queueOffline(payload) {
  try {
    const q = JSON.parse(localStorage.getItem('pt_queue')||'[]');
    q.push({ payload, ts: Date.now() });
    localStorage.setItem('pt_queue', JSON.stringify(q));
  } catch(_){}
}

async function flushOfflineQueue() {
  try {
    const q = JSON.parse(localStorage.getItem('pt_queue')||'[]');
    if (!q.length) return;
    for (const item of q) await api(item.payload);
    localStorage.removeItem('pt_queue');
  } catch(_){}
}

/* ═══════════════════════════════════════════════════════════
   LOGIN
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-login').addEventListener('click', doLogin);
document.getElementById('li-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

async function doLogin() {
  const email = document.getElementById('li-email').value.trim();
  const pass  = document.getElementById('li-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';

  if (!email || !pass) { showLoginErr('Please enter your email and password.'); return; }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const res = await api({ action: 'login', email, password: pass });

  btn.disabled = false;
  btn.textContent = '→ Sign In';

  if (!res.ok) {
    showLoginErr(res.offline
      ? '⚡ No connection to server. Check your network or Apps Script URL in CONFIG.'
      : (res.error || 'Login failed.'));
    const noteEl = document.getElementById('login-note');
    if (noteEl) noteEl.style.display = 'block';
    return;
  }

  U = res.user;
  saveU();
  // Reset daily state for new session
  S = { shiftActive:false, clockInTime:null, onBreak:false, breakStartTime:null, breaks:[], tasks:[], idles:[], idleStart:null, currentDurSecs:0, finalTarget:'', lateMinutes:0, earlyClockOut:false, process:'dhisha', currentCount:0 };
  saveS();
  flushOfflineQueue();
  showDashboard();
}

function showLoginErr(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.style.display = 'block';
}

/* ═══════════════════════════════════════════════════════════
   DASHBOARD INIT
═══════════════════════════════════════════════════════════ */
function showDashboard() {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('dashboard-screen').classList.add('active');

  document.getElementById('top-name').textContent = U.fullName;
  document.getElementById('top-av').textContent   = U.fullName[0].toUpperCase();
  document.getElementById('date-lbl').textContent = new Date().toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});

  populateSlots();
  // Auto-select process from sheet (U.process) on fresh login,
  // otherwise restore from saved state (S.process for session continuity)
  const activeProcess = U.process || S.process || 'dhisha';
  setProcess(activeProcess);
  recalcProgressFromTasks();
  renderUI();
  if (S.shiftActive) {
    showClockInTime(S.clockInTime);
    startShiftTick();
    if(S.onBreak) startBreakTick();
    resetIdle();
    requestNotifPermission();
  }
}

/* ═══════════════════════════════════════════════════════════
   TIMERS
═══════════════════════════════════════════════════════════ */
let shiftTick = null, breakTick = null;
let lastHourlyTs = null;

function startShiftTick() {
  if (shiftTick) clearInterval(shiftTick);
  shiftTick = setInterval(() => {
    if (!S.clockInTime) return;
    const totalElapsed = Date.now() - new Date(S.clockInTime).getTime();
// Total shift duration (raw wall-clock time from clock-in, never stops until clock-out)
const totalShiftEl = document.getElementById('total-shift-display');
if (totalShiftEl) totalShiftEl.textContent = secsToHMS(Math.round(totalElapsed/1000));

    // Segment 2: break total (completed + live current break)
    const brkCompleted = (S.breaks||[]).reduce((a,b)=>a+b.durSecs,0);
    const brkLive = S.onBreak && S.breakStartTime
      ? Math.round((Date.now()-new Date(S.breakStartTime).getTime())/1000) : 0;
    const brkTotal = brkCompleted + brkLive;
    document.getElementById('break-seg-dur').textContent = secsToHMS(brkTotal);
    document.getElementById('break-seg-count').textContent = (S.breaks||[]).length + (S.onBreak ? ' (on break)' : '');

    // Segment 1: NET shift = total elapsed MINUS all break time
    // Shift timer PAUSES during break, resumes when break ends
    // Segment 1: NET shift = total elapsed MINUS break time MINUS idle time
    // Shift timer PAUSES during break AND during idle, resumes when active
    const idleCompleted = (S.idles||[]).reduce((a,b)=>a+b.durSecs,0);
    const idleLive = S.idleStart
      ? Math.round((Date.now()-new Date(S.idleStart).getTime())/1000) : 0;
    const idleTotal2 = idleCompleted + idleLive;
    const netShiftSecs = Math.max(0, Math.round(totalElapsed/1000) - brkTotal - idleTotal2);
    const t = secsToHMS(netShiftSecs);
    document.getElementById('live-clock').textContent = t;
    document.getElementById('big-timer').textContent  = t;

    // Segment 3: idle total (sum of closed idles + current open idle if any)
    let idleTotal = (S.idles||[]).reduce((a,b)=>a+b.durSecs,0);
    if (S.idleStart) idleTotal += Math.round((Date.now()-new Date(S.idleStart).getTime())/1000);
    document.getElementById('idle-seg-dur').textContent = secsToHMS(idleTotal);

    // burnout nudge >5h no break
    const sb = document.getElementById('btn-sb');
    const noBreak = !S.onBreak && (S.breaks||[]).length === 0;
    if (noBreak && totalElapsed > 5*3600*1000) {
      sb.classList.add('burn');
      sb.querySelector('.ico').textContent = '⚠️';
    } else if (!S.onBreak) {
      sb.classList.remove('burn');
      sb.querySelector('.ico').textContent = '☕';
    }

    // hourly badge + night shift browser notification
    const badge = document.getElementById('hourly-badge');
    const since = lastHourlyTs ? Date.now() - lastHourlyTs : totalElapsed;
    if (since >= 3600*1000) {
      badge.innerHTML = '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.28);color:var(--amber);font-size:10px;padding:2px 8px;border-radius:999px;">⏰ Hourly update due</span>';
      triggerHourlyReminder();
    } else {
      badge.innerHTML = '';
    }
  }, 1000);
}

function startBreakTick() {
  if (breakTick) clearInterval(breakTick);
  breakTick = setInterval(() => {
    if (!S.breakStartTime) return;
    const el = (Date.now() - new Date(S.breakStartTime).getTime()) / 1000;
    document.getElementById('bk-timer').textContent = secsToHMS(el);
  }, 1000);
}

function stopBreakTick() {
  clearInterval(breakTick);
  document.getElementById('bk-sep').style.display  = 'none';
  document.getElementById('bk-lbl').style.display  = 'none';
  document.getElementById('bk-timer').style.display = 'none';
}

/* ═══════════════════════════════════════════════════════════
   IDLE DETECTION
   Two modes — auto-detected on clock-in:
   1. EXTENSION MODE: chrome.idle API — true OS-level detection
      Works across ALL tabs, apps, windows
   2. FALLBACK MODE: Tab-level only — used if extension not installed
      Only detects inactivity inside PerformX tab
═══════════════════════════════════════════════════════════ */
let idleTimer       = null;
let extensionActive = false;

// ── Check if extension is installed on clock-in ───────────
function checkExtensionInstalled() {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    extensionActive = false;
    console.log('PerformX: No extension detected, using tab-level idle fallback.');
    startFallbackCountdown();
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        extensionActive = false;
        console.log('PerformX: Extension not responding, using tab-level fallback.');
        startFallbackCountdown();
      } else {
        extensionActive = true;
        console.log('PerformX: Extension connected! Using OS-level idle detection.');
        if (res.isIdle) onIdleStart(res.idleStartTs || new Date().toISOString());
      }
    });
  } catch(_) {
    extensionActive = false;
    startFallbackCountdown();
  }
}

// ── Listen for messages FROM the extension ────────────────
// content.js bridges background→page via window CustomEvent 'performx-ext'
// This works on file:// and http:// pages (chrome.runtime.onMessage does NOT)
window.addEventListener('performx-ext', (e) => {
  const msg = e.detail;
  if (!msg || !msg.type) return;
  extensionActive = true;
  clearTimeout(idleTimer);  // stop fallback timer — extension takes over

  if (msg.type === 'PING') {
    console.log('[PerformX] Extension connected ✓ — global idle tracking active');
  }
  if (msg.type === 'IDLE_START') {
    onIdleStart(msg.idleStartTs || new Date().toISOString());
  }
  if (msg.type === 'IDLE_END' || msg.type === 'ACTIVITY') {
    onIdleEnd();
  }
});

// ── Idle begins ────────────────────────────────────────────
function onIdleStart(idleStartISO) {
  if (!S.shiftActive || S.onBreak) return;
  if (S.idleStart) return;  // already tracking idle
  S.idleStart = idleStartISO;
  saveS();
  document.getElementById('idle-strip').classList.add('show');
}

// ── User active again ──────────────────────────────────────
function onIdleEnd() {
  clearTimeout(idleTimer);
  document.getElementById('idle-strip').classList.remove('show');

  if (S.idleStart) {
    const durSecs = Math.round((Date.now() - new Date(S.idleStart).getTime()) / 1000);
    if (durSecs >= 8) {
      const idleEnd = new Date().toISOString();
      S.idles.push({ start: S.idleStart, end: idleEnd, durSecs });
      saveS();
      api({ action:'logIdle', userId:U.userId, fullName:U.fullName, email:U.email,
            idleStart:S.idleStart, idleEnd, durationSecs:durSecs });
    }
    S.idleStart = null;
    saveS();
  }

  // Restart fallback countdown
  if (!extensionActive) startFallbackCountdown();
}

// ── FALLBACK: countdown timer when extension not installed ─
function startFallbackCountdown() {
  clearTimeout(idleTimer);
  if (!S.shiftActive || S.onBreak || extensionActive) return;
  idleTimer = setTimeout(() => {
    if (!S.shiftActive || S.onBreak || extensionActive) return;
    onIdleStart(new Date().toISOString());
  }, CONFIG.IDLE_MS);
}

// resetIdle alias used by break/clockout handlers
function resetIdle() {
  if (extensionActive) {
    document.getElementById('idle-strip').classList.remove('show');
    return;
  }
  onIdleEnd();
}

// Fallback: mouse/keyboard events inside PerformX tab only
['mousemove','keydown','click','touchstart','scroll'].forEach(e =>
  document.addEventListener(e, () => {
    if (extensionActive) return;  // extension handles it globally
    if (S.idleStart) onIdleEnd();
    else startFallbackCountdown();
  }, { passive: true })
);

// Tab visibility — fallback mode only
document.addEventListener('visibilitychange', () => {
  if (extensionActive) return;
  if (!document.hidden && S.shiftActive && !S.onBreak) {
    startFallbackCountdown();
  }
});

document.getElementById('is-break-btn').addEventListener('click', () => {
  document.getElementById('idle-strip').classList.remove('show');
  clearTimeout(idleTimer);
  document.getElementById('btn-sb').click();
});

document.getElementById('is-dismiss-btn').addEventListener('click', () => {
  resetIdle();
});

/* ═══════════════════════════════════════════════════════════
   CLOCK IN
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-ci').addEventListener('click', async () => {
  const now = new Date().toISOString();
  S.clockInTime  = now;
  S.shiftActive  = true;

  // Late detection — use ShiftStart from sheet, fallback to shiftType defaults
  // Late detection — compare ShiftStart from sheet vs actual clock-in time
  let shiftStartStr = (U.shiftStart || '').trim();
  if (!shiftStartStr) {
    shiftStartStr = (U.shiftType === 'night') ? '8:30 PM' : '8:00 AM';
  }
  const lateM = calcLateMinutes(now, shiftStartStr);
  S.lateMinutes = lateM;   // store BEFORE saveS

  saveS();
  renderUI();
  showClockInTime(now);    // reads S.lateMinutes — must be set first
  startShiftTick();
  resetIdle();
  requestNotifPermission();

  const res = await api({ action:'clockIn', userId:U.userId, fullName:U.fullName, email:U.email, timestamp:now, lateMinutes:lateM, process:S.process });
  if (res.offline) toast('⚡ Offline — clock-in queued for sync.','warn');
  else {
    if (lateM > 0)
      toast('⚠ Clocked in at ' + fmtTime(now) + ' — Late by ' + lateM + ' minute' + (lateM>1?'s':'') + '.', 'warn');
    else
      toast('✅ Clocked in at ' + fmtTime(now) + ', ' + U.fullName + '.', 'ok');
  }
});

/* ═══════════════════════════════════════════════════════════
   START BREAK
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-sb').addEventListener('click', async () => {
  const now = new Date().toISOString();
  S.onBreak        = true;
  S.breakStartTime = now;
  saveS();
  renderUI();
  startBreakTick();
  clearTimeout(idleTimer);
  document.getElementById('idle-strip').classList.remove('show');

  const res = await api({ action:'startBreak', userId:U.userId, fullName:U.fullName, email:U.email, timestamp:now });
  if (res.offline) toast('⚡ Offline — break start queued.','warn');
  else toast(`☕ Break started at ${fmtTime(now)}.`,'info');
});

/* ═══════════════════════════════════════════════════════════
   END BREAK
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-eb').addEventListener('click', async () => {
  if (!S.onBreak) return;
  const now     = new Date().toISOString();
  const durSecs = Math.round((new Date(now) - new Date(S.breakStartTime)) / 1000);
  S.breaks.push({ start: S.breakStartTime, end: now, durSecs });
  S.onBreak        = false;
  S.breakStartTime = null;
  saveS();
  stopBreakTick();
  renderUI();
  resetIdle();

  const res = await api({ action:'endBreak', userId:U.userId, fullName:U.fullName, email:U.email, timestamp:now, breakDurationSecs:durSecs });
  if (res.offline) toast('⚡ Offline — break end queued.','warn');
  else toast(`▶️ Break ended. Duration: ${secsToHMS(durSecs)}.`,'ok');
});

/* ═══════════════════════════════════════════════════════════
   CLOCK OUT
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-co').addEventListener('click', async () => {
  if (S.onBreak) { toast('⚠ End your break before clocking out.','warn'); return; }

  const ft = document.getElementById('final-target').value.trim();
  if (!ft) { openM('m-final'); return; }
  if (!isZomato() && !isValidHMS(ft)) { openM('m-dur'); return; }
  if (isZomato() && (isNaN(parseInt(ft)) || parseInt(ft) < 0)) {
    toast('Final target must be a valid number.','warn'); return;
  }

  S.finalTarget = ft;

  // Recalc from task log before checking compliance
  recalcProgressFromTasks();

  // ── Check compliance: target + shift hours ───────────────
  const shiftSecs   = S.clockInTime ? Math.round((Date.now()-new Date(S.clockInTime).getTime())/1000) : 0;
  const shiftMiss   = shiftSecs < REQUIRED_SHIFT_SECS;

  // Target check — differs by process
  let targetMiss = false;
  let targetRemStr = '';
  if (isZomato()) {
    const dailyTargetNum = parseInt(U?.dailyTargetCount) || parseInt(U?.dailyTargetNum) || parseInt(U?.dailyTarget) || 0;
    targetMiss   = dailyTargetNum > 0 && (S.currentCount||0) < dailyTargetNum;
    targetRemStr = String(dailyTargetNum - (S.currentCount||0)) + ' IDs remaining';
  } else {
    const targetSecs = hmsToSecs(U?.dailyTarget || '0') || 0;
    targetMiss   = targetSecs > 0 && S.currentDurSecs < targetSecs;
    targetRemStr = secsToMMSS(targetSecs - S.currentDurSecs) + ' remaining';
  }

  if (targetMiss || shiftMiss) {
    const reasons = [];
    if (shiftMiss) {
      const remShift = secsToHMS(REQUIRED_SHIFT_SECS - shiftSecs);
      reasons.push('⏱ Shift incomplete — <strong>' + remShift + '</strong> remaining (8 hours required)');
    }
    if (targetMiss) {
      reasons.push('🎯 Daily target not achieved — <strong>' + targetRemStr + '</strong>');
    }

    document.getElementById('tl-check-row').innerHTML =
      '<span class="spin">⟳</span> Checking Team Lead approval…';
    openM('m-tl');
    document.getElementById('tl-modal-msg').innerHTML =
      'Clock-out blocked for the following reason(s):<br><br>' +
      reasons.map(r => '&bull; ' + r).join('<br>');

    const approved = await checkTLApproval();
    updateTLCheckRow(approved, '');
    S.earlyClockOut = true;
    return;
  }

  S.earlyClockOut = false;
  buildSummary();
  openM('m-cout');
});

document.getElementById('btn-confirm-co').addEventListener('click', async () => {
  const now = new Date().toISOString();
  const totalShift = S.clockInTime ? Math.round((new Date(now)-new Date(S.clockInTime))/1000) : 0;
  const totalBreak = S.breaks.reduce((a,b)=>a+b.durSecs,0);
  const totalIdle  = S.idles.reduce((a,b)=>a+b.durSecs,0);

  // Show sending state
  document.getElementById('btn-confirm-co').disabled = true;
  document.getElementById('email-row').innerHTML =
    `<div class="sending-row"><span class="spin">⟳</span> Saving to spreadsheet…</div>`;

  const res = await api({
    action:'clockOut', userId:U.userId, fullName:U.fullName, email:U.email, timestamp:now,
    finalTarget:S.finalTarget, totalShiftSecs:totalShift, totalBreakSecs:totalBreak, totalIdleSecs:totalIdle,
    process:S.process, currentCount:S.currentCount||0
  });

  document.getElementById('email-row').innerHTML =
    `<div class="sending-row"><span class="spin">⟳</span> Sending report to ${U.supervisorEmail}…</div>`;

  await sendEmailReport(now, totalShift, totalBreak, totalIdle);

  document.getElementById('email-row').innerHTML =
    `<div class="sending-row" style="color:var(--green)">✓ Report sent & data saved.</div>`;

  await delay(1100);
  closeM('m-cout');
  performLogout(true);
});

/* ═══════════════════════════════════════════════════════════
   TASK LOG
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-add-task').addEventListener('click', addTask);



async function addTask() {
  const slot = document.getElementById('hour-slot').value;
  const dur  = document.getElementById('task-dur').value.trim();

  if (!slot) { toast('Select an hour slot.','warn'); return; }
  if (!dur)  { toast(isZomato() ? 'Enter a count (e.g. 25).' : 'Enter a duration (MM:SS).','warn'); return; }

  if (isZomato()) {
    const n = parseInt(dur);
    if (isNaN(n) || n < 0) { toast('Enter a valid number (e.g. 25).','warn'); return; }
  } else {
    if (!isValidHMS(dur)) { openM('m-dur'); return; }
  }

  const now = new Date().toISOString();
  const entry = { slot, text: slot, dur: dur, ts: now };
  S.tasks.unshift(entry);
  lastHourlyTs = Date.now();
  saveS();

  document.getElementById('task-dur').value = '';
  try { localStorage.removeItem('pt_draft'); } catch(_){}
  renderTasks();

  const res = await api({ action:'logTask', userId:U.userId, fullName:U.fullName, email:U.email,
    hourSlot:slot, taskText:slot, currentDuration:dur, process:S.process, timestamp:now });
  if (res.offline) toast('⚡ Offline — task queued.','warn');
  else toast('📝 Task logged!','ok');

  // Auto-update progress from task log
  recalcProgressFromTasks();

  // Clear hourly nag — user has logged
  // Clear hourly nag ONLY if user logged for the slot that was nagging
  if (!nagSlot || slot === nagSlot) {
    clearInterval(hourlyReminderInterval);
    document.getElementById('night-reminder').classList.remove('show');
    nagSlot = null;
  }
}
/* ═══════════════════════════════════════════════════════════
   PROGRESS UPDATE
═══════════════════════════════════════════════════════════ */
// Manual update button removed — progress auto-calculated from task log
// btn-upd-prog kept as no-op safety fallback
try { document.getElementById('btn-upd-prog') && document.getElementById('btn-upd-prog').addEventListener('click', () => recalcProgressFromTasks()); } catch(_){}

// recalcProgressFromTasks: auto-sum task log entries for current progress
function recalcProgressFromTasks() {
  const tasks = S.tasks || [];
  if (isZomato()) {
    // Sum all numeric counts from task entries
    let total = 0;
    tasks.forEach(t => {
      const n = parseInt(t.dur);
      if (!isNaN(n) && n > 0) total += n;
    });
    S.currentCount = total;
  } else {
    // Sum all MM:SS durations from task entries
    let totalSecs = 0;
    tasks.forEach(t => {
      const s = hmsToSecs(t.dur);
      if (s) totalSecs += s;
    });
    S.currentDurSecs = totalSecs;
  }
  saveS();
  updateProgress();
}

function updateProgress() {
  if (isZomato()) {
    const dailyTargetNum = parseInt(U?.dailyTargetCount) || parseInt(U?.dailyTargetNum) || parseInt(U?.dailyTarget) || 0;
    const cur = S.currentCount || 0;
    const pct = dailyTargetNum > 0 ? Math.min(100, Math.round(cur/dailyTargetNum*100)) : 0;
    document.getElementById('pbar').style.width = pct+'%';
    document.getElementById('prog-text').textContent = cur + ' / ' + (dailyTargetNum || '—');
    document.getElementById('prog-pct').textContent  = dailyTargetNum ? pct+'%' : '';
    if (pct >= 100) document.getElementById('pbar').style.background = 'linear-gradient(90deg,var(--green),#48cae4)';
  } else {
    const targetSecs = hmsToSecs(U?.dailyTarget || '00:00:00') || 0;
    const cur = S.currentDurSecs || 0;
    const pct = targetSecs > 0 ? Math.min(100, Math.round(cur/targetSecs*100)) : 0;
    document.getElementById('pbar').style.width = pct+'%';
    document.getElementById('prog-text').textContent = secsToMMSS(cur) + ' / ' + (U?.dailyTarget||'—');
    document.getElementById('prog-pct').textContent  = targetSecs ? pct+'%' : '';
    if (pct >= 100) document.getElementById('pbar').style.background = 'linear-gradient(90deg,var(--green),#48cae4)';
  }
}

/* ═══════════════════════════════════════════════════════════
   EMAIL REPORT (EmailJS)
═══════════════════════════════════════════════════════════ */
async function sendEmailReport(clockOutTime, shiftSecs, breakSecs, idleSecs) {
  // Guard: if EmailJS not configured, skip silently
  if (CONFIG.EMAILJS_PUBLIC_KEY === 'YOUR_EMAILJS_PUBLIC_KEY') {
    console.warn('EmailJS not configured — skipping email.');
    return;
  }
  try {
    // v3 SDK: init accepts the public key directly
    emailjs.init(CONFIG.EMAILJS_PUBLIC_KEY);

    const taskLines = S.tasks.map(t =>
      '[' + t.slot + ']' + (t.dur ? ' (' + t.dur + ')' : '') + ' — ' + t.text
    ).join('\n');

    const idleLines = S.idles.map(i =>
      '  ' + fmtTime(i.start) + ' to ' + fmtTime(i.end) + ' (' + secsToHMS(i.durSecs) + ')'
    ).join('\n') || '  None';

    const templateParams = {
      email:          U.supervisorEmail,   // matches {{email}} in EmailJS "To Email" field
      to_name:        'Supervisor',
      from_name:      'PulseTrack',
      employee_name:  U.fullName,
      employee_email: U.email,
      report_date:    new Date().toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'}),
      clock_in:       fmtTime(S.clockInTime),
      clock_out:      fmtTime(clockOutTime),
      shift_duration: secsToHMS(shiftSecs),
      break_duration: secsToHMS(breakSecs),
      idle_duration:  secsToHMS(idleSecs),
      final_target:   S.finalTarget,
      task_log:       taskLines || 'No tasks logged.',
      idle_log:       idleLines,
    };

    // Send to supervisor
    const response = await emailjs.send(
      CONFIG.EMAILJS_SERVICE_ID,
      CONFIG.EMAILJS_TEMPLATE_ID,
      templateParams
    );
    if (response.status !== 200) throw new Error('EmailJS status: ' + response.status);

    // Send copy to employee themselves
    const empParams = Object.assign({}, templateParams, {
      email:   U.email,        // employee's own email
      to_name: U.fullName,
    });
    await emailjs.send(
      CONFIG.EMAILJS_SERVICE_ID,
      CONFIG.EMAILJS_TEMPLATE_ID,
      empParams
    );

  } catch(e) {
    console.error('EmailJS error:', e);
    const msg = e?.text || e?.message || 'Unknown error';
    toast('⚠ Email failed: ' + msg, 'warn');
  }
}

/* ═══════════════════════════════════════════════════════════
   LOGOUT
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-logout').addEventListener('click', () => {
  if (S.shiftActive) { toast('⚠ Please clock out before signing out.','warn'); return; }
  performLogout(false);
});

function performLogout(fromClockOut) {
  clearInterval(shiftTick); clearInterval(breakTick); clearTimeout(idleTimer);
  clearInterval(hourlyReminderInterval);
  clearSession();
  U = null; S = {};
  document.getElementById('dashboard-screen').classList.remove('active');
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('big-timer').textContent = '00:00:00';
  document.getElementById('live-clock').textContent = '00:00:00';
  document.getElementById('login-error').style.display = 'none';
  if (!fromClockOut) toast('👋 Signed out successfully.','info');
}

/* ═══════════════════════════════════════════════════════════
   LATE DETECTION
═══════════════════════════════════════════════════════════ */
function calcLateMinutes(clockInISO, shiftStartStr) {
  // Handles: "8:30 PM", "20:30", "08:00", "8:30 PM to 5:30 AM" (strips after "to")
  try {
    // Strip any " to ..." suffix
    let str = shiftStartStr.split(/\s+to\s+/i)[0].trim();
    const ci = new Date(clockInISO);
    const today = new Date(ci);
    let shiftMs;
    const ampm = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    const h24  = str.match(/^(\d{1,2}):(\d{2})$/);
    if (ampm) {
      let hh = +ampm[1], mm = +ampm[2];
      const p = ampm[3].toUpperCase();
      if (p === 'PM' && hh !== 12) hh += 12;
      if (p === 'AM' && hh === 12) hh = 0;
      today.setHours(hh, mm, 0, 0);
      shiftMs = today.getTime();
    } else if (h24) {
      today.setHours(+h24[1], +h24[2], 0, 0);
      shiftMs = today.getTime();
    } else {
      return 0;
    }
    const diffMs = ci.getTime() - shiftMs;
    if (diffMs <= 0) return 0;
    return Math.floor(diffMs / 60000);
  } catch(_) { return 0; }
}

function showClockInTime(iso) {
  const row = document.getElementById('ci-time-row');
  row.style.display = 'flex';
  document.getElementById('ci-time-display').textContent = fmtTime(iso);
  const badge = document.getElementById('late-badge');
  if (S.lateMinutes > 0) {
    badge.textContent = `Late login by ${S.lateMinutes} minute${S.lateMinutes>1?'s':''}`;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

/* ═══════════════════════════════════════════════════════════
   TL APPROVAL CHECK
═══════════════════════════════════════════════════════════ */
async function checkTLApproval() {
  const res = await api({ action:'checkTLApproval', userId: U.userId });
  return res.ok && res.approved === true;
}

function updateTLCheckRow(approved, remHMS) {
  const row = document.getElementById('tl-check-row');
  if (approved) {
    row.innerHTML = '<span style="color:var(--green)">✓ Team Lead has approved early clock-out.</span>';
    // Show non-compliance modal after a beat
    setTimeout(() => {
      closeM('m-tl');
      openM('m-noncompliance');
    }, 1200);
  } else {
    row.innerHTML = `<span style="color:var(--red)">✗ No approval yet.Please Reach out to your TL</span>`;
  }
}

document.getElementById('btn-tl-recheck').addEventListener('click', async () => {
  document.getElementById('tl-check-row').innerHTML = '<span class="spin">⟳</span> Re-checking…';
  const approved = await checkTLApproval();
  const shiftSecs = S.clockInTime ? Math.round((Date.now()-new Date(S.clockInTime).getTime())/1000) : 0;
  updateTLCheckRow(approved, secsToHMS(REQUIRED_SHIFT_SECS - shiftSecs));
});

document.getElementById('btn-confirm-nc').addEventListener('click', async () => {
  const now = new Date().toISOString();
  const totalShift = S.clockInTime ? Math.round((new Date(now)-new Date(S.clockInTime))/1000) : 0;
  const totalBreak = (S.breaks||[]).reduce((a,b)=>a+b.durSecs,0);
  const totalIdle  = (S.idles||[]).reduce((a,b)=>a+b.durSecs,0);

  document.getElementById('nc-email-row').innerHTML =
    `<div class="sending-row"><span class="spin">⟳</span> Sending non-compliance report…</div>`;
  document.getElementById('btn-confirm-nc').disabled = true;

  await api({
    action:'clockOut', userId:U.userId, fullName:U.fullName, email:U.email, timestamp:now,
    finalTarget:S.finalTarget, totalShiftSecs:totalShift, totalBreakSecs:totalBreak, totalIdleSecs:totalIdle,
    process:S.process, currentCount:S.currentCount||0
  });
  await sendNonComplianceEmail(now, totalShift, totalBreak, totalIdle);

  document.getElementById('nc-email-row').innerHTML =
    `<div class="sending-row" style="color:var(--green)">✓ Report sent.</div>`;
  await delay(900);
  closeM('m-noncompliance');
  performLogout(true);
});

/* ═══════════════════════════════════════════════════════════
   NON-COMPLIANCE EMAIL
═══════════════════════════════════════════════════════════ */
async function sendNonComplianceEmail(clockOutTime, shiftSecs, breakSecs, idleSecs) {
  if (CONFIG.EMAILJS_PUBLIC_KEY === 'YOUR_EMAILJS_PUBLIC_KEY') return;
  try {
    emailjs.init(CONFIG.EMAILJS_PUBLIC_KEY);
    const targetAchieved = isZomato()
      ? (S.currentCount||0) >= (parseInt(U?.dailyTargetCount||U?.dailyTargetNum||U?.dailyTarget)||0)
      : S.currentDurSecs >= (hmsToSecs(U?.dailyTarget||'0')||0);
    const shiftComplete  = shiftSecs >= REQUIRED_SHIFT_SECS;
    const statusLines = [];
    if (!shiftComplete) statusLines.push('❌ Required shift hours not completed (8h required, worked ' + secsToHMS(shiftSecs) + ')');
    if (!targetAchieved) statusLines.push('❌ Daily target not achieved');

    await emailjs.send(CONFIG.EMAILJS_SERVICE_ID, CONFIG.EMAILJS_TEMPLATE_ID, {
      email:           U.supervisorEmail,
      to_name:         'Team Lead',
      from_name:       'PulseTrack',
      employee_name:   U.fullName,
      employee_email:  U.email,
      report_date:     new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'}),
      clock_in:        fmtTime(S.clockInTime),
      clock_out:       fmtTime(clockOutTime),
      shift_duration:  secsToHMS(shiftSecs),
      break_duration:  secsToHMS(breakSecs),
      idle_duration:   secsToHMS(idleSecs),
      final_target:    S.finalTarget,
      task_log:        '[Early clock-out approved by TL]',
      idle_log:        (S.idles||[]).map(i=>'  '+fmtTime(i.start)+' to '+fmtTime(i.end)+'('+secsToHMS(i.durSecs)+')').join('\n')||'None',
      non_compliance:  statusLines.join('\n'),
    });
  } catch(e) {
    console.error('NC email error:', e);
    toast('⚠ NC email failed: '+(e?.text||e?.message||''),'warn');
  }
}

/* ═══════════════════════════════════════════════════════════
   NIGHT SHIFT HOURLY REMINDER + BROWSER NOTIFICATION
═══════════════════════════════════════════════════════════ */
let lastNightReminderTs = null;
let hourlyReminderInterval = null;  // keeps nagging until user logs

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Track which hour slot the reminder was triggered for
let nagSlot = null;

function triggerHourlyReminder() {
  const now = Date.now();
  // Throttle: only fire once per hour window
  if (lastNightReminderTs && (now - lastNightReminderTs) < 55 * 60 * 1000) return;
  lastNightReminderTs = now;

  nagSlot = getCurrentHourSlot();
  const msg = nagSlot
    ? '⏰ Please update your ' + nagSlot + ' hourly task log.'
    : '⏰ Please update your hourly task log.';

  showHourlyNag(msg);

  // Repeat every 2 minutes — ONLY stops when user logs a task for THIS slot
  clearInterval(hourlyReminderInterval);
  hourlyReminderInterval = setInterval(() => {
    // Check if user has logged a task for the CURRENT nag slot
    const tasks = S.tasks || [];
    const loggedThisSlot = tasks.some(t => t.slot === nagSlot);
    if (loggedThisSlot) {
      clearInterval(hourlyReminderInterval);
      document.getElementById('night-reminder').classList.remove('show');
      return;
    }
    // Still not logged — keep nagging
    showHourlyNag(msg);
  }, 2 * 60 * 1000); // every 2 min
}

function showHourlyNag(msg) {
  // In-page banner — stays visible, ✕ only hides visually but nag continues
  const nr = document.getElementById('night-reminder');
  document.getElementById('nr-msg').textContent = msg;
  nr.classList.add('show');

  // Browser notification — fires even when user is in another tab/app
  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      fireNotification(msg);
    } else if (Notification.permission === 'default') {
      // Request permission then fire
      Notification.requestPermission().then(p => {
        if (p === 'granted') fireNotification(msg);
      });
    }
  }
}

function fireNotification(msg) {
  try {
    // Close any existing hourly notification first
    if (window._hourlyNotif) {
      try { window._hourlyNotif.close(); } catch(_) {}
    }
    const n = new Notification('PerformX — Hourly Update Required', {
      body: msg,
      icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22><circle cx=%2216%22 cy=%2216%22 r=%2216%22 fill=%22%230096c7%22/><text x=%2216%22 y=%2221%22 text-anchor=%22middle%22 font-size=%2216%22 fill=%22white%22>P</text></svg>',
      requireInteraction: true,
      tag: 'performx-hourly-' + Date.now(),
      silent: false,
    });
    window._hourlyNotif = n;
    n.onclick = () => {
      window.focus();
      document.getElementById('night-reminder').classList.add('show');
      n.close();
    };
  } catch(_) {}
}

function getCurrentHourSlot() {
  const slots = SHIFT_SLOTS[U?.shiftType] || SHIFT_SLOTS.day;
  const now = new Date();
  const hh = now.getHours(), mm = now.getMinutes();
  // Return the slot whose start hour ≤ now
  return slots.find(s => {
    const m = s.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return false;
    let h = +m[1], mn = +m[2], p = m[3].toUpperCase();
    if (p==='PM' && h!==12) h+=12;
    if (p==='AM' && h===12) h=0;
    return hh===h && mm>=0;
  }) || slots[0];
}

/* ═══════════════════════════════════════════════════════════
   RENDER UI
═══════════════════════════════════════════════════════════ */
function renderUI() {
  const ci=document.getElementById('btn-ci'), sb=document.getElementById('btn-sb'),
        eb=document.getElementById('btn-eb'), co=document.getElementById('btn-co'),
        at=document.getElementById('btn-add-task'),
        hs=document.getElementById('hour-slot'), td=document.getElementById('task-dur'),
        dot=document.getElementById('sdot'), st=document.getElementById('stext');

  if (!S.shiftActive) {
    ci.disabled=false; sb.disabled=true; eb.disabled=true; co.disabled=true;
    at.disabled=true; hs.disabled=true; td.disabled=true;
    dot.className='sdot off'; st.textContent='Not clocked in';
    sb.classList.remove('brk','burn'); ci.classList.remove('on');
  } else if (S.onBreak) {
    ci.disabled=true; sb.disabled=true; eb.disabled=false; co.disabled=true;
    at.disabled=true; hs.disabled=true; td.disabled=true;
    dot.className='sdot break'; st.textContent='On Break';
    sb.classList.add('brk');
    document.getElementById('bk-sep').style.display='';
    document.getElementById('bk-lbl').style.display='';
    document.getElementById('bk-timer').style.display='';
  } else {
    ci.disabled=true; sb.disabled=false; eb.disabled=true; co.disabled=false;
    at.disabled=false; hs.disabled=false; td.disabled=false;
    dot.className='sdot active'; st.textContent='Clocked In';
    sb.classList.remove('brk'); ci.classList.add('on');
  }

  // break totals
  const brkTotal = S.breaks ? S.breaks.reduce((a,b)=>a+b.durSecs,0) : 0;
  document.getElementById('break-total').textContent =
    `${S.breaks?.length||0} (${secsToHMS(brkTotal)})`;

  updateProgress();
  renderTasks();


}

function renderTasks() {
  const list = document.getElementById('task-list');
  const hint = document.getElementById('last-log-hint');
  const tasks = S.tasks || [];
  if (!tasks.length) {
    list.innerHTML = '<div class="task-empty">🕐 Clock in to start<br>logging your progress.</div>';
    hint.textContent = 'No entries yet';
    return;
  }
  list.innerHTML = tasks.map(t => `
    <div class="tentry">
      <div class="tentry-meta">
        <span>⏱ ${t.slot||'—'}</span>
        ${t.dur?`<span>⏳ ${t.dur}</span>`:''}
        <span style="color:var(--muted)">${fmtTime(t.ts)}</span>
      </div>
      <div class="tentry-text">${escH(t.text)}</div>
    </div>`).join('');
  const last = new Date(tasks[0].ts);
  hint.textContent = `Last: ${last.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`;
}

function buildSummary() {
  const box = document.getElementById('sum-preview');
  if (!S.tasks?.length) { box.style.display='none'; return; }
  box.style.display='block';
  box.innerHTML = S.tasks.map(t =>
    `<div class="sumrow"><span class="sumtime">${t.slot}</span><span>${escH(t.text)}</span></div>`
  ).join('');
}

/* ═══════════════════════════════════════════════════════════
   MODAL HELPERS
═══════════════════════════════════════════════════════════ */
function openM(id)  { document.getElementById(id).classList.add('open'); }
function closeM(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.overlay').forEach(o =>
  o.addEventListener('click', e => { if(e.target===o) o.classList.remove('open'); })
);

/* ═══════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════ */
function toast(msg, type='info') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg;
  c.appendChild(t);
  setTimeout(()=>t.remove(), 3500);
}

/* ═══════════════════════════════════════════════════════════
   UTILS
═══════════════════════════════════════════════════════════ */
function escH(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function delay(ms) { return new Promise(r=>setTimeout(r,ms)); }

/* ═══════════════════════════════════════════════════════════
   SHOW / HIDE PASSWORD
   → btn-show-pass toggles li-pass type on login page
   → togglePassField() used inside forgot-password modal
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-show-pass').addEventListener('click', () => {
  const inp  = document.getElementById('li-pass');
  const icon = document.getElementById('eye-icon');
  const isPass = inp.type === 'password';
  inp.type = isPass ? 'text' : 'password';
  icon.textContent = isPass ? '🔓' : '🔐';
});

function togglePassField(inputId, btn) {
  const inp  = document.getElementById(inputId);
  const icon = btn.querySelector('span');
  const isPass = inp.type === 'password';
  inp.type = isPass ? 'text' : 'password';
  icon.textContent = isPass ? '🔓' : '🔐';
}

/* ═══════════════════════════════════════════════════════════
   FORGOT PASSWORD FLOW
   Step 1 → validate email in sheet → generate OTP → send via EmailJS
   Step 2 → verify OTP → POST new password → Apps Script updates sheet
═══════════════════════════════════════════════════════════ */
let fp_otp = null, fp_otpExpiry = null, fp_userEmail = null;

document.getElementById('btn-fp-send').addEventListener('click', () => {
  if (document.getElementById('fp-step2').style.display === 'none') {
    forgotStep1();
  } else {
    forgotStep2();
  }
});

function closeForgot() {
  closeM('m-forgot');
  ['fp-email','fp-otp-input','fp-newpass','fp-confirmpass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.disabled = false; }
  });
  document.getElementById('fp-step2').style.display = 'none';
  document.getElementById('fp-status').innerHTML = '';
  document.getElementById('btn-fp-send').textContent = 'Send OTP';
  fp_otp = null; fp_otpExpiry = null; fp_userEmail = null;
}

async function forgotStep1() {
  const email    = document.getElementById('fp-email').value.trim();
  const statusEl = document.getElementById('fp-status');
  const btn      = document.getElementById('btn-fp-send');

  if (!email) { statusEl.innerHTML = '<span style="color:var(--red)">Please enter your email address.</span>'; return; }

  statusEl.innerHTML = '<span class="spin">⟳</span> Checking email…';
  btn.disabled = true;

  const res = await api({ action: 'checkEmail', email });
  btn.disabled = false;

  if (!res.ok || !res.exists) {
    statusEl.innerHTML = '<span style="color:var(--red)">❌ No account found with that email. Contact your admin.</span>';
    return;
  }

  // Generate 6-digit OTP
  fp_otp       = String(Math.floor(100000 + Math.random() * 900000));
  fp_otpExpiry = Date.now() + 5 * 60 * 1000;
  fp_userEmail = email;

  const sent = await sendOTPEmail(email, res.fullName || email, fp_otp);
  if (!sent) {
    statusEl.innerHTML = '<span style="color:var(--red)">❌ Failed to send OTP. Check EmailJS config.</span>';
    return;
  }

  document.getElementById('fp-email').disabled = true;
  document.getElementById('fp-step2').style.display = 'block';
  document.getElementById('btn-fp-send').textContent = 'Reset Password';
  statusEl.innerHTML = '<span style="color:var(--green)">✅ OTP sent to ' + email + ' — valid for 5 minutes.</span>';
}

async function forgotStep2() {
  const otp     = document.getElementById('fp-otp-input').value.trim();
  const newPass = document.getElementById('fp-newpass').value;
  const confPas = document.getElementById('fp-confirmpass').value;
  const statusEl = document.getElementById('fp-status');
  const btn     = document.getElementById('btn-fp-send');

  if (!otp)              { statusEl.innerHTML = '<span style="color:var(--red)">Enter the OTP.</span>'; return; }
  if (otp !== fp_otp)    { statusEl.innerHTML = '<span style="color:var(--red)">❌ Incorrect OTP.</span>'; return; }
  if (Date.now() > fp_otpExpiry) { statusEl.innerHTML = '<span style="color:var(--red)">❌ OTP expired. Start again.</span>'; closeForgot(); return; }
  if (!newPass)          { statusEl.innerHTML = '<span style="color:var(--red)">Enter a new password.</span>'; return; }
  if (newPass.length < 6){ statusEl.innerHTML = '<span style="color:var(--red)">Password must be at least 6 characters.</span>'; return; }
  if (newPass !== confPas){ statusEl.innerHTML = '<span style="color:var(--red)">Passwords do not match.</span>'; return; }

  statusEl.innerHTML = '<span class="spin">⟳</span> Updating password…';
  btn.disabled = true;

  const res = await api({ action: 'resetPassword', email: fp_userEmail, newPassword: newPass });
  btn.disabled = false;

  if (!res.ok) {
    statusEl.innerHTML = '<span style="color:var(--red)">❌ ' + (res.error || 'Update failed.') + '</span>';
    return;
  }

  statusEl.innerHTML = '<span style="color:var(--green)">✅ Password updated! You can now sign in.</span>';
  setTimeout(() => closeForgot(), 2000);
}

async function sendOTPEmail(email, name, otp) {
  // Dev mode — if EmailJS keys not set, show OTP in toast for testing
  if (CONFIG.EMAILJS_PUBLIC_KEY === 'YOUR_EMAILJS_PUBLIC_KEY') {
    console.log('DEV MODE OTP for', email, ':', otp);
    toast('DEV MODE — OTP: ' + otp + ' (check console)', 'info');
    return true;
  }

  // Must have a separate OTP template configured
  if (!CONFIG.EMAILJS_OTP_TEMPLATE_ID ||
       CONFIG.EMAILJS_OTP_TEMPLATE_ID === 'YOUR_EMAILJS_OTP_TEMPLATE_ID') {
    // Fallback: show OTP in a visible alert so user can still reset
    const shown = prompt(
      'EMAIL NOT CONFIGURED\n\n' +
      'Your OTP is: ' + otp + '\n\n' +
      'Please set EMAILJS_OTP_TEMPLATE_ID in CONFIG.\n' +
      'Copy the OTP above and click OK to continue.'
    );
    return true; // allow flow to continue
  }

  try {
    emailjs.init(CONFIG.EMAILJS_PUBLIC_KEY);
    // Send ONLY otp-specific variables — never mix with shift report variables
    const r = await emailjs.send(
      CONFIG.EMAILJS_SERVICE_ID,
      CONFIG.EMAILJS_OTP_TEMPLATE_ID,
      {
        email:      email,       // {{email}} → To Email in EmailJS OTP template
        to_name:    name,        // {{to_name}}
        from_name:  'PerformX',  // {{from_name}}
        otp_code:   otp,         // {{otp_code}}
        expiry_min: '5',         // {{expiry_min}}
      }
    );
    return r.status === 200;
  } catch(e) {
    console.error('OTP email error:', e);
    // Fallback to prompt so user can still reset even if email fails
    const shown = prompt(
      'OTP email failed. Your OTP is: ' + otp +
      '\nCopy it and click OK to continue.'
    );
    return true;
  }
}

/* ═══════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════ */
loadU();
loadS();

if (U && U.userId) {
  showDashboard();
} else {
  document.getElementById('login-screen').classList.add('active');
}
