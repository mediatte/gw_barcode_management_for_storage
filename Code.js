/**
 * 물품 대여 시스템 - Google Apps Script
 * 실제 운영 시트(users/items/rentals) 구조에 맞춘 서버 로직
 */

const SPREADSHEET_ID = '1ObS9jdpknRQ3UtsGkIkJk2W0Jd_OfjZ1_k1AepEDS14';

const SHEET_NAME_CANDIDATES = {
  users: ['users', 'Users'],
  items: ['items', 'Items'],
  rentals: ['rentals', 'Rentals']
};

const SHEET_REQUIRED_HEADERS = {
  users: ['연번', '이름', '과목', '이메일'],
  items: ['QR코드', '물품명', '설명', '상태', '등록일', '위치'],
  rentals: ['대여ID', '사용자명', '이메일', 'QR코드', '물품명', '대여일', '반납일']
};

/**
 * 웹앱 초기 설정
 */
function doGet(e) {
  try {
    const page = e && e.parameter ? e.parameter.page || 'main' : 'main';

    if (!SPREADSHEET_ID || SPREADSHEET_ID.length < 10) {
      return HtmlService.createHtmlOutput(
        '<h1>설정 오류</h1><p>Code.js의 SPREADSHEET_ID를 확인해주세요.</p>'
      );
    }

    if (page !== 'main') {
      console.log('지원하지 않는 page 파라미터:', page);
    }

    return HtmlService.createTemplateFromFile('index')
      .evaluate()
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .setTitle('물품 대여 시스템');
  } catch (error) {
    console.error('doGet 오류:', error);
    return HtmlService.createHtmlOutput('<h1>오류</h1><p>' + error.toString() + '</p>');
  }
}

/**
 * HTML 파일 포함 함수
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * 기존 함수명 유지. 실제로는 시트 구조를 점검만 하고 수정하지 않는다.
 */
function initializeSheets() {
  return inspectSpreadsheet_();
}

/**
 * QR/바코드로 물품 정보 조회
 */
function getItemByQR(qrCode) {
  try {
    const parsedCode = extractScannedCode_(qrCode);
    if (!parsedCode.success) {
      return parsedCode;
    }

    const ss = openSpreadsheet_();
    const itemsContext = getItemsContext_(ss);
    const item = findItemByNormalizedCode_(itemsContext, parsedCode.normalizedCode);

    if (!item) {
      return buildFailureResult_(
        "QR 코드 '" + parsedCode.normalizedCode + "'에 해당하는 물품을 찾을 수 없습니다.",
        {
          normalizedCode: parsedCode.normalizedCode
        }
      );
    }

    return toClientSafe_({
      success: true,
      item: item,
      normalizedCode: parsedCode.normalizedCode
    });
  } catch (error) {
    console.error('getItemByQR 오류:', error);
    return buildFailureResult_('물품 조회 중 오류가 발생했습니다: ' + error.toString());
  }
}

/**
 * 사용자 시트는 외부 마스터 데이터이므로 저장 대신 조회만 수행한다.
 */
function saveUserInfo(userInfo) {
  try {
    if (!userInfo || (!userInfo.email && !userInfo.name)) {
      throw new Error('사용자 식별 정보가 없습니다.');
    }

    const ss = openSpreadsheet_();
    const usersContext = getUsersContext_(ss);
    const user = findUserByIdentity_(usersContext, userInfo.email || userInfo.name);

    if (!user) {
      throw new Error('users 시트에서 사용자를 찾을 수 없습니다.');
    }

    return String(user.id || user.email);
  } catch (error) {
    console.error('saveUserInfo 오류:', error);
    throw error;
  }
}

/**
 * 이름으로 사용자 정보 조회
 */
function getUserByName(userName) {
  try {
    const identity = normalizeString_(userName);
    if (!identity) {
      return buildFailureResult_('사용자명이 유효하지 않습니다.');
    }

    const ss = openSpreadsheet_();
    const usersContext = getUsersContext_(ss);
    const matches = usersContext.users.filter(function(user) {
      return normalizeString_(user.name) === identity;
    });

    if (matches.length === 0) {
      return buildFailureResult_("사용자 '" + identity + "'을(를) 찾을 수 없습니다.");
    }

    return toClientSafe_({
      success: true,
      user: matches[0],
      matches: matches.length > 1 ? matches : undefined
    });
  } catch (error) {
    console.error('getUserByName 오류:', error);
    return buildFailureResult_(error.toString());
  }
}

