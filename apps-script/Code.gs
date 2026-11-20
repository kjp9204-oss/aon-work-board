const BOARD_DATA_SCHEMA = Object.freeze({
  task: {
    tab: "업무",
    fields: ["id", "title", "category", "owner", "due", "status", "next"],
    headers: ["id", "title", "category", "owner", "due", "status", "next", "revision", "updatedAt", "updatedBy"]
  },
  event: {
    tab: "일정",
    fields: ["id", "title", "owner", "date", "time"],
    headers: ["id", "title", "owner", "date", "time", "revision", "updatedAt", "updatedBy"]
  },
  // Weekly Toss POS reservation summary: counts only, never customer names, phones, memos or captures.
  pos: {
    tab: "예약 요약",
    fields: ["id", "weekStart", "period", "total", "byDay", "byTime", "note", "checkedAt"],
    headers: ["id", "weekStart", "period", "total", "byDay", "byTime", "note", "checkedAt", "revision", "updatedAt", "updatedBy"]
  },
  // Team notices for center operations only. Taken-down notices stay in the sheet with status 내림.
  notice: {
    tab: "공지",
    fields: ["id", "title", "body", "owner", "date", "status"],
    headers: ["id", "title", "body", "owner", "date", "status", "revision", "updatedAt", "updatedBy"]
  }
});
const NOTICE_STATUSES = ["게시", "내림"];
const ALLOWED_EMAILS_TAB = "허용 계정";
const AUDIT_TAB = "변경 기록";
const AUDIT_HEADERS = ["at", "actor", "entity", "recordId", "action", "revision", "requestHash"];
const CATEGORIES = ["운영·시설", "직원·교육", "회의·행사", "블로그·홍보"];
const STATUSES = ["접수", "진행 중", "확인 대기", "보류", "완료"];
const DATA_ACTIONS = Object.freeze({
  listTasks: ["task", "list"],
  listEvents: ["event", "list"],
  createTask: ["task", "create"],
  updateTask: ["task", "update"],
  createEvent: ["event", "create"],
  updateEvent: ["event", "update"],
  listPos: ["pos", "list"],
  createPos: ["pos", "create"],
  updatePos: ["pos", "update"],
  listNotices: ["notice", "list"],
  createNotice: ["notice", "create"],
  updateNotice: ["notice", "update"]
});
const LIST_KEYS = Object.freeze({ task: "tasks", event: "events", pos: "posSummaries", notice: "notices" });
// Tabs added after the first deployment are created on first use.
const LATE_TABS = ["pos", "notice"];

class BoardError_ extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function doGet() {
  return boardJson_({ ok: false, status: 405, error: { code: "METHOD_NOT_ALLOWED", message: "지원하지 않는 호출입니다." } });
}

function doPost(event) {
  try {
    const request = requestBody_(event);
    const config = PropertiesService.getScriptProperties();
    const clientId = config.getProperty("AON_GOOGLE_CLIENT_ID");
    const sheetId = config.getProperty("AON_SHEET_ID");
    if (!clientId || !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
        !sheetId || !/^[a-zA-Z0-9_-]{15,120}$/.test(sheetId)) {
      throw new BoardError_(503, "NOT_CONFIGURED", "업무보드 연결 설정을 확인해 주세요.");
    }
    const user = readGoogleIdToken_(request.token, clientId, Math.floor(Date.now() / 1000), googleSigningKey_);
    if (!user) throw new BoardError_(401, "AUTH_REQUIRED", "Google 계정으로 다시 로그인해 주세요.");

    if (!user.emailAuthoritative) {
      if (request.action === "session") return boardJson_(guestSession_());
      throw new BoardError_(403, "GOOGLE_EMAIL_REQUIRED", "센터 운영 데이터는 허용된 Gmail 또는 관리되는 Google Workspace 계정으로 이용해 주세요.");
    }
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    if (request.action === "session") {
      return boardJson_(isAllowedEmail_(spreadsheet, user)
        ? { ok: true, storage: "sheet", access: "member", user: { id: user.id, displayName: user.displayName } }
        : guestSession_());
    }
    requireAllowedEmail_(spreadsheet, user);
    return boardJson_(routeBoardRequest_(spreadsheet, user, request));
  } catch (error) {
    if (error instanceof BoardError_) {
      return boardJson_({ ok: false, status: error.status, error: { code: error.code, message: error.message } });
    }
    return boardJson_({ ok: false, status: 503, error: { code: "SHEET_UNAVAILABLE", message: "시트를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요." } });
  }
}

