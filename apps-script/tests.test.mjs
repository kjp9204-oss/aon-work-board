import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const scripts = ["Auth.gs", "Code.gs"].map(name => readFileSync(new URL(name, import.meta.url), "utf8"));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleKey = { ...publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "test-key-1" };
const clientId = "100-local-test.apps.googleusercontent.com";
const fakeSheetId = "sheet_id_for_local_test_not_live";
const actorId = "100000000000000000001";
const id = "a3c5fcf8-5c08-483c-9e64-32a2c4443e4c";
const eventId = "ef71930e-bd7f-4d22-a936-97868589f7dc";
const task = { id, title: "=NOT_A_FORMULA()", category: "운영·시설", owner: "QA 담당", due: "2028-02-29", status: "접수", next: "예시\n다음 줄" };

function token(overrides = {}, header = {}) {
  const epoch = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = encode({ iss: "https://accounts.google.com", sub: actorId, aud: clientId, iat: epoch - 15, exp: epoch + 600,
    email: "test-account@gmail.com", email_verified: true, name: "검증용 계정", ...overrides });
  const data = encode({ alg: "RS256", kid: googleKey.kid, ...header }) + "." + body;
  return data + "." + sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
}

function fixture() {
  const options = { opens: 0, working: true, fetches: 0, batch: null, lock: false };
  const tabs = new Map();
  const props = new Map([["AON_GOOGLE_CLIENT_ID", clientId]]);
  const cached = new Map();
  let seq = 100;
  function tab(name) {
    const sheetId = seq++;
    const sheet = {
      rows: [],
      getSheetId: () => sheetId,
      getLastRow: () => sheet.rows.length,
      getMaxColumns: () => 26,
      setName(next) { tabs.delete(name); tabs.set(next, sheet); name = next; return sheet; },
      setFrozenRows() {},
      getRange(row, col, height, width) {
        return {
          getValues: () => Array.from({ length: height }, (_, i) =>
            Array.from({ length: width }, (_, j) => sheet.rows[row - 1 + i]?.[col - 1 + j] ?? "")),
          setValues(values) {
            for (let i = 0; i < height; i++) (sheet.rows[row - 1 + i] ??= []).splice(col - 1, width, ...values[i]);
            return this;
          },
          setFontWeight() { return this; },
        };
      },
    };
    tabs.set(name, sheet);
    return sheet;
  }

  tab("Sheet1");
  const spreadsheet = {
    getId: () => fakeSheetId,
    getName: () => "AON 오늘의 센터 데이터",
    getSheets: () => [...tabs.values()],
    getSheetByName: key => tabs.get(key),
    insertSheet: tab,
  };
  const context = createContext({
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet, flush() {},
      openById(candidate) { assert.equal(candidate, fakeSheetId); options.opens++; return spreadsheet; },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key), setProperty: (key, value) => props.set(key, value) }) },
    ContentService: {
      MimeType: { JSON: 1 }, createTextOutput: contents => ({ setMimeType: () => JSON.parse(contents) }),
    },
    Utilities: {
      base64DecodeWebSafe: value => [...Buffer.from(value, "base64url")],
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") }),
      computeDigest: (alg, value) => [...createHash(alg).update(value).digest()],
      DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
    },
    LockService: { getScriptLock: () => ({
      tryLock() { if (options.lock) return false; options.lock = true; return true; },
      releaseLock() { options.lock = false; },
    }) },
    CacheService: { getScriptCache: () => ({
      get: key => cached.get(key), put: (key, value) => cached.set(key, value),
    }) },
    UrlFetchApp: {
      fetch(url) {
        assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
        options.fetches++;
        return { getHeaders: () => ({ "Cache-Control": "public, max-age=7200", Age: "30" }),
          getResponseCode: () => 200, getContentText: () => JSON.stringify({ keys: [googleKey] }) };
      },
    },
    Sheets: { Spreadsheets: {
      batchUpdate({ requests }, candidate) {
        assert.equal(candidate, fakeSheetId);
        assert.equal(options.lock, true);
        if (!options.working) throw Error("mock sheet failure");
        options.batch = requests;
        assert.equal(requests.length, 2);
        for (const request of requests) {
          const action = request.appendCells || request.updateCells;
          const target = [...tabs.values()].find(sheet => sheet.getSheetId() === (action.sheetId ?? action.range.sheetId));
          const row = Array.from(action.rows[0].values, ({ userEnteredValue: value }) => {
            assert.equal("formulaValue" in value, false);
            return value.numberValue ?? value.stringValue;
          });
          if (request.appendCells) target.rows.push(row);
          else target.rows[action.range.startRowIndex] = row;
        }
      },
    } },
  });
  for (const script of scripts) runInContext(script, context);
  context.prepareAonSpreadsheet();
  if (tabs.has("허용 계정")) tabs.get("허용 계정").rows.push(["Test-account@gmail.com"]);
  const call = (action, data, providedToken = token()) => context.doPost({ postData: { contents: JSON.stringify({ token: providedToken, action, data }) } });
  return { context, call, options, tabs, props };
}