/**
 * 모든 사용자 목록 조회
 */
function getAllUsers() {
  try {
    const ss = openSpreadsheet_();
    const usersContext = getUsersContext_(ss);

    return toClientSafe_({
      success: true,
      users: usersContext.users
    });
  } catch (error) {
    console.error('getAllUsers 오류:', error);
    return buildFailureResult_(error.toString());
  }
}

/**
 * 대여/반납 자동 처리
 * 사용자 식별은 이메일 기준이며, 반납은 현재 미반납 건을 기준으로 누구나 처리 가능하다.
 */
function autoProcessItem(userIdentity, qrCode) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const userKey = normalizeString_(userIdentity);
    if (!userKey) {
      return buildFailureResult_('사용자를 먼저 선택해주세요.', {
        action: 'rent'
      });
    }

    const parsedCode = extractScannedCode_(qrCode);
    if (!parsedCode.success) {
      return buildFailureResult_(parsedCode.message, {
        action: 'rent'
      });
    }

    const ss = openSpreadsheet_();
    const usersContext = getUsersContext_(ss);
    const itemsContext = getItemsContext_(ss);
    const rentalsContext = getRentalsContext_(ss);

    const user = findUserByIdentity_(usersContext, userKey);
    if (!user) {
      return buildFailureResult_('users 시트에서 선택한 사용자를 찾을 수 없습니다.', {
        action: 'rent',
        normalizedCode: parsedCode.normalizedCode
      });
    }

    const item = findItemByNormalizedCode_(itemsContext, parsedCode.normalizedCode);
    if (!item) {
      return buildFailureResult_('items 시트에서 해당 QR 코드를 찾을 수 없습니다.', {
        action: 'rent',
        normalizedCode: parsedCode.normalizedCode,
        user: user
      });
    }

    const activeRental = findLatestOpenRentalByCode_(rentalsContext, parsedCode.normalizedCode);
    if (activeRental) {
      return processReturn_(itemsContext, rentalsContext, item, user, activeRental, parsedCode.normalizedCode);
    }

    return processRent_(itemsContext, rentalsContext, item, user, parsedCode.normalizedCode);
  } catch (error) {
    console.error('autoProcessItem 오류:', error);
    return buildFailureResult_('시스템 오류: ' + error.toString(), {
      action: 'rent'
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (error) {
      console.log('lock release skipped:', error);
    }
  }
}

/**
 * 대여 처리
 */
function processRent(user, item) {
  try {
    const ss = openSpreadsheet_();
    const itemsContext = getItemsContext_(ss);
    const rentalsContext = getRentalsContext_(ss);
    return processRent_(itemsContext, rentalsContext, item, user, normalizeCodeValue_(item.qrCode));
  } catch (error) {
    console.error('processRent 오류:', error);
    return buildFailureResult_('대여 처리 실패: ' + error.toString(), {
      action: 'rent'
    });
  }
}

/**
 * 반납 처리
 */
function processReturn(user, item) {
  try {
    const ss = openSpreadsheet_();
    const itemsContext = getItemsContext_(ss);
    const rentalsContext = getRentalsContext_(ss);
    const activeRental = findLatestOpenRentalByCode_(rentalsContext, normalizeCodeValue_(item.qrCode));

    if (!activeRental) {
      return buildFailureResult_('해당 물품의 미반납 대여 기록을 찾을 수 없습니다.', {
        action: 'return'
      });
    }

    return processReturn_(
      itemsContext,
      rentalsContext,
      item,
      user || {
        name: '',
        email: ''
      },
      activeRental,
      normalizeCodeValue_(item.qrCode)
    );
  } catch (error) {
    console.error('processReturn 오류:', error);
    return buildFailureResult_('반납 처리 실패: ' + error.toString(), {
      action: 'return'
    });
  }
}

/**
 * 물품 추가 (관리자용)
 */
function addItem(itemData) {
  try {
    const ss = openSpreadsheet_();
    const itemsContext = getItemsContext_(ss);
    const normalizedCode = normalizeCodeValue_(itemData && itemData.qrCode);

    if (!normalizedCode) {
      return buildFailureResult_('유효한 QR 코드가 필요합니다.');
    }

    if (findItemByNormalizedCode_(itemsContext, normalizedCode)) {
      return buildFailureResult_('이미 등록된 QR 코드입니다.', {
        normalizedCode: normalizedCode
      });
    }

    const row = new Array(itemsContext.sheet.getLastColumn()).fill('');
    row[itemsContext.indexes.qrCode] = normalizedCode;
    row[itemsContext.indexes.name] = normalizeString_(itemData && itemData.name) || normalizedCode;
    row[itemsContext.indexes.description] = normalizeString_(itemData && itemData.description);
    row[itemsContext.indexes.status] = '이용가능';
    row[itemsContext.indexes.registerDate] = new Date();
    row[itemsContext.indexes.location] = normalizeString_(itemData && itemData.location);
    itemsContext.sheet.appendRow(row);

    return toClientSafe_({
      success: true,
      message: '물품이 성공적으로 등록되었습니다.',
      normalizedCode: normalizedCode
    });
  } catch (error) {
    console.error('addItem 오류:', error);
    return buildFailureResult_(error.toString());
  }
}

/**
 * 모든 물품 목록 조회
 */
function getAllItems() {
  try {
    const ss = openSpreadsheet_();
    const itemsContext = getItemsContext_(ss);

    return toClientSafe_({
      success: true,
      items: itemsContext.items
    });
  } catch (error) {
    console.error('getAllItems 오류:', error);
    return buildFailureResult_(error.toString());
  }
}

/**
 * 대여 기록 조회
 */
function getRentalHistory() {
  try {
    const ss = openSpreadsheet_();
    const rentalsContext = getRentalsContext_(ss);

    return toClientSafe_({
      success: true,
      rentals: rentalsContext.rentals
    });
  } catch (error) {
    console.error('getRentalHistory 오류:', error);
    return buildFailureResult_(error.toString());
  }
}

/**
 * 간단 테스트
 */
function simpleTest() {
  return toClientSafe_({
    success: true,
    message: '테스트 성공',
    timestamp: new Date().toISOString()
  });
}

/**
 * 연결/시트 구성 점검
 */
function testConnection() {
  return inspectSpreadsheet_();
}

function inspectSpreadsheet_() {
  try {
    const ss = openSpreadsheet_();
    const summary = {};

    ['users', 'items', 'rentals'].forEach(function(role) {
      const sheet = getSheetByRole_(ss, role);
      const headerMap = getHeaderMap_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
      summary[role] = {
        sheetName: sheet.getName(),
        headers: getOrderedHeaders_(sheet),
        requiredHeadersPresent: SHEET_REQUIRED_HEADERS[role].every(function(label) {
          return getColumnIndex_(headerMap, [label]) !== -1;
        }),
        rowCount: Math.max(sheet.getLastRow() - 1, 0)
      };
    });

    return toClientSafe_({
      success: true,
      message: 'Google Apps Script 연결 성공',
      timestamp: new Date().toISOString(),
      spreadsheetId: SPREADSHEET_ID,
      spreadsheetName: ss.getName(),
      sheets: summary
    });
  } catch (error) {
    console.error('inspectSpreadsheet_ 오류:', error);
    return buildFailureResult_('연결 테스트 실패: ' + error.toString(), {
      timestamp: new Date().toISOString(),
      spreadsheetId: SPREADSHEET_ID
    });
  }
}

function processRent_(itemsContext, rentalsContext, item, user, normalizedCode) {
  const now = new Date();
  const rentalId = 'R' + now.getTime();

  updateItemStatus_(itemsContext, item.rowNumber, '대여중');
  appendRentalRow_(rentalsContext, {
    rentalId: rentalId,
    userName: user.name,
    email: user.email,
    qrCode: item.qrCode,
    itemName: item.name,
    rentDate: now,
    returnDate: ''
  });

  return toClientSafe_({
    success: true,
    action: 'rent',
    message: item.name + '이(가) ' + user.name + '님에게 대여되었습니다.',
    item: item,
    user: user,
    activeRental: null,
    normalizedCode: normalizedCode,
    rentalId: rentalId,
    timestamp: now.toISOString()
  });
}

function processReturn_(itemsContext, rentalsContext, item, user, activeRental, normalizedCode) {
  const now = new Date();

  updateItemStatus_(itemsContext, item.rowNumber, '이용가능');
  rentalsContext.sheet
    .getRange(activeRental.rowNumber, rentalsContext.indexes.returnDate + 1)
    .setValue(now);

  return toClientSafe_({
    success: true,
    action: 'return',
    message:
      item.name +
      '이(가) 반납되었습니다. (기존 대여자: ' +
      activeRental.userName +
      ', ' +
      activeRental.email +
      ')',
    item: item,
    user: user,
    activeRental: activeRental,
    normalizedCode: normalizedCode,
    timestamp: now.toISOString()
  });
}

function appendRentalRow_(rentalsContext, rental) {
  const row = new Array(rentalsContext.sheet.getLastColumn()).fill('');
  row[rentalsContext.indexes.rentalId] = rental.rentalId;
  row[rentalsContext.indexes.userName] = rental.userName;
  row[rentalsContext.indexes.email] = rental.email;
  row[rentalsContext.indexes.qrCode] = rental.qrCode;
  row[rentalsContext.indexes.itemName] = rental.itemName;
  row[rentalsContext.indexes.rentDate] = rental.rentDate;
  row[rentalsContext.indexes.returnDate] = rental.returnDate;
  rentalsContext.sheet.appendRow(row);
}

function updateItemStatus_(itemsContext, rowNumber, status) {
  if (itemsContext.indexes.status === -1 || rowNumber < 2) {
    return;
  }
  itemsContext.sheet.getRange(rowNumber, itemsContext.indexes.status + 1).setValue(status);
}

function findUserByIdentity_(usersContext, identity) {
  const normalizedIdentity = normalizeString_(identity).toLowerCase();
  if (!normalizedIdentity) {
    return null;
  }

  return (
    usersContext.users.find(function(user) {
      return user.email && user.email.toLowerCase() === normalizedIdentity;
    }) ||
    usersContext.users.find(function(user) {
      return normalizeString_(user.name).toLowerCase() === normalizedIdentity;
    }) ||
    null
  );
}

function findItemByNormalizedCode_(itemsContext, normalizedCode) {
  return (
    itemsContext.items.find(function(item) {
      return item.normalizedQrCode === normalizedCode;
    }) || null
  );
}

function findLatestOpenRentalByCode_(rentalsContext, normalizedCode) {
  for (var index = rentalsContext.rentals.length - 1; index >= 0; index--) {
    var rental = rentalsContext.rentals[index];
    if (rental.normalizedQrCode === normalizedCode && isEmptyValue_(rental.returnDate)) {
      return rental;
    }
  }
  return null;
}

function getUsersContext_(ss) {
  const sheet = getSheetByRole_(ss, 'users');
  const data = sheet.getDataRange().getValues();
  const headerMap = getHeaderMap_(data[0] || []);
  const indexes = {
    id: getColumnIndex_(headerMap, ['연번']),
    name: getColumnIndex_(headerMap, ['이름']),
    subject: getColumnIndex_(headerMap, ['과목']),
    email: getColumnIndex_(headerMap, ['이메일'])
  };
  assertRequiredIndexes_('users', indexes);

  const users = [];
  for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
    const row = data[rowIndex];
    const name = normalizeString_(row[indexes.name]);
    const email = normalizeString_(row[indexes.email]).toLowerCase();

    if (!name && !email) {
      continue;
    }

    users.push({
      id: row[indexes.id],
      name: name,
      subject: normalizeString_(row[indexes.subject]),
      email: email,
      label: buildUserLabel_(name, normalizeString_(row[indexes.subject]), email),
      rowNumber: rowIndex + 1
    });
  }

  return {
    sheet: sheet,
    data: data,
    headerMap: headerMap,
    indexes: indexes,
    users: users
  };
}

