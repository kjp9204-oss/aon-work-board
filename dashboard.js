(() => {
  'use strict';
  const $ = id => document.getElementById(id);

  const config = window.AON_CONFIG || {};
  function appsScriptEndpoint(value) {
    return typeof value === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value.trim());
  }
  const appsScriptUrl = typeof config.appsScriptUrl === 'string' ? config.appsScriptUrl.trim() : '';
  const tokensConfigured = appsScriptEndpoint(appsScriptUrl)
    && typeof config.googleClientId === 'string'
    && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.googleClientId.trim());
  let credential = '', expiresAt = 0, expiryTimer, authVersion = 0, googleId;
  const STATUSES = ['접수', '진행 중', '확인 대기', '보류', '완료'];
  const CATEGORIES = ['운영·시설', '직원·교육', '회의·행사', '블로그·홍보'];
  let tasks = [], events = [], user = null, guest = false;
  let posSummaries = [], posState = 'idle', posEdit = null, notices = [], noticeState = 'idle', noticeEdit = null;
  let loaded = false, loading = false, saving = false, page = 'overview', quickFilter = '', mine = false;
  let taskEdit = null, eventEdit = null, toastTimer;
  // NEW marks anything created or changed since this browser's previous visit (first visit: last 3 days).
  const PREV_VISIT = (() => {
    const fallback = Date.now() - 3 * 24 * 60 * 60 * 1000;
    try {
      const stored = Number(localStorage.getItem('aon-last-visit'));
      localStorage.setItem('aon-last-visit', String(Date.now()));
      return Number.isFinite(stored) && stored > 0 ? stored : fallback;
    } catch { return fallback; }
  })();
  const isNew = item => Date.parse(item?.updatedAt || '') > PREV_VISIT;
  const newBadge = () => { const b = document.createElement('span'); b.className = 'new-badge'; b.textContent = 'NEW'; return b; };
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const isDialogOpen = () => $('taskDialog').open || $('eventDialog').open || $('posDialog').open || $('noticeDialog').open;
  function todayISO() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = type => parts.find(p => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  function offsetDate(date, days) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
  function weekDates(today) { const day = new Date(`${today}T00:00:00Z`).getUTCDay(); const start = offsetDate(today, -((day + 6) % 7)); return Array.from({ length: 7 }, (_, i) => offsetDate(start, i)); }
  function dateText(date, long = false) { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', ...(long ? { year: 'numeric' } : {}), month: 'long', day: 'numeric', ...(long ? { weekday: 'long' } : {}) }).format(new Date(`${date}T00:00:00Z`)); }
  function timeText(date) { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date); }
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
  function setStatus(text, state = '') { $('serverStatus').textContent = text; $('serverStatus').dataset.state = state; }
  function errorText(error) {
    if (error.status === 401) return 'Google 로그인이 필요합니다. 작성 중인 내용은 이 창에 남아 있습니다.';
    if (error.status === 403) return '허용 계정이 아닙니다. 등록된 Google 계정으로 다시 로그인해 주세요.';
    if (error.name === 'AbortError') return '시트 응답이 늦어 완료 여부를 확인하지 못했습니다. 입력은 이 창에 남아 있습니다.';
    return error.message || '시트에 연결하지 못했습니다. 인터넷 연결과 배포 설정을 확인해 주세요.';
  }
  function requestError(status, message, code) {
    return Object.assign(new Error(message), { status, code });
  }
  function authError(error) { return error.status === 401 || error.status === 403; }
  function discardDraft() {
    for (const kind of ['task', 'event']) {
      const dialog = $(kind + 'Dialog');
      if (dialog.open) dialog.close();
      $(kind + 'Form').reset();
    }
    taskEdit = null;
    eventEdit = null;
    for (const kind of ['pos', 'notice']) { if ($(kind + 'Dialog').open) $(kind + 'Dialog').close(); $(kind + 'Form').reset(); }
    posEdit = null;
    noticeEdit = null;
  }
  function clearSession({ guestUntil = 0 } = {}) {
    authVersion += 1;
    clearTimeout(expiryTimer);
    credential = '';
    guest = guestUntil > Date.now();
    expiresAt = guest ? guestUntil : 0;
    if (guest) expiryTimer = setTimeout(expireSession, expiresAt - Date.now());
    user = null;
    tasks = [];
    events = [];
    posSummaries = [];
    posState = 'idle';
    notices = [];
    noticeState = 'idle';
    loaded = false;
    resetFilters();
    $('accountName').textContent = guest ? '게스트' : 'Google 로그인 필요';
    $('lastUpdated').textContent = guest ? '센터 운영 데이터는 허용된 팀 계정에만 표시됩니다.' : 'Google 로그인 후 시트 내용을 불러옵니다.';
    renderOwners();
    render();
  }
  function enterGuest(exp) {
    discardDraft();
    clearSession({ guestUntil: exp });
    clearConnectionError();
    setStatus('게스트 · 공개 화면');
    updateControls();
  }
  function showConnectionError(error) {
    if (user && expiresAt > Date.now() && error.status === 403
        && ['ACCOUNT_NOT_ALLOWED', 'GOOGLE_EMAIL_REQUIRED'].includes(error.code)) {
      enterGuest(expiresAt);
      return;
    }
    if (authError(error)) clearSession();
    setStatus(authError(error) ? '로그인 필요' : '연결 오류', 'error');
    $('connectionMessage').textContent = errorText(error);
    $('connectionError').hidden = false;
    $('signInLink').hidden = !authError(error);
    for (const kind of ['task', 'event']) {
      const panel = $(kind + 'AuthRecovery');
      panel.hidden = !authError(error) || !$(kind + 'Dialog').open;
      if (!panel.hidden) renderRecoveryButton(kind);
    }
    updateControls();
  }
  function clearConnectionError() {
    $('connectionError').hidden = true;
    $('signInLink').hidden = true;
    $('taskAuthRecovery').hidden = true;
    $('eventAuthRecovery').hidden = true;
  }
  function updateControls() {
    const disabled = !user || !loaded || loading || saving;
    $('addTask').disabled = disabled;
    $('addEvent').disabled = disabled;
    $('downloadBackup').disabled = disabled;
    $('refreshData').disabled = disabled;
    $('saveTask').disabled = disabled;
    $('saveEvent').disabled = disabled;
    $('addPos').disabled = disabled || posState !== 'ready';
    $('savePos').disabled = disabled;
    $('addNotice').disabled = disabled || noticeState !== 'ready';
    $('addNoticePage').disabled = disabled || noticeState !== 'ready';
    $('saveNotice').disabled = disabled;
    $('logout').hidden = !user && !guest;
    $('logout').disabled = loading || saving;
    $('googleSignIn').hidden = Boolean(user || guest);
    document.querySelectorAll('#taskForm input, #taskForm select, #taskForm textarea, #eventForm input, #posForm input, #posForm textarea, #noticeForm input, #noticeForm textarea, #noticeForm select').forEach(input => { input.disabled = saving; });
    for (const id of ['closeDialog', 'cancelDialog', 'closeEventDialog', 'cancelEventDialog', 'reloadTask', 'reloadEvent', 'taskResumeSession', 'eventResumeSession']) $(id).disabled = saving || loading;
  }
  async function api(action, data = {}, token = credential) {
    if (!tokensConfigured) throw requestError(0, 'Google 로그인과 Apps Script 배포 주소를 설정해 주세요.');
    if (!token) throw requestError(401, 'Google 로그인이 필요합니다.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      // ContentService follows a Google-hosted redirect. Keep the request CORS-simple
      // and send the credential in the POST body, never in either URL.
      const response = await fetch(appsScriptUrl, {
        method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'follow',
        referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ token, action, data }), signal: controller.signal,
      });
      if (!response.ok) throw requestError(response.status, '시트 요청을 완료하지 못했습니다.');
      const body = await response.json().catch(() => null);
      if (body?.ok === false) {
        throw requestError(Number.isInteger(body.status) ? body.status : 0,
          typeof body.error?.message === 'string' ? body.error.message : '시트 요청을 완료하지 못했습니다.', body.error?.code);
      }
      if (body?.ok !== true || body.storage !== 'sheet') {
        throw requestError(0, '시트 응답 형식을 확인하지 못했습니다. 웹앱 배포 설정을 확인해 주세요.');
      }
      return body;
    } catch (error) {
      if (error instanceof TypeError) throw requestError(0, '시트에 연결하지 못했습니다. 인터넷 연결과 웹앱 배포 설정을 확인해 주세요.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  // The reservation summary is optional: an older Apps Script deployment without it
  // must not stop tasks and events from loading.
  async function readOptional(action, key, token) {
    try {
      const data = await api(action, {}, token);
      return { list: Array.isArray(data[key]) ? data[key] : [], state: 'ready' };
    } catch (error) {
      if (authError(error)) throw error;
      return { list: [], state: error.code === 'UNKNOWN_ACTION' ? 'not-deployed' : 'error' };
    }
  }
  async function readBoard(token = credential) {
    const [taskData, eventData, pos, notice] = await Promise.all([api('listTasks', {}, token), api('listEvents', {}, token), readOptional('listPos', 'posSummaries', token), readOptional('listNotices', 'notices', token)]);
    if (!Array.isArray(taskData.tasks) || !Array.isArray(eventData.events)) throw new Error('업무·일정 응답을 확인하지 못했습니다.');
    return { tasks: taskData.tasks, events: eventData.events, pos, notice };
  }
  function displayBoard(board) {
    tasks = board.tasks;
    events = board.events;
    posSummaries = board.pos.list;
    posState = board.pos.state;
    notices = board.notice.list;
    noticeState = board.notice.state;
    loaded = true;
    clearConnectionError();
    setStatus('시트 저장');
    $('lastUpdated').textContent = `${timeText(new Date())}에 시트 내용 확인 · 한국 시간`;
    renderOwners();
    render();
    setTimeout(openPending, 0); // after the login/refresh call has finished loading
  }
  function expireSession() {
    if ((!credential && !guest) || Date.now() < expiresAt) return false;
    showConnectionError(requestError(401, 'Google 로그인 시간이 만료되었습니다.'));
    return true;
  }
  async function refresh({ silent = false } = {}) {
    if (expireSession() || !user || loading || saving) return;
    if (isDialogOpen()) { if (!silent) toast('작성 중인 내용을 저장하거나 창을 닫은 뒤 새로고침해 주세요.'); return; }
    const version = authVersion;
    loading = true;
    updateControls();
    if (!silent) setStatus('시트에서 불러오는 중');
    try {
      const board = await readBoard();
      if (version === authVersion && !expireSession()) displayBoard(board);
    } catch (error) {
      if (version === authVersion) showConnectionError(error);
    } finally { loading = false; updateControls(); }
  }
  function credentialExpiry(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const exp = JSON.parse(atob(part)).exp;
      return Number.isSafeInteger(exp) ? exp * 1000 : 0;
    } catch { return 0; }
  }
  async function onGoogleCredential(response) {
    const token = response.credential;
    if (loading || saving || user || guest || typeof token !== 'string' || token.length > 10000) return;
    loading = true;
    updateControls();
    setStatus('로그인 확인 중');
    try {
      // The API verifies the credential before this UI accepts any account details.
      const session = await api('session', {}, token);
      // Use the JWT expiry only to clear the local UI; the server enforces it separately.
      const exp = credentialExpiry(token);
      if (exp <= Date.now() || exp > Date.now() + 24 * 60 * 60 * 1000) throw requestError(401, 'Google 로그인 시간이 만료되었습니다.');
      if (session.access === 'guest') {
        enterGuest(exp);
        return;
      }
      if ((session.access !== undefined && session.access !== 'member') || !session.user || typeof session.user.id !== 'string' || !session.user.id) {
        throw requestError(0, 'Google 계정 응답을 확인하지 못했습니다.');
      }
      const board = await readBoard(token);
      if (exp <= Date.now()) throw requestError(401, 'Google 로그인 시간이 만료되었습니다.');
      const editor = $('taskDialog').open ? taskEdit?.principal : eventEdit?.principal;
      if (isDialogOpen() && editor && editor !== session.user.id) {
        discardDraft();
        toast('로그인 계정이 바뀌어 이전 계정의 작성 창을 닫았습니다.');
      }
      user = session.user;
      credential = token;
      authVersion += 1;
      expiresAt = exp;
      expiryTimer = setTimeout(expireSession, exp - Date.now());
      $('accountName').textContent = user.displayName || 'Google 연결됨';
      displayBoard(board);
      if (isDialogOpen()) {
        $($('taskDialog').open ? 'formError' : 'eventFormError').textContent = '';
        toast('로그인을 확인했습니다. 작성한 내용을 저장할 수 있습니다.');
      }
    } catch (error) {
      if (isDialogOpen()) $($('taskDialog').open ? 'formError' : 'eventFormError').textContent = errorText(error);
      showConnectionError(error);
    } finally { loading = false; updateControls(); }
  }
  function mountGoogleButton(container) {
    if (!googleId) return;
    googleId.renderButton(container, { theme: 'outline', type: 'standard', size: 'medium', text: 'signin_with', locale: 'ko' });
  }
  function renderRecoveryButton(kind) {
    if (!googleId) return;
    const recovery = $(kind + 'AuthRecovery');
    let container = recovery.querySelector('.google-recovery-button');
    if (!container) {
      container = node('div', 'google-recovery-button');
      recovery.append(container);
      mountGoogleButton(container);
    }
    $(kind + 'ResumeSession').hidden = true;
  }
  function focusGoogleSignIn() {
    const button = $('googleSignIn').querySelector('iframe, button');
    if (button) { button.focus(); return; }
    toast('Google 로그인 버튼이 로드되면 선택해 주세요.');
  }
  function initializeLogin() {
    const intake = $('intakeLink');
    if (intake && appsScriptEndpoint(config.intakeUrl)) {
      intake.href = config.intakeUrl.trim();
      intake.hidden = false;
    }
    if (!tokensConfigured) {
      $('googleSignIn').textContent = 'Google 로그인 설정 대기';
      $('accountName').textContent = '연결 설정 대기';
      $('lastUpdated').textContent = 'Google 로그인과 시트 웹앱 연결 후 실제 업무가 표시됩니다.';
      setStatus('시트 연결 설정 대기');
      return;
    }
    setStatus('Google 로그인 필요');
    $('accountName').textContent = 'Google 로그인 필요';
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onerror = () => showConnectionError(new Error('Google 로그인 버튼을 불러오지 못했습니다. 페이지를 새로고침해 주세요.'));
    script.onload = () => {
      googleId = window.google?.accounts?.id;
      if (!googleId) return script.onerror();
      googleId.initialize({ client_id: config.googleClientId.trim(), callback: onGoogleCredential, auto_select: false });
      mountGoogleButton($('googleSignIn'));
    };
    document.head.append(script);
  }
  function logout() {
    if (saving || loading) return;
    googleId?.disableAutoSelect();
    discardDraft();
    clearSession();
    clearConnectionError();
    setStatus('Google 로그인 필요');
    updateControls();
  }
  function active(task) { return task.status !== '완료' && task.status !== '보류'; }
  function badgeClass(status) { return ({ '진행 중': 'progress', '확인 대기': 'waiting', '완료': 'done', '보류': 'hold' })[status] || ''; }
  function resetFilters() { mine = false; quickFilter = ''; $('searchTasks').value = ''; $('ownerFilter').value = ''; $('statusFilter').value = ''; }
  function renderOwners() {
    const chosen = $('ownerFilter').value;
    const taskOwners = [...new Set(tasks.map(t => t.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    $('ownerFilter').replaceChildren(new Option('모든 담당자', ''));
    for (const owner of taskOwners) $('ownerFilter').add(new Option(owner, owner));
    if (taskOwners.includes(chosen)) $('ownerFilter').value = chosen;
    const suggestions = [...new Set([...taskOwners, ...events.map(e => e.owner), user?.displayName].filter(Boolean))];
    $('ownerSuggestions').replaceChildren(...suggestions.map(owner => new Option(owner, owner)));
  }
  function render() {
    const today = todayISO(), dates = weekDates(today);
    $('todayLabel').textContent = dateText(today, true);
    $('weekLabel').textContent = `${dateText(dates[0])} — ${dateText(dates[6])}`;
    $('calendarRange').textContent = `${dateText(dates[0], true)} — ${dateText(dates[6], true)}`;
    if (loaded) {
      $('todayCount').textContent = tasks.filter(t => active(t) && t.due === today).length;
      $('overdueCount').textContent = tasks.filter(t => active(t) && t.due && t.due < today).length;
      $('waitingCount').textContent = tasks.filter(t => t.status === '확인 대기').length;
      $('weekCount').textContent = events.filter(e => dates.includes(e.date)).length;
    } else {
      for (const id of ['todayCount', 'overdueCount', 'waitingCount', 'weekCount', 'taskCount']) $(id).textContent = '—';
    }
    const query = $('searchTasks').value.trim().toLowerCase(), owner = $('ownerFilter').value, status = $('statusFilter').value;
    // Finished tasks stay in the sheet but leave the working list; choose ‘완료’ in the status filter to see them.
    const visible = tasks.filter(t => (status === '완료' || t.status !== '완료') && (!mine || t.createdBy === user?.id) && (!owner || t.owner === owner) && (!status || t.status === status) && (!query || `${t.title} ${t.next} ${t.category} ${t.owner}`.toLowerCase().includes(query)) && (!quickFilter || (quickFilter === 'today' && active(t) && t.due === today) || (quickFilter === 'overdue' && active(t) && t.due && t.due < today) || (quickFilter === 'waiting' && t.status === '확인 대기')));
    if (loaded) $('taskCount').textContent = visible.length;
    $('taskRows').replaceChildren();
    visible.forEach(task => {
      const tr = node('tr', isNew(task) ? 'is-new' : ''), main = node('td', 'task-main'), meta = node('div', 'task-meta');
      if (isNew(task)) meta.append(newBadge());
      meta.append(node('span', 'category-label', task.category));
      const title = node('button', 'task-title', task.title); title.type = 'button'; title.addEventListener('click', () => openTask(task.id));
      main.append(meta, title, node('p', 'task-next', task.next || '다음 행동을 정해 주세요.'));
      const overdue = active(task) && task.due && task.due < today;
      const due = node('td', `date-cell${overdue ? ' overdue' : ''}`, task.due ? `${task.due.slice(5).replace('-', '. ')}${overdue ? ' · 지남' : ''}` : '미정');
      const statusCell = node('td'); statusCell.append(node('span', `pill ${badgeClass(task.status)}`, task.status));
      tr.append(main, node('td', 'owner-cell', task.owner), due, statusCell); $('taskRows').append(tr);
    });
    $('emptyTasks').textContent = !loaded ? privateViewMessage('업무 목록') : tasks.some(t => t.status !== '완료') || status === '완료' ? '조건에 맞는 업무가 없습니다.' : tasks.length ? '진행 중인 업무가 없습니다. 끝난 업무는 상태에서 ‘완료’를 고르면 보입니다.' : '등록된 업무가 없습니다. ‘업무 등록’으로 첫 업무를 추가하세요.';
    $('emptyTasks').hidden = visible.length !== 0;
    $('allTasks').classList.toggle('selected', !mine); $('myTasks').classList.toggle('selected', mine);
    $('allTasks').setAttribute('aria-pressed', String(!mine)); $('myTasks').setAttribute('aria-pressed', String(mine));
    $('filterDescription').textContent = ({ today: '오늘 마감 · 미완료', overdue: '마감 지난 업무', waiting: '확인 대기' })[quickFilter] || (mine ? '내가 등록한 업무' : '전체 업무');
    const doneCount = tasks.filter(t => t.status === '완료').length;
    if (loaded && doneCount && status !== '완료') $('filterDescription').textContent += ` · 완료 ${doneCount}건 숨김`;
    $('overviewLayout').hidden = ['calendar', 'ai', 'notice'].includes(page); $('noticePage').hidden = page !== 'notice'; $('boardRow').hidden = page !== 'overview'; $('calendarView').hidden = page !== 'calendar'; $('ai-dashboard').hidden = page !== 'ai';
    $('overviewLayout').classList.toggle('tasks-only', page === 'tasks');
    document.querySelectorAll('[data-page]').forEach(button => { const selected = button.dataset.page === page; button.classList.toggle('active', selected); if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    const title = ({ overview: '오늘의 센터', tasks: '업무', calendar: '센터 일정', ai: 'AI 대시보드', notice: '공지사항' })[page];
    $('pageTitle').textContent = title; $('breadcrumbCurrent').textContent = title;
    $('pageDescription').textContent = ({ overview: '오늘 할 일과 센터 일정, 다음 행동을 확인하세요.', tasks: '담당자와 마감, 다음 행동을 한곳에서 확인하세요.', calendar: '회의와 교육 일정을 미리 확인하고 준비하세요.', ai: 'Claude·ChatGPT·Codex 사이의 작업 흐름입니다.', notice: '센터 팀원에게 알릴 내용을 쓰고 고칩니다.' })[page];
    renderEvents(today, dates);
    renderPos(dates[0]);
    renderNotices();
    renderChangeSummary();
  }
  function renderChangeSummary() {
    const count = loaded ? [...tasks.filter(t => t.status !== '완료'), ...events, ...notices.filter(n => n.status === '게시'), ...posSummaries.slice(0, 1)].filter(isNew).length : 0;
    $('changeSummary').hidden = !count;
    $('changeSummary').textContent = `지난 방문 이후 새로 바뀐 것 ${count}개`;
  }
  function privateViewMessage(label) {
    return guest ? `${label}: 허용된 팀 계정에만 표시됩니다.` : `${label}: 허용된 Google 계정으로 로그인해 주세요.`;
  }
  function noticeAge(date) { return Math.round((Date.parse(todayISO()) - Date.parse(date)) / 86400000); }
  const isFresh = item => item.status === '게시' && noticeAge(item.date) < 7;
  function noticeDateLabel(date) {
    const day = ['일', '월', '화', '수', '목', '금', '토'][new Date(`${date}T00:00:00Z`).getUTCDay()];
    return `${date.slice(5).replace('-', '.')} (${day})`;
  }
  function noticeState_() {
    if (!loaded) return privateViewMessage('공지');
    if (noticeState === 'not-deployed') return '공지 저장이 아직 켜지지 않았습니다. 시트 웹앱(Apps Script)을 새 버전으로 배포하면 바로 쓸 수 있습니다.';
    if (noticeState === 'error') return '공지를 불러오지 못했습니다. 새로고침해 주세요.';
    return '';
  }
  function renderNotices() {
    const posted = notices.filter(item => item.status === '게시').sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
    const down = notices.filter(item => item.status !== '게시').sort((a, b) => b.date.localeCompare(a.date));
    // Chalkboard on 오늘의 센터: newest posted notices, short.
    const board = $('noticeList'); board.replaceChildren();
    const problem = noticeState_();
    if (problem) board.append(node('p', noticeState === 'ready' || !loaded ? '' : 'pos-warn', problem));
    else if (!posted.length) board.append(node('p', '', '게시된 공지가 없습니다. ‘공지 작성’으로 추가하세요.'));
    else for (const item of posted.slice(0, 4)) {
      const button = node('button', `notice-item${isFresh(item) ? ' fresh' : ''}`); button.type = 'button';
      const head = node('b'); head.append(node('em', 'notice-date', noticeDateLabel(item.date)));
      if (isNew(item)) head.append(newBadge());
      head.append(document.createTextNode(item.title));
      button.append(head);
      if (item.body) button.append(node('span', 'clamp', item.body));
      button.addEventListener('click', () => { page = 'notice'; history.replaceState(null, '', '#notice'); render(); document.getElementById('notice-' + item.id)?.scrollIntoView({ block: 'start' }); });
      board.append(button);
    }
    $('openNoticePage').hidden = !loaded || Boolean(problem) || !posted.length;
    // Full notice page: date · notice, long text, fresh ones glow for a week.
    const list = $('noticePageList'); list.replaceChildren();
    if (problem) { list.append(node('p', 'pos-warn', problem)); return; }
    if (!notices.length) { list.append(node('p', '', '게시된 공지가 없습니다. ‘공지 작성’으로 추가하세요.')); return; }
    for (const item of [...posted, ...down]) {
      const card = node('article', `notice-card${isFresh(item) ? ' fresh' : ''}${item.status !== '게시' ? ' down' : ''}`); card.id = 'notice-' + item.id;
      const when = node('div', 'notice-when'); when.append(node('strong', '', noticeDateLabel(item.date)));
      if (isFresh(item)) when.append(node('small', 'fresh-label', '이번 주 공지'));
      if (item.status !== '게시') when.append(node('small', '', '내림'));
      const body = node('div', 'notice-main');
      const title = node('h3'); if (isNew(item)) title.append(newBadge()); title.append(document.createTextNode(item.title));
      body.append(title);
      if (item.body) body.append(node('p', 'notice-body', item.body));
      const foot = node('div', 'notice-foot'); foot.append(node('small', '', item.owner));
      const edit = node('button', 'text-button', '수정'); edit.type = 'button'; edit.disabled = !user || noticeState !== 'ready'; edit.addEventListener('click', () => openNotice(item.id));
      const share = node('button', 'text-button', '링크 복사'); share.type = 'button'; share.addEventListener('click', () => shareLink('#notice/' + item.id));
      foot.append(edit, share); body.append(foot);
      card.append(when, body); list.append(card);
    }
  }
  function openNotice(id) {
    if (!user || !loaded || loading || saving || noticeState !== 'ready') return;
    const found = id ? notices.find(item => item.id === id) : null;
    noticeEdit = { principal: user.id, id: found?.id || crypto.randomUUID(), revision: found?.revision, isNew: !found };
    $('noticeDialogTitle').textContent = found ? '공지 수정' : '공지 작성';
    $('noticeTitle').value = found?.title || ''; $('noticeBody').value = found?.body || '';
    $('noticeOwner').value = found?.owner || (user.displayName || '').slice(0, 40);
    $('noticeDate').value = found?.date || todayISO(); $('noticeStatus').value = found?.status || '게시';
    $('noticeFormError').textContent = '';
    if (!$('noticeDialog').open) $('noticeDialog').showModal(); $('noticeTitle').focus();
  }
  async function persistNotice() {
    if (expireSession() || saving || !user || !loaded || !noticeEdit) return;
    const version = authVersion;
    const input = { title: $('noticeTitle').value.trim(), body: $('noticeBody').value.trim(), owner: $('noticeOwner').value.trim(), date: $('noticeDate').value, status: $('noticeStatus').value };
    if (!input.title || !input.owner || !input.date) { $('noticeFormError').textContent = '제목, 작성자, 날짜를 입력해 주세요.'; return; }
    saving = true; updateControls(); setStatus('시트에 저장 중');
    try {
      const data = noticeEdit.isNew ? { id: noticeEdit.id, ...input } : { id: noticeEdit.id, ...input, revision: noticeEdit.revision };
      const result = await api(noticeEdit.isNew ? 'createNotice' : 'updateNotice', data);
      if (version !== authVersion || expireSession()) return;
      const item = result.notice;
      if (!item || item.id !== noticeEdit.id) throw new Error('저장 결과를 확인하지 못했습니다. 입력 내용을 유지합니다.');
      notices = [item, ...notices.filter(entry => entry.id !== item.id)].sort((a, b) => b.date.localeCompare(a.date));
      $('noticeDialog').close(); render();
      setStatus('시트 저장'); toast(item.status === '내림' ? '공지를 목록에서 내렸습니다.' : '공지를 시트에 저장했습니다.');
    } catch (error) {
      if (version !== authVersion) return;
      $('noticeFormError').textContent = error.status === 409 ? '다른 곳에서 먼저 수정했습니다. 창을 닫고 새로고침한 뒤 다시 입력해 주세요.' : errorText(error);
      setStatus('저장 확인 실패 · 입력 유지', 'error');
      if (authError(error)) showConnectionError(error);
    } finally { saving = false; updateControls(); }
  }
  function kstStamp(date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const part = type => parts.find(p => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  }
  function renderPos(weekStart) {
    const body = $('posBody');
    body.replaceChildren();
    if (!loaded) { body.append(node('p', '', privateViewMessage('예약 요약'))); return; }
    if (posState === 'not-deployed') { body.append(node('p', 'pos-warn', '시트 웹앱이 아직 예약 요약을 받지 못합니다. Apps Script 코드를 갱신하면 표시됩니다.')); return; }
    if (posState === 'error') { body.append(node('p', 'pos-warn', '예약 요약을 불러오지 못했습니다. 새로고침해 주세요.')); return; }
    const current = posSummaries.find(item => item.weekStart === weekStart);
    const latest = current || posSummaries[0];
    if (!latest) { body.append(node('p', '', '아직 가져온 요약이 없습니다. 토스 POS를 확인한 뒤 ‘요약 입력’으로 기록합니다.')); return; }
    if (!current) body.append(node('p', 'pos-warn', '이번 주 요약은 아직 없습니다. 최근 기록을 보여 드립니다.'));
    const total = node('p', 'pos-total', `예약 ${latest.total}건`); total.append(node('small', '', latest.period)); if (isNew(latest)) total.prepend(newBadge());
    body.append(total);
    for (const [label, value] of [['요일', latest.byDay], ['시간대', latest.byTime], ['메모', latest.note]]) {
      if (!value) continue;
      const line = node('p', 'pos-line'); line.append(node('b', '', label), document.createTextNode(value)); body.append(line);
    }
    const saved = Date.parse(latest.updatedAt);
    body.append(node('p', 'pos-meta', `토스 POS 확인 ${latest.checkedAt}${Number.isFinite(saved) ? ` · 시트 저장 ${kstStamp(new Date(saved)).slice(5)}` : ''}`));
  }
  function openPos() {
    if (!user || !loaded || loading || saving || posState !== 'ready') return;
    const weekStart = weekDates(todayISO())[0];
    const found = posSummaries.find(item => item.weekStart === weekStart);
    posEdit = { principal: user.id, id: found?.id || crypto.randomUUID(), revision: found?.revision, isNew: !found };
    const end = offsetDate(weekStart, 6);
    $('posWeekStart').value = weekStart;
    $('posPeriod').value = found?.period || `${dateText(weekStart)} ~ ${dateText(end)}`;
    $('posTotal').value = found?.total ?? '';
    $('posByDay').value = found?.byDay || ''; $('posByTime').value = found?.byTime || ''; $('posNote').value = found?.note || '';
    $('posCheckedAt').value = kstStamp(new Date());
    $('posFormError').textContent = '';
    if (!$('posDialog').open) $('posDialog').showModal(); $('posTotal').focus();
  }
  async function persistPos() {
    if (expireSession() || saving || !user || !loaded || !posEdit) return;
    const version = authVersion;
    const input = { weekStart: $('posWeekStart').value, period: $('posPeriod').value.trim(), total: $('posTotal').value.trim(), byDay: $('posByDay').value.trim(), byTime: $('posByTime').value.trim(), note: $('posNote').value.trim(), checkedAt: $('posCheckedAt').value.trim() };
    if (!input.weekStart || !input.period || !input.total || !input.checkedAt) { $('posFormError').textContent = '주 시작일, 기간, 예약 건수, 확인 시각을 입력해 주세요.'; return; }
    saving = true; updateControls(); setStatus('시트에 저장 중');
    try {
      const data = posEdit.isNew ? { id: posEdit.id, ...input } : { id: posEdit.id, ...input, revision: posEdit.revision };
      const result = await api(posEdit.isNew ? 'createPos' : 'updatePos', data);
      if (version !== authVersion || expireSession()) return;
      const item = result.pos;
      if (!item || item.id !== posEdit.id) throw new Error('저장 결과를 확인하지 못했습니다. 입력 내용을 유지합니다.');
      posSummaries = [item, ...posSummaries.filter(entry => entry.id !== item.id)].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
      $('posDialog').close(); render();
      setStatus('시트 저장'); toast('예약 요약을 시트에 저장했습니다.');
    } catch (error) {
      if (version !== authVersion) return;
      $('posFormError').textContent = error.status === 409 ? '다른 곳에서 먼저 수정했습니다. 창을 닫고 새로고침한 뒤 다시 입력해 주세요.' : errorText(error);
      setStatus('저장 확인 실패 · 입력 유지', 'error');
      if (authError(error)) showConnectionError(error);
    } finally { saving = false; updateControls(); }
  }
  function renderEvents(today, dates) {
    const sorted = [...events].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    const daily = sorted.filter(event => event.date === today); $('todayEvents').replaceChildren();
    daily.forEach(event => {
      const item = node('button', 'event event-button'); item.type = 'button'; item.addEventListener('click', () => openEvent(event.id));
      const detail = node('span'); if (isNew(event)) detail.append(newBadge()); detail.append(node('b', '', event.title), node('small', '', event.owner)); item.append(node('time', '', event.time), detail); $('todayEvents').append(item);
    });
    const privateSchedule = privateViewMessage('센터 일정');
    if (!daily.length) $('todayEvents').append(node('p', 'empty-events', loaded ? '오늘 등록된 일정이 없습니다.' : privateSchedule));
    $('calendarDays').replaceChildren();
    dates.forEach((date, index) => {
      const label = ['월', '화', '수', '목', '금', '토', '일'][index], cell = node('div', `calendar-day${date === today ? ' today' : ''}`);
      cell.append(node('span', '', `${label}요일${date === today ? ' · 오늘' : ''}`), node('strong', '', String(Number(date.slice(8)))));
      const dayEvents = sorted.filter(event => event.date === date);
      dayEvents.forEach(event => {
        const item = node('button', 'calendar-event'); item.type = 'button'; item.append(node('time', '', event.time), node('b', '', event.title), node('small', '', event.owner)); item.addEventListener('click', () => openEvent(event.id)); cell.append(item);
      });
      if (loaded && !dayEvents.length) cell.append(node('p', 'empty-calendar', '일정 없음'));
      $('calendarDays').append(cell);
    });
    $('allEvents').replaceChildren();
    sorted.forEach(event => {
      const item = node('button', 'all-event-button'); item.type = 'button';
      item.append(node('time', '', `${event.date.replaceAll('-', '. ')} · ${event.time}`), node('b', '', event.title), node('small', '', event.owner));
      item.addEventListener('click', () => openEvent(event.id)); $('allEvents').append(item);
    });
    if (!sorted.length) $('allEvents').append(node('p', 'empty-events', loaded ? '등록된 일정이 없습니다. ‘일정 등록’으로 추가하세요.' : privateSchedule));
  }
  function openTask(id) {
    if (!user || !loaded || loading || saving) return;
    const task = id ? tasks.find(item => item.id === id) : null;
    taskEdit = { principal: user.id, id: task?.id || crypto.randomUUID(), revision: task?.revision, isNew: !task };
    $('taskIdLabel').textContent = task ? '업무 상세' : '새 업무'; $('dialogTitle').textContent = task ? '업무 상세' : '업무 등록';
    $('taskTitle').value = task?.title || ''; $('taskOwner').value = task?.owner || (user.displayName || '').slice(0, 40);
    $('taskStatus').value = task?.status || '접수'; $('taskCategory').value = task?.category || '운영·시설';
    $('taskDue').value = task?.due ?? todayISO(); $('taskNext').value = task?.next || '';
    $('taskResult').hidden = task?.result !== 'blog.html'; $('formError').textContent = ''; $('reloadTask').hidden = true; $('taskAuthRecovery').hidden = true;
    if (!$('taskDialog').open) $('taskDialog').showModal(); $('taskTitle').focus();
  }
  function openEvent(id) {
    if (!user || !loaded || loading || saving) return;
    const event = id ? events.find(item => item.id === id) : null;
    eventEdit = { principal: user.id, id: event?.id || crypto.randomUUID(), revision: event?.revision, isNew: !event };
    $('eventDialogTitle').textContent = event ? '일정 상세' : '일정 등록';
    $('eventTitle').value = event?.title || ''; $('eventOwner').value = event?.owner || (user.displayName || '').slice(0, 40);
    $('eventDate').value = event?.date || todayISO(); $('eventTime').value = event?.time || '09:00';
    $('eventFormError').textContent = ''; $('reloadEvent').hidden = true; $('eventAuthRecovery').hidden = true;
    if (!$('eventDialog').open) $('eventDialog').showModal(); $('eventTitle').focus();
  }
  async function persist(kind, input) {
    if (expireSession() || saving || !user || !loaded) return;
    const version = authVersion;
    const isTask = kind === 'task', edit = isTask ? taskEdit : eventEdit;
    const errorElement = $(isTask ? 'formError' : 'eventFormError'), reloadButton = $(isTask ? 'reloadTask' : 'reloadEvent');
    errorElement.textContent = ''; reloadButton.hidden = true;
    if (!input.title || !input.owner) { errorElement.textContent = '제목과 담당자를 입력해 주세요.'; return; }
    if (isTask && (!STATUSES.includes(input.status) || !CATEGORIES.includes(input.category))) { errorElement.textContent = '상태와 분야를 다시 확인해 주세요.'; return; }
    saving = true; updateControls(); setStatus('시트에 저장 중');
    try {
      const action = (edit.isNew ? 'create' : 'update') + (isTask ? 'Task' : 'Event');
      const data = edit.isNew ? { id: edit.id, ...input } : { id: edit.id, ...input, revision: edit.revision };
      const result = await api(action, data);
      if (version !== authVersion || expireSession()) return;
      const item = result[kind];
      if (!item || item.id !== edit.id) throw new Error('저장 결과를 확인하지 못했습니다. 입력 내용을 유지합니다.');
      if (isTask) tasks = [item, ...tasks.filter(task => task.id !== item.id)]; else events = [item, ...events.filter(event => event.id !== item.id)];
      $(isTask ? 'taskDialog' : 'eventDialog').close(); clearConnectionError(); renderOwners(); render();
      setStatus('시트 저장'); $('lastUpdated').textContent = `${timeText(new Date())}에 변경 사항 저장 · 한국 시간`; toast(`${isTask ? '업무를' : '일정을'} 시트에 저장했습니다.`);
    } catch (error) {
      if (version !== authVersion) return;
      if (error.status === 409) {
        errorElement.textContent = '시트의 내용이 변경되어 저장하지 않았습니다. 현재 입력은 유지됩니다. 아래 버튼으로 최신 내용을 확인한 뒤 다시 수정해 주세요.';
        reloadButton.hidden = false; setStatus('저장 충돌 · 입력 유지', 'error');
      } else {
        errorElement.textContent = errorText(error); setStatus('저장 확인 실패 · 입력 유지', 'error');
        if (authError(error)) showConnectionError(error);
      }
    } finally { saving = false; updateControls(); }
  }
  async function reloadConflicted(kind) {
    if (expireSession() || !user || saving || !window.confirm('지금 작성한 내용을 버리고 시트의 최신 내용을 불러올까요?')) return;
    const version = authVersion;
    const isTask = kind === 'task', edit = isTask ? taskEdit : eventEdit, errorElement = $(isTask ? 'formError' : 'eventFormError');
    saving = true; updateControls();
    try {
      const result = await api(isTask ? 'listTasks' : 'listEvents'), list = isTask ? result.tasks : result.events;
      if (version !== authVersion || expireSession()) return;
      if (!Array.isArray(list) || !list.some(item => item.id === edit.id)) throw new Error('시트에서 해당 항목을 찾지 못했습니다. 현재 입력은 남겨 두었습니다.');
      if (isTask) tasks = list; else events = list;
      saving = false; clearConnectionError(); renderOwners(); render();
      if (isTask) openTask(edit.id); else openEvent(edit.id);
      setStatus('최신 내용 불러옴'); toast('시트의 최신 내용을 불러왔습니다. 내용을 확인하고 수정해 주세요.');
    } catch (error) { if (version === authVersion) { errorElement.textContent = errorText(error); if (authError(error)) showConnectionError(error); } }
    finally { saving = false; updateControls(); }
  }
  // Every screen and every task/notice has its own address so it can be shared as a link.
  const PAGES = { home: 'overview', notice: 'notice', tasks: 'tasks', calendar: 'calendar', ai: 'ai' };
  const pageHash = name => Object.keys(PAGES).find(key => PAGES[key] === name) || 'home';
  let pendingOpen = null;
  function setHash(hash) { if (location.hash !== hash) history.replaceState(null, '', hash); }
  function applyHash() {
    const [key, id] = location.hash.replace(/^#/, '').split('/');
    if (key === 'ai-dashboard') page = 'ai';
    else if (key === 'task' && id) { page = 'tasks'; pendingOpen = { kind: 'task', id }; }
    else if (key === 'notice' && id) { page = 'notice'; pendingOpen = { kind: 'notice', id }; }
    else if (PAGES[key]) page = PAGES[key];
    render();
    openPending();
  }
  function openPending() {
    if (!pendingOpen || !loaded || loading || saving || isDialogOpen()) return;
    const { kind, id } = pendingOpen;
    const list = kind === 'task' ? tasks : notices;
    if (!list.some(item => item.id === id)) { if (kind === 'task' || noticeState !== 'idle') { pendingOpen = null; toast('링크의 항목을 찾지 못했습니다. 이미 정리됐거나 권한이 없는 항목입니다.'); } return; }
    pendingOpen = null;
    if (kind === 'task') { openTask(id); return; }
    const card = document.getElementById('notice-' + id);
    if (card) { card.scrollIntoView({ block: 'start' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 2500); }
  }
  function shareLink(hash) {
    const url = `${location.origin}${location.pathname}${hash}`;
    const done = () => toast('링크를 복사했습니다. 카톡·메시지에 붙여 넣으세요. 팀 계정으로 로그인해야 열립니다.');
    if (navigator.share && matchMedia('(max-width: 760px)').matches) { navigator.share({ title: document.title, url }).catch(() => {}); return; }
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(url).then(done, () => window.prompt('이 주소를 복사하세요', url)); return; }
    window.prompt('이 주소를 복사하세요', url);
  }
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { page = button.dataset.page; setHash('#' + pageHash(page)); render(); }));
  window.addEventListener('hashchange', applyHash);
  $('sharePage').addEventListener('click', () => shareLink('#' + pageHash(page)));
  $('shareTask').addEventListener('click', () => { if (taskEdit && !taskEdit.isNew) shareLink('#task/' + taskEdit.id); else toast('저장한 뒤 링크를 복사할 수 있습니다.'); });
  $('shareNotice').addEventListener('click', () => { if (noticeEdit && !noticeEdit.isNew) shareLink('#notice/' + noticeEdit.id); else toast('저장한 뒤 링크를 복사할 수 있습니다.'); });
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { if (button.dataset.filter === 'week') { page = 'calendar'; render(); return; } resetFilters(); quickFilter = button.dataset.filter; page = 'tasks'; render(); }));
  $('openCalendar').addEventListener('click', () => { page = 'calendar'; setHash('#calendar'); render(); });
  $('allTasks').addEventListener('click', () => { mine = false; render(); });
  $('myTasks').addEventListener('click', () => { mine = true; $('ownerFilter').value = ''; render(); });
  ['searchTasks', 'ownerFilter', 'statusFilter'].forEach(id => $(id).addEventListener(id === 'searchTasks' ? 'input' : 'change', render));
  $('clearFilters').addEventListener('click', () => { resetFilters(); render(); });
  $('addTask').addEventListener('click', () => openTask()); $('addEvent').addEventListener('click', () => openEvent());
  $('addPos').addEventListener('click', openPos);
  $('addNotice').addEventListener('click', () => openNotice());
  $('addNoticePage').addEventListener('click', () => openNotice());
  $('openNoticePage').addEventListener('click', () => { page = 'notice'; history.replaceState(null, '', '#notice'); render(); window.scrollTo(0, 0); });
  for (const id of ['closeNoticeDialog', 'cancelNoticeDialog']) $(id).addEventListener('click', () => { if (!saving) $('noticeDialog').close(); });
  $('noticeDialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('noticeForm').addEventListener('submit', event => { event.preventDefault(); persistNotice(); });
  for (const id of ['closePosDialog', 'cancelPosDialog']) $(id).addEventListener('click', () => { if (!saving) $('posDialog').close(); });
  $('posDialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('posForm').addEventListener('submit', event => { event.preventDefault(); persistPos(); });
  $('refreshData').addEventListener('click', () => refresh());
  for (const id of ['closeDialog', 'cancelDialog']) $(id).addEventListener('click', () => { if (!saving) $('taskDialog').close(); });
  for (const id of ['closeEventDialog', 'cancelEventDialog']) $(id).addEventListener('click', () => { if (!saving) $('eventDialog').close(); });
  for (const id of ['taskDialog', 'eventDialog']) $(id).addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('reloadTask').addEventListener('click', () => reloadConflicted('task')); $('reloadEvent').addEventListener('click', () => reloadConflicted('event'));
  for (const kind of ['task', 'event']) $(kind + 'ResumeSession').addEventListener('click', () => renderRecoveryButton(kind));
  $('signInLink').addEventListener('click', focusGoogleSignIn);
  $('logout').addEventListener('click', logout);
  $('taskForm').addEventListener('submit', event => { event.preventDefault(); persist('task', { title: $('taskTitle').value.trim(), owner: $('taskOwner').value.trim(), category: $('taskCategory').value, due: $('taskDue').value, status: $('taskStatus').value, next: $('taskNext').value.trim() }); });
  $('eventForm').addEventListener('submit', event => { event.preventDefault(); persist('event', { title: $('eventTitle').value.trim(), owner: $('eventOwner').value.trim(), date: $('eventDate').value, time: $('eventTime').value }); });
  $('downloadBackup').addEventListener('click', () => {
    if (expireSession() || !user || !loaded) return;
    const backup = { format: 'aon-work-backup-v1', exportedAt: new Date().toISOString(), timeZone: 'Asia/Seoul', tasks, events };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = node('a'); link.href = url; link.download = `AON_업무일정_${todayISO()}_${timeText(new Date()).replaceAll(':', '')}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('현재 불러온 업무·일정을 백업했습니다. 로그인 정보는 포함하지 않습니다.');
  });
  function refreshVisible() {
    if (!document.hidden && !expireSession() && !isDialogOpen()) refresh({ silent: true });
  }
  window.addEventListener('focus', refreshVisible);
  document.addEventListener('visibilitychange', refreshVisible);
  setInterval(refreshVisible, 60000);
  window.addEventListener('beforeunload', event => { if (saving || isDialogOpen()) { event.preventDefault(); event.returnValue = ''; } });
  applyHash(); updateControls(); initializeLogin();
})();