test("bound setup initializes exact headers and preserves named records on another run", () => {
  const { context, call, tabs, props } = fixture();
  assert.deepEqual([...tabs.keys()], ["업무", "일정", "예약 요약", "공지", "허용 계정", "변경 기록"]);
  assert.equal(props.get("AON_SHEET_ID"), fakeSheetId);
  assert.deepEqual(tabs.get("업무").rows[0], ["id", "title", "category", "owner", "due", "status", "next", "revision", "updatedAt", "updatedBy"]);
  assert.deepEqual(tabs.get("일정").rows[0], ["id", "title", "owner", "date", "time", "revision", "updatedAt", "updatedBy"]);
  assert.equal(call("createTask", task).ok, true);
  context.prepareAonSpreadsheet();
  assert.equal(tabs.get("업무").rows.length, 2);
});

test("verifies a real RS256 signature and returns stable Google sub", () => {
  const { call, options } = fixture();
  assert.deepEqual(call("session"), { ok: true, storage: "sheet", access: "member", user: { id: actorId, displayName: "검증용 계정" } });
  assert.equal(call("session").ok, true);
  assert.equal(options.fetches, 1);
});

test("rejects expired, wrong-audience, wrong-key, tampered, wrong-algorithm and incomplete claims", () => {
  const { call, options } = fixture();
  const signed = token();
  const parts = signed.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], "base64url")), name: "tampered" })).toString("base64url");
  const invalid = [
    "",
    token({ aud: "other-app.apps.googleusercontent.com" }),
    token({ iss: "https://other.example" }),
    token({ exp: Math.floor(Date.now() / 1000) - 1 }),
    token({ email_verified: false }),
    token({}, { kid: "unknown-key" }),
    token({}, { alg: "none" }),
    token({}, { crit: ["b64"], b64: false }),
    parts.join("."),
  ];
  for (const value of invalid) {
    const response = call("listTasks", {}, value);
    assert.equal(response.status, 401, JSON.stringify(response));
    assert.equal(response.tasks, undefined);
  }
  assert.equal(options.opens, 0);
});

test("verified guests sign in without identity or data; private actions require the current allowlist", () => {
  const { call, tabs, context, options } = fixture();
  const guest = { ok: true, storage: "sheet", access: "guest" };
  const unknown = token({ email: "not-allowlisted@gmail.com" });
  const thirdParty = token({ email: "operator@example.org" });
  const protectedActions = [
    "listTasks", "listEvents", "createTask", "updateTask", "createEvent", "updateEvent",
    "listNotices", "createNotice", "updateNotice", "listPos", "createPos", "updatePos"
  ];
  tabs.delete("공지");
  tabs.delete("예약 요약");
  assert.equal(call("session", {}, "").status, 401);
  assert.deepEqual(call("session", {}, unknown), guest);
  for (const action of protectedActions) {
    const response = call(action, {}, unknown);
    assert.equal(response.status, 403);
    assert.equal(response.error.code, "ACCOUNT_NOT_ALLOWED");
    assert.equal(response.tasks, undefined);
    assert.equal(response.events, undefined);
    assert.equal(response.notices, undefined);
    assert.equal(response.posSummaries, undefined);
  }
  assert.equal(options.batch, null);
  assert.equal(tabs.has("공지"), false);
  assert.equal(tabs.has("예약 요약"), false);
  const priorOpens = options.opens;
  tabs.get("허용 계정").rows.push(["operator@example.org"]);
  assert.deepEqual(call("session", {}, thirdParty), guest);
  for (const action of protectedActions) assert.equal(call(action, {}, thirdParty).error.code, "GOOGLE_EMAIL_REQUIRED");
  assert.equal(options.opens, priorOpens);
  assert.equal(call("session", {}, token({ email: "operator@example.org", hd: "example.org" })).access, "member");
  assert.equal(call("session").access, "member");
  tabs.get("허용 계정").rows.splice(1);
  assert.deepEqual(call("session"), guest);
  assert.equal(call("listTasks").error.code, "ACCOUNT_NOT_ALLOWED");
  assert.equal(context.doGet().status, 405);
});