function getItemsContext_(ss) {
  const sheet = getSheetByRole_(ss, 'items');
  const data = sheet.getDataRange().getValues();
  const headerMap = getHeaderMap_(data[0] || []);
  const indexes = {
    qrCode: getColumnIndex_(headerMap, ['QR코드']),
    name: getColumnIndex_(headerMap, ['물품명']),
    description: getColumnIndex_(headerMap, ['설명']),
    status: getColumnIndex_(headerMap, ['상태']),
    registerDate: getColumnIndex_(headerMap, ['등록일']),
    location: getColumnIndex_(headerMap, ['위치'])
  };
  assertRequiredIndexes_('items', indexes);

  const items = [];
  for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
    const row = data[rowIndex];
    const qrCode = normalizeString_(row[indexes.qrCode]);
    const normalizedQrCode = normalizeCodeValue_(qrCode);

    if (!normalizedQrCode) {
      continue;
    }

    items.push({
      qrCode: qrCode,
      normalizedQrCode: normalizedQrCode,
      name: normalizeString_(row[indexes.name]) || qrCode,
      description: normalizeString_(row[indexes.description]),
      status: normalizeString_(row[indexes.status]) || '상태 미지정',
      registerDate: row[indexes.registerDate] || '',
      location: normalizeString_(row[indexes.location]),
      rowNumber: rowIndex + 1
    });
  }

  return {
    sheet: sheet,
    data: data,
    headerMap: headerMap,
    indexes: indexes,
    items: items
  };
}