function requestBody_(event) {
  const contents = event && event.postData && event.postData.contents;
  if (typeof contents !== "string" || contents.length < 2 || contents.length > 48000) {
    throw new BoardError_(400, "INVALID_REQUEST", "요청 형식을 확인해 주세요.");
  }
  try {
    const body = JSON.parse(contents);
    if (!isRecord_(body) || typeof body.action !== "string") throw new Error("Malformed request");
    return body;
  } catch (_) {
    throw new BoardError_(400, "INVALID_REQUEST", "요청 형식을 확인해 주세요.");
  }
}

function boardJson_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function isRecord_(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn_(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function ensureTab_(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet || sheet.getMaxColumns() < headers.length || sheet.getLastRow() < 1 ||
      !sheet.getRange(1, 1, 1, headers.length).getValues()[0].every((value, index) => value === headers[index])) {
    throw new BoardError_(503, "SCHEMA_NOT_READY", "시트의 탭과 헤더를 확인해 주세요.");
  }
  return sheet;
}

function guestSession_() {
  return { ok: true, storage: "sheet", access: "guest" };
}

function isAllowedEmail_(spreadsheet, actor) {
  const sheet = ensureTab_(spreadsheet, ALLOWED_EMAILS_TAB, ["email"]);
  const count = sheet.getLastRow() - 1;
  return count > 0 && sheet.getRange(2, 1, count, 1).getValues().some(row => {
    const email = typeof row[0] === "string" ? row[0].trim().toLowerCase() : "";
    return email === actor.email;
  });
}

function requireAllowedEmail_(spreadsheet, actor) {
  if (!isAllowedEmail_(spreadsheet, actor)) {
    throw new BoardError_(403, "ACCOUNT_NOT_ALLOWED", "이 계정은 AON 센터 운영 데이터를 사용할 권한이 없습니다.");
  }
}

function routeBoardRequest_(spreadsheet, actor, request) {
  if (!hasOwn_(DATA_ACTIONS, request.action)) {
    throw new BoardError_(400, "UNKNOWN_ACTION", "지원하지 않는 요청입니다.");
  }
  const [kind, action] = DATA_ACTIONS[request.action];
  const schema = BOARD_DATA_SCHEMA[kind];
  const sheet = LATE_TABS.includes(kind) ? ensureLateTab_(spreadsheet, kind) : ensureTab_(spreadsheet, schema.tab, schema.headers);
  const audit = ensureTab_(spreadsheet, AUDIT_TAB, AUDIT_HEADERS);
  if (action === "list") {
    const creators = creationIndex_(audit, kind);
    const records = boardRows_(sheet, schema.headers).map(entry => withCreator_(entry.record, creators));
    records.sort(kind === "task" ? (a, b) => b.updatedAt.localeCompare(a.updatedAt) :
      kind === "pos" ? (a, b) => b.weekStart.localeCompare(a.weekStart) || b.updatedAt.localeCompare(a.updatedAt) :
      kind === "notice" ? (a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt) :
      (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    return { ok: true, storage: "sheet", [LIST_KEYS[kind]]: records };
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new BoardError_(503, "SHEET_BUSY", "다른 저장이 진행 중입니다. 잠시 후 시도해 주세요.");
  try {
    requireAllowedEmail_(spreadsheet, actor);
    const record = saveBoardRecord_(spreadsheet, sheet, audit, actor, schema, kind, action, request.data);
    return { ok: true, storage: "sheet", [kind]: record };
  } finally {
    lock.releaseLock();
  }
}

// The reservation and notice tabs were added after the first deployment, so create them on
// first use with exact headers instead of failing every board read until setup is re-run.
function ensureLateTab_(spreadsheet, kind) {
  const schema = BOARD_DATA_SCHEMA[kind];
  const existing = spreadsheet.getSheetByName(schema.tab);
  if (existing && existing.getLastRow() > 0) return ensureTab_(spreadsheet, schema.tab, schema.headers);
  const sheet = existing || spreadsheet.insertSheet(schema.tab);
  sheet.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
  return sheet;
}

function boardRows_(sheet, headers) {
  const count = sheet.getLastRow() - 1;
  if (count < 1) return [];
  const output = [];
  sheet.getRange(2, 1, count, headers.length).getValues().forEach((cells, offset) => {
    if (!cells[0]) return;
    const values = cells.map((value, index) => normalizeStored_(value, headers[index]));
    output.push({ index: offset + 1, record: Object.fromEntries(headers.map((key, index) => [key, values[index]])) });
  });
  return output;
}

function normalizeStored_(value, key) {
  if (!(value instanceof Date)) return value;
  if (key === "due" || key === "date" || key === "weekStart") return Utilities.formatDate(value, "Asia/Seoul", "yyyy-MM-dd");
  if (key === "time") return Utilities.formatDate(value, "Asia/Seoul", "HH:mm");
  return value.toISOString();
}

function creationIndex_(audit, kind) {
  const creations = new Map();
  const count = audit.getLastRow() - 1;
  if (count < 1) return creations;
  audit.getRange(2, 1, count, AUDIT_HEADERS.length).getValues().forEach(row => {
    if (row[2] === kind && row[4] === "create" && !creations.has(row[3])) {
      creations.set(row[3], { actor: row[1], hash: row[6] });
    }
  });
  return creations;
}

function withCreator_(record, creations) {
  const original = creations.get(record.id);
  return Object.assign({}, record, original ? { createdBy: original.actor } : {});
}

function invalidInput_(message) {
  throw new BoardError_(400, "INVALID_INPUT", message);
}

function textValue_(value, minLength, maxLength, label, multiline) {
  if (typeof value !== "string") return invalidInput_(label + " 입력을 확인해 주세요.");
  const result = multiline ? value.replace(/\r\n?/g, "\n").trim() : value.trim();
  const control = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (result.length < minLength || result.length > maxLength || control.test(result)) {
    return invalidInput_(label + " 입력을 확인해 주세요.");
  }
  return result;
}

function dateValue_(value, optional, label) {
  if (value === "" && optional) return value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) {
    return invalidInput_(label + "을 YYYY-MM-DD로 입력해 주세요.");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return invalidInput_(label + "에 올바른 날짜를 입력해 주세요.");
  }
  return value;
}

function validateBoardFields_(kind, input) {
  const id = input.id;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return invalidInput_("업무 또는 일정 ID를 확인해 주세요.");
  }
  if (kind === "notice") {
    if (!NOTICE_STATUSES.includes(input.status)) return invalidInput_("공지 상태를 확인해 주세요.");
    return {
      id: id.toLowerCase(), title: textValue_(input.title, 1, 100, "공지 제목", false),
      body: textValue_(input.body ?? "", 0, 3000, "공지 내용", true),
      owner: textValue_(input.owner, 1, 40, "작성자", false),
      date: dateValue_(input.date, false, "공지 날짜"), status: input.status
    };
  }
  if (kind === "pos") {
    return {
      id: id.toLowerCase(), weekStart: dateValue_(input.weekStart, false, "주 시작일"),
      period: textValue_(input.period, 1, 40, "기간", false),
      total: textValue_(String(input.total ?? ""), 1, 20, "예약 건수", false),
      byDay: textValue_(input.byDay ?? "", 0, 200, "요일별 건수", true),
      byTime: textValue_(input.byTime ?? "", 0, 200, "시간대별 건수", true),
      note: textValue_(input.note ?? "", 0, 200, "메모", true),
      checkedAt: textValue_(input.checkedAt, 1, 40, "확인 시각", false)
    };
  }
  const title = textValue_(input.title, 1, 100, "제목", false);
  const owner = textValue_(input.owner, 1, 40, "담당", false);
  if (kind === "task") {
    if (!CATEGORIES.includes(input.category) || !STATUSES.includes(input.status)) {
      return invalidInput_("업무 분류와 상태를 확인해 주세요.");
    }
    return {
      id: id.toLowerCase(), title: title, category: input.category, owner: owner,
      due: dateValue_(input.due, true, "마감일"), status: input.status,
      next: textValue_(input.next, 0, 300, "다음 행동", true)
    };
  }
  if (typeof input.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
    return invalidInput_("시간을 HH:mm으로 입력해 주세요.");
  }
  return { id: id.toLowerCase(), title: title, owner: owner, date: dateValue_(input.date, false, "일정 날짜"), time: input.time };
}

function creationHash_(actor, schema, record) {
  const value = JSON.stringify([actor.id, ...schema.fields.map(field => record[field])]);
  return bytesHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}

function saveBoardRecord_(spreadsheet, sheet, audit, actor, schema, kind, action, data) {
  const accepts = action === "create" ? schema.fields : [...schema.fields, "revision"];
  if (!isRecord_(data) || Object.keys(data).some(key => !accepts.includes(key)) ||
      typeof data.id !== "string") return invalidInput_("저장할 내용을 확인해 주세요.");

  const id = data.id.toLowerCase();
  const found = boardRows_(sheet, schema.headers).find(row => row.record.id === id);
  const creations = creationIndex_(audit, kind);
  let input;
  let hash = "";
  let revision;
  if (action === "create") {
    input = validateBoardFields_(kind, data);
    hash = creationHash_(actor, schema, input);
    if (found) {
      const original = creations.get(id);
      if (!original || original.hash !== hash) {
        throw new BoardError_(409, "ID_CONFLICT", "같은 ID가 이미 있습니다. 목록을 다시 읽어 주세요.");
      }
      return withCreator_(found.record, creations);
    }
    revision = 1;
  } else {
    if (!Number.isSafeInteger(data.revision) || data.revision < 1) return invalidInput_("수정 버전을 확인해 주세요.");
    if (!found) throw new BoardError_(404, "NOT_FOUND", "항목을 찾을 수 없습니다. 목록을 다시 읽어 주세요.");
    if (found.record.revision !== data.revision) {
      throw new BoardError_(409, "REVISION_CONFLICT", "다른 곳에서 이미 수정했습니다. 최신 내용을 다시 읽어 주세요.");
    }
    input = validateBoardFields_(kind, Object.assign({}, found.record, data));
    revision = found.record.revision + 1;
  }

  const timestamp = new Date().toISOString();
  const saved = Object.assign({}, input, { revision: revision, updatedAt: timestamp, updatedBy: actor.id });
  const values = schema.headers.map(header => saved[header]);
  const auditValues = [timestamp, actor.id, kind, id, action, revision, hash];
  const requests = [
    action === "create" ? appendSheetCells_(sheet, values) : updateSheetCells_(sheet, found.index, values),
    appendSheetCells_(audit, auditValues)
  ];

  // CellData.stringValue is literal even if a string starts with an equals sign.
  // The Sheets batch commits data and audit together, while the script lock protects revision comparison.
  Sheets.Spreadsheets.batchUpdate({ requests: requests }, spreadsheet.getId());
  return action === "create" ? Object.assign({}, saved, { createdBy: actor.id }) : withCreator_(saved, creations);
}

function cellData_(value) {
  return { userEnteredValue: typeof value === "number" ? { numberValue: value } : { stringValue: value } };
}

function appendSheetCells_(sheet, values) {
  return { appendCells: {
    sheetId: sheet.getSheetId(),
    rows: [{ values: values.map(cellData_) }],
    fields: "userEnteredValue"
  } };
}

function updateSheetCells_(sheet, rowIndex, values) {
  return { updateCells: {
    range: {
      sheetId: sheet.getSheetId(),
      startRowIndex: rowIndex,
      endRowIndex: rowIndex + 1,
      startColumnIndex: 0,
      endColumnIndex: values.length
    },
    rows: [{ values: values.map(cellData_) }],
    fields: "userEnteredValue"
  } };
}

// Run manually from the bound Apps Script editor by the owner, never from the public endpoint.
function prepareAonSpreadsheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet || spreadsheet.getName() !== "AON 오늘의 센터 데이터") {
    throw new Error("AON 오늘의 센터 데이터 시트에 붙은 편집기에서 실행해 주세요.");
  }
  const headersByTab = [
    [BOARD_DATA_SCHEMA.task.tab, BOARD_DATA_SCHEMA.task.headers],
    [BOARD_DATA_SCHEMA.event.tab, BOARD_DATA_SCHEMA.event.headers],
    [BOARD_DATA_SCHEMA.pos.tab, BOARD_DATA_SCHEMA.pos.headers],
    [BOARD_DATA_SCHEMA.notice.tab, BOARD_DATA_SCHEMA.notice.headers],
    [ALLOWED_EMAILS_TAB, ["email"]],
    [AUDIT_TAB, AUDIT_HEADERS]
  ];
  for (const [name, headers] of headersByTab) {
    const sheet = spreadsheet.getSheetByName(name);
    if (sheet && sheet.getLastRow() > 0) ensureTab_(spreadsheet, name, headers);
  }
  const sheets = spreadsheet.getSheets();
  if (sheets.length === 1 && sheets[0].getLastRow() === 0 && !spreadsheet.getSheetByName(BOARD_DATA_SCHEMA.task.tab)) {
    sheets[0].setName(BOARD_DATA_SCHEMA.task.tab);
  }
  for (const [name, headers] of headersByTab) {
    const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
  }
  SpreadsheetApp.flush();
  PropertiesService.getScriptProperties().setProperty("AON_SHEET_ID", spreadsheet.getId());
}