test("task create, retry, edit, competing revision, and retry of original payload preserve one row", () => {
  const { call, tabs, options } = fixture();
  const created = call("createTask", task);
  assert.equal(created.task.title, task.title);
  assert.equal(created.task.createdBy, actorId);
  assert.equal(created.task.updatedBy, actorId);
  assert.equal(call("createTask", task).task.revision, 1);
  assert.equal(call("createTask", { ...task, owner: "다른 예시 담당자" }).error.code, "ID_CONFLICT");
  assert.equal(call("updateTask", { id, revision: 1, status: "진행 중" }).task.revision, 2);
  assert.equal(call("updateTask", { id, revision: 1, status: "완료" }).error.code, "REVISION_CONFLICT");
  assert.equal(call("createTask", task).task.revision, 2);
  assert.equal(call("listTasks").tasks[0].status, "진행 중");
  assert.equal(tabs.get("업무").rows.length, 2);
  assert.equal(tabs.get("변경 기록").rows.length, 3);
  const cell = options.batch[0].updateCells.rows[0].values[1].userEnteredValue;
  assert.equal(cell.stringValue, task.title);
  assert.equal(call("deleteTask", { id }).error.code, "UNKNOWN_ACTION");
});

test("invalid data, real date and allowed state validation; event fields round trip", () => {
  const { call } = fixture();
  for (const invalid of [
    { due: "2027-02-29" }, { due: "2028-04-31" }, { due: "0000-01-01" }, { status: "삭제" }, { category: "다른 분류" },
    { owner: "X".repeat(41) }, { title: " " }, { title: "X".repeat(101) }, { next: "X".repeat(301) }, { updatedBy: "spoof" },
  ]) assert.equal(call("createTask", { ...task, ...invalid }).status, 400);
  assert.equal(call("createTask", { ...task, due: "" }).ok, true);
  const event = { id: eventId, title: "일정 예시", owner: "테스트 담당", date: "2026-11-27", time: "14:30" };
  assert.equal(call("createEvent", { ...event, time: "24:00" }).status, 400);
  assert.equal(call("createEvent", event).event.date, event.date);
  assert.equal(call("updateEvent", { id: eventId, revision: 1, time: "17:00" }).event.time, "17:00");
  assert.equal(call("listEvents").events[0].revision, 2);
});

test("failed Sheets batch does not report success or strand the revision lock", () => {
  const { call, options, tabs } = fixture();
  options.working = false;
  assert.equal(call("createTask", task).error.code, "SHEET_UNAVAILABLE");
  assert.equal(tabs.get("업무").rows.length, 1);
  assert.equal(tabs.get("변경 기록").rows.length, 1);
  options.working = true;
  assert.equal(call("createTask", task).ok, true);
});

test("weekly POS summary saves counts only, updates by revision, and creates its tab for older sheets", () => {
  const { call, tabs } = fixture();
  tabs.delete("예약 요약");
  const posId = "5b0f3c2e-7a41-4c1d-9e2a-1f6b8d3c4a55";
  const summary = { id: posId, weekStart: "2026-11-16", period: "11월 16일 ~ 11월 22일", total: 23,
    byDay: "월 4 · 화 5 · 수 3 · 목 6 · 금 5 · 토 0 · 일 0", byTime: "오전 7 · 오후 12 · 저녁 4", note: "토·일 휴무", checkedAt: "2026-11-20 16:10" };
  assert.deepEqual(call("listPos").posSummaries, []);
  assert.deepEqual(tabs.get("예약 요약").rows[0], ["id", "weekStart", "period", "total", "byDay", "byTime", "note", "checkedAt", "revision", "updatedAt", "updatedBy"]);
  for (const invalid of [{ weekStart: "2026-11-31" }, { period: "" }, { total: "" }, { byDay: "X".repeat(201) }, { checkedAt: "" }, { customer: "이름" }]) {
    assert.equal(call("createPos", { ...summary, ...invalid }).status, 400);
  }
  const created = call("createPos", summary);
  assert.equal(created.pos.total, "23");
  assert.equal(call("updatePos", { id: posId, revision: 1, total: "24", checkedAt: "2026-11-20 18:00" }).pos.revision, 2);
  const listed = call("listPos").posSummaries;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].total, "24");
  assert.equal(call("listTasks").ok, true);
});

test("notices save, take down by status, and auto-create their tab", () => {
  const { call, tabs } = fixture();
  tabs.delete("공지");
  const noticeId = "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
  const notice = { id: noticeId, title: "다음 주 운영 회의", body: "월요일 10시\n안쪽 공간", owner: "재필님", date: "2026-11-20", status: "게시" };
  assert.deepEqual(call("listNotices").notices, []);
  for (const invalid of [{ status: "삭제" }, { title: "" }, { body: "X".repeat(1001) }, { date: "2026-02-30" }]) {
    assert.equal(call("createNotice", { ...notice, ...invalid }).status, 400);
  }
  assert.equal(call("createNotice", notice).notice.revision, 1);
  assert.equal(call("updateNotice", { id: noticeId, revision: 1, status: "내림" }).notice.status, "내림");
  assert.equal(call("listNotices").notices.length, 1);
  assert.equal(call("deleteNotice", { id: noticeId }).error.code, "UNKNOWN_ACTION");
});