function getRentalsContext_(ss) {
  const sheet = getSheetByRole_(ss, 'rentals');
  const data = sheet.getDataRange().getValues();
  const headerMap = getHeaderMap_(data[0] || []);
  const indexes = {
    rentalId: getColumnIndex_(headerMap, ['대여ID']),
    userName: getColumnIndex_(headerMap, ['사용자명']),
    email: getColumnIndex_(headerMap, ['이메일']),
    qrCode: getColumnIndex_(headerMap, ['QR코드']),
    itemName: getColumnIndex_(headerMap, ['물품명']),
    rentDate: getColumnIndex_(headerMap, ['대여일']),
    returnDate: getColumnIndex_(headerMap, ['반납일'])
  };
  assertRequiredIndexes_('rentals', indexes);

  const rentals = [];
  for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
    const row = data[rowIndex];
    const rentalId = normalizeString_(row[indexes.rentalId]);
    const qrCode = normalizeString_(row[indexes.qrCode]);
    const normalizedQrCode = normalizeCodeValue_(qrCode);

    if (!rentalId && !normalizedQrCode) {
      continue;
    }

    rentals.push({
      id: rentalId,
      userName: normalizeString_(row[indexes.userName]),
      email: normalizeString_(row[indexes.email]).toLowerCase(),
      qrCode: qrCode,
      normalizedQrCode: normalizedQrCode,
      itemName: normalizeString_(row[indexes.itemName]),
      rentDate: row[indexes.rentDate] || '',
      returnDate: row[indexes.returnDate] || '',
      rowNumber: rowIndex + 1
    });
  }

  return {
    sheet: sheet,
    data: data,
    headerMap: headerMap,
    indexes: indexes,
    rentals: rentals
  };
}

function extractScannedCode_(input) {
  const rawInput = normalizeString_(input);
  if (!rawInput) {
    return buildFailureResult_('QR 코드가 비어 있습니다.');
  }

  const seeds = [rawInput];
  const decodedInput = safeDecodeURIComponent_(rawInput);
  if (decodedInput !== rawInput) {
    seeds.push(decodedInput);
  }

  const candidates = [];
  const seen = {};

  function addCandidate(value) {
    const normalized = sanitizeCodeCandidate_(value);
    if (!normalized || seen[normalized]) {
      return;
    }
    seen[normalized] = true;
    candidates.push(normalized);
  }

  seeds.forEach(function(seed) {
    addCandidate(seed);

    const gwMatches = seed.match(/GW[0-9A-Z_-]+/gi) || [];
    const qrMatches = seed.match(/QR[0-9A-Z_-]+/gi) || [];
    gwMatches.forEach(addCandidate);
    qrMatches.forEach(addCandidate);

    seed
      .split(/[\s,;|/\\?&#=:()[\]{}<>]+/)
      .forEach(addCandidate);
  });

  const preferredGw = candidates.find(function(candidate) {
    return /^GW[0-9A-Z_-]+$/.test(candidate);
  });
  const preferredQr = candidates.find(function(candidate) {
    return /^QR[0-9A-Z_-]+$/.test(candidate);
  });
  const fallback = candidates.length > 0 ? candidates[candidates.length - 1] : '';
  const normalizedCode = preferredGw || preferredQr || fallback;

  if (!normalizedCode) {
    return buildFailureResult_('코드는 인식했지만 유효한 QR/바코드 값을 추출하지 못했습니다.');
  }

  return {
    success: true,
    rawInput: rawInput,
    normalizedCode: normalizedCode,
    candidates: candidates
  };
}

function sanitizeCodeCandidate_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  let text = safeDecodeURIComponent_(String(value)).trim();
  if (!text) {
    return '';
  }

  if (/^https?:\/\//i.test(text)) {
    return '';
  }

  text = text
    .replace(/^[\s"'`[\](){}<>,;:]+|[\s"'`[\](){}<>,;:]+$/g, '')
    .replace(/\s+/g, '')
    .replace(/[?&#].*$/, '')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9_-]+$/g, '');

  if (!text || !/[A-Za-z0-9]/.test(text)) {
    return '';
  }

  return text.toUpperCase();
}

function safeDecodeURIComponent_(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function openSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSheetByRole_(ss, role) {
  const candidates = SHEET_NAME_CANDIDATES[role] || [role];
  const directMatch = getSheetByCandidates_(ss, candidates);
  if (directMatch) {
    return directMatch;
  }

  const normalizedCandidates = candidates.map(function(name) {
    return name.toLowerCase();
  });

  const fallback = ss.getSheets().find(function(sheet) {
    return normalizedCandidates.indexOf(sheet.getName().toLowerCase()) !== -1;
  });

  if (!fallback) {
    throw new Error(role + ' 시트를 찾을 수 없습니다.');
  }

  return fallback;
}

function getSheetByCandidates_(ss, names) {
  for (let index = 0; index < names.length; index++) {
    const sheet = ss.getSheetByName(names[index]);
    if (sheet) {
      return sheet;
    }
  }
  return null;
}

function getHeaderMap_(headerRow) {
  const map = {};
  headerRow.forEach(function(header, index) {
    const key = normalizeHeader_(header);
    if (key && map[key] === undefined) {
      map[key] = index;
    }
  });
  return map;
}

function getOrderedHeaders_(sheet) {
  if (sheet.getLastColumn() === 0) {
    return [];
  }

  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(value) {
    return normalizeString_(value);
  });
}

function getColumnIndex_(headerMap, labels) {
  for (let index = 0; index < labels.length; index++) {
    const key = normalizeHeader_(labels[index]);
    if (headerMap[key] !== undefined) {
      return headerMap[key];
    }
  }
  return -1;
}

function normalizeHeader_(value) {
  return normalizeString_(value).replace(/\s+/g, '').toLowerCase();
}

function assertRequiredIndexes_(role, indexes) {
  const missing = Object.keys(indexes).filter(function(key) {
    return indexes[key] === -1;
  });

  if (missing.length > 0) {
    throw new Error(role + ' 시트의 필수 컬럼이 없습니다: ' + missing.join(', '));
  }
}

function buildUserLabel_(name, subject, email) {
  const parts = [];
  if (subject) {
    parts.push(subject);
  }
  if (email) {
    parts.push(email);
  }
  return parts.length > 0 ? name + ' (' + parts.join(', ') + ')' : name;
}

function buildFailureResult_(message, extra) {
  return toClientSafe_(
    Object.assign(
      {
        success: false,
        message: message
      },
      extra || {}
    )
  );
}

function toClientSafe_(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(function(item) {
      return toClientSafe_(item);
    });
  }

  if (typeof value === 'object') {
    const result = {};
    Object.keys(value).forEach(function(key) {
      const converted = toClientSafe_(value[key]);
      if (converted !== undefined) {
        result[key] = converted;
      }
    });
    return result;
  }

  if (typeof value === 'function') {
    return undefined;
  }

  return value;
}

function normalizeString_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeCodeValue_(value) {
  return sanitizeCodeCandidate_(value);
}

function isEmptyValue_(value) {
  if (value === null || value === undefined) {
    return true;
  }
  if (value instanceof Date) {
    return false;
  }
  return String(value).trim() === '';
}
